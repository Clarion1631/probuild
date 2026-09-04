/**
 * TWO REAL CONNECTIONS, contending over a TARGET's role while a manager's
 * mutation is in flight.
 *
 * The hole (round 12, finding 2). PUT/PATCH /api/users/[id], PATCH
 * /api/users and PATCH /api/manager/employees/[id] all authorized against a
 * `User.role` read taken BEFORE the write transaction opened, then wrote
 * without checking again. An admin promotion committing in that gap let a
 * manager's already-in-flight request — authorized against a crew member —
 * act on the now-admin account: disable it, grant it permissions, or delete
 * it, because the row the request was authorized against was not the row it
 * wrote.
 *
 * withGuardedUserMutation (src/lib/user-mutation-guard.ts) closes this by
 * taking `SELECT ... FOR UPDATE` on the target row and re-running
 * checkUserMutation against what that lock ACTUALLY holds, inside the SAME
 * transaction as the write. Proven here against a real PostgreSQL, not a
 * fake: an injected sequence shows the branch exists, not that PostgreSQL
 * serializes the two transactions the way the code assumes.
 *
 * Each of the three writes (status, permissions, delete) gets:
 *   - a BLOCKING proof: the guarded write genuinely waits on the row lock
 *     while a promotion is mid-transaction, not just "checks a boolean";
 *   - a REFUSAL proof: once the promotion commits, the guarded write is
 *     refused and nothing it would have written landed;
 *   - an ADMIN CONTROL: the identical race, but the actor is an admin, so it
 *     succeeds anyway — without this, "everything is refused" could be a
 *     guard that simply never lets anything through;
 *   - a PRE-FIX CONTROL, written out in the exact vulnerable shape the three
 *     routes used to share (read role, decide, write — no lock, no
 *     re-check), proving the SAME race wrongly succeeds against that code.
 *
 * tests/user-mutation-escalation.test.ts proves every route actually calls
 * withGuardedUserMutation; this file proves the mechanism itself holds
 * PostgreSQL to the promise.
 *
 * Opt-in by URL, like every other DB test here.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";

const databaseUrl = process.env.PAYROLL_LOCK_TEST_URL;
const skip = !databaseUrl && "set PAYROLL_LOCK_TEST_URL to a disposable PostgreSQL URL";

/** Resolves true once `promise` has not settled for `ms` — i.e. it is genuinely blocked. */
function stillPending(promise: Promise<unknown>, ms: number): Promise<boolean> {
    const marker = Symbol("pending");
    return Promise.race([
        promise.then(() => false),
        new Promise((resolve) => setTimeout(() => resolve(marker), ms)).then((v) => v === marker),
    ]) as Promise<boolean>;
}

type Actor = { id: string; role: string };

async function seed(db: PrismaClient, suffix: string) {
    const managerEmail = `race-manager-${suffix}@example.test`;
    const adminEmail = `race-admin-${suffix}@example.test`;
    const targetEmail = `race-target-${suffix}@example.test`;
    await db.user.deleteMany({ where: { email: { in: [managerEmail, adminEmail, targetEmail] } } });

    const manager = await db.user.create({
        data: { name: "Race Manager", email: managerEmail, role: "MANAGER", status: "ACTIVATED" },
        select: { id: true, role: true },
    });
    const admin = await db.user.create({
        data: { name: "Race Admin", email: adminEmail, role: "ADMIN", status: "ACTIVATED" },
        select: { id: true, role: true },
    });
    const target = await db.user.create({
        data: { name: "Race Target", email: targetEmail, role: "FIELD_CREW", status: "ACTIVATED" },
        select: { id: true, role: true },
    });

    return {
        manager: manager as Actor,
        admin: admin as Actor,
        target: target as Actor,
        restore: async () => {
            await db.userPermission.deleteMany({ where: { userId: target.id } }).catch(() => {});
            await db.user.deleteMany({ where: { email: { in: [managerEmail, adminEmail, targetEmail] } } }).catch(() => {});
        },
    };
}

/** Promote the target to ADMIN on `db`, staged so the caller controls exactly when it commits. */
function stagePromotion(db: PrismaClient, targetId: string) {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
        release = resolve;
    });
    const promoting = db.$transaction(
        async (tx) => {
            await tx.user.update({ where: { id: targetId }, data: { role: "ADMIN" } });
            await held;
        },
        { timeout: 30_000 }
    );
    return { promoting, release };
}

// ── the guarded mechanism: blocks, then correctly refuses ──────────────────

test("STATUS: a promotion committing mid-flight blocks, then refuses a manager's write — nothing changes", { skip }, async () => {
    const promoter = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const writer = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const { withGuardedUserMutation, isUserMutationRefusedError } = await import("../src/lib/user-mutation-guard");
    const { manager, target, restore } = await seed(promoter, "status");

    // Declared here, not inside try — so the `finally` below can ALWAYS
    // release the staged promotion and drain both promises, even if an
    // assertion throws before reaching the lines that normally do it. Without
    // this, a failed assertion mid-test leaves the promoter's transaction
    // parked on `await held` forever, which leaks a real Postgres backend
    // holding the row lock and can hang every later test.
    let release: () => void = () => {};
    let promoting: Promise<unknown> = Promise.resolve();
    let write: Promise<unknown> = Promise.resolve();
    try {
        ({ promoting, release } = stagePromotion(promoter, target.id));
        await new Promise((resolve) => setTimeout(resolve, 400));

        write = writer.$transaction(async (tx) => {
            return withGuardedUserMutation(
                tx,
                { actorId: manager.id, targetId: target.id, changes: { status: "DISABLED" } },
                async () => {
                    await tx.user.update({ where: { id: target.id }, data: { status: "DISABLED" } });
                }
            );
        });
        assert.equal(
            await stillPending(write, 1_000),
            true,
            "the row lock must genuinely block the guarded write until the promotion commits"
        );

        release();
        await promoting;

        await assert.rejects(write, (error: unknown) => {
            assert.ok(isUserMutationRefusedError(error), "must refuse — the row it locked is now ADMIN");
            assert.equal((error as { verdict: { status: number } }).verdict.status, 403);
            return true;
        });

        const after = await promoter.user.findUnique({ where: { id: target.id }, select: { role: true, status: true } });
        assert.equal(after?.role, "ADMIN");
        assert.equal(after?.status, "ACTIVATED", "the status write must NOT have landed");
    } finally {
        release();
        await promoting.catch(() => {});
        await write.catch(() => {});
        await restore();
        await promoter.$disconnect().catch(() => {});
        await writer.$disconnect().catch(() => {});
    }
});

test("DELETE: a promotion committing mid-flight blocks, then refuses a manager's delete — the row survives", { skip }, async () => {
    const promoter = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const writer = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const { withGuardedUserMutation, isUserMutationRefusedError } = await import("../src/lib/user-mutation-guard");
    const { manager, target, restore } = await seed(promoter, "delete");

    let release: () => void = () => {};
    let promoting: Promise<unknown> = Promise.resolve();
    let write: Promise<unknown> = Promise.resolve();
    try {
        ({ promoting, release } = stagePromotion(promoter, target.id));
        await new Promise((resolve) => setTimeout(resolve, 400));

        write = writer.$transaction(async (tx) => {
            return withGuardedUserMutation(tx, { actorId: manager.id, targetId: target.id, changes: {} }, async () => {
                await tx.user.delete({ where: { id: target.id } });
            });
        });
        assert.equal(await stillPending(write, 1_000), true, "the delete must block on the same row lock");

        release();
        await promoting;

        await assert.rejects(write, (error: unknown) => {
            assert.ok(isUserMutationRefusedError(error), "must refuse the delete — the row it locked is now ADMIN");
            assert.equal((error as { verdict: { status: number } }).verdict.status, 403);
            return true;
        });

        const after = await promoter.user.findUnique({ where: { id: target.id }, select: { role: true } });
        assert.equal(after?.role, "ADMIN", "the row must still exist — a manager never got to delete an admin account");
    } finally {
        release();
        await promoting.catch(() => {});
        await write.catch(() => {});
        await restore();
        await promoter.$disconnect().catch(() => {});
        await writer.$disconnect().catch(() => {});
    }
});

test("PERMISSIONS: a promotion committing mid-flight blocks, then refuses a manager's grant — no permission row is written", { skip }, async () => {
    const promoter = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const writer = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const { withGuardedUserMutation, isUserMutationRefusedError } = await import("../src/lib/user-mutation-guard");
    const { manager, target, restore } = await seed(promoter, "perm");

    let release: () => void = () => {};
    let promoting: Promise<unknown> = Promise.resolve();
    let write: Promise<unknown> = Promise.resolve();
    try {
        ({ promoting, release } = stagePromotion(promoter, target.id));
        await new Promise((resolve) => setTimeout(resolve, 400));

        write = writer.$transaction(async (tx) => {
            return withGuardedUserMutation(
                tx,
                { actorId: manager.id, targetId: target.id, changes: { permissions: { schedules: true } } },
                async () => {
                    await tx.userPermission.upsert({
                        where: { userId: target.id },
                        create: { userId: target.id, schedules: true },
                        update: { schedules: true },
                    });
                }
            );
        });
        assert.equal(await stillPending(write, 1_000), true, "the permission write must block on the same row lock");

        release();
        await promoting;

        await assert.rejects(write, (error: unknown) => {
            assert.ok(isUserMutationRefusedError(error), "must refuse — the target it locked is now ADMIN");
            assert.equal((error as { verdict: { status: number } }).verdict.status, 403);
            return true;
        });

        const permission = await promoter.userPermission.findUnique({ where: { userId: target.id } });
        assert.equal(permission, null, "no permission row must exist — the refused write left nothing behind");
    } finally {
        release();
        await promoting.catch(() => {});
        await write.catch(() => {});
        await restore();
        await promoter.$disconnect().catch(() => {});
        await writer.$disconnect().catch(() => {});
    }
});

// ── ADMIN CONTROL: the identical race, but the actor may touch an admin ────
// Without this, every refusal above could just as well be a guard that always
// says no.

test("ADMIN CONTROL: the identical race succeeds when the actor is an admin", { skip }, async () => {
    const promoter = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const writer = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const { withGuardedUserMutation } = await import("../src/lib/user-mutation-guard");
    const { admin, target, restore } = await seed(promoter, "admin-control");

    let release: () => void = () => {};
    let promoting: Promise<unknown> = Promise.resolve();
    let write: Promise<unknown> = Promise.resolve();
    try {
        ({ promoting, release } = stagePromotion(promoter, target.id));
        await new Promise((resolve) => setTimeout(resolve, 400));

        write = writer.$transaction(async (tx) => {
            return withGuardedUserMutation(
                tx,
                { actorId: admin.id, targetId: target.id, changes: { status: "DISABLED" } },
                async () => {
                    await tx.user.update({ where: { id: target.id }, data: { status: "DISABLED" } });
                }
            );
        });
        assert.equal(await stillPending(write, 1_000), true, "an admin's write still waits for the row lock");

        release();
        await promoting;
        await write;

        const after = await promoter.user.findUnique({ where: { id: target.id }, select: { role: true, status: true } });
        assert.equal(after?.role, "ADMIN");
        assert.equal(after?.status, "DISABLED", "an ADMIN actor may act on the now-admin account — the guard is about authority, not a blanket refusal");
    } finally {
        release();
        await promoting.catch(() => {});
        await write.catch(() => {});
        await restore();
        await promoter.$disconnect().catch(() => {});
        await writer.$disconnect().catch(() => {});
    }
});

// ── PRE-FIX CONTROL: the exact vulnerable ordering, wrongly succeeding ─────
// Written out here in the shape all three routes used to share — read the
// role, decide with checkUserMutation, then write, with no lock and no
// re-check — so the SAME race can be shown to wrongly succeed against it.
// This is the failure story the fix closes, reproduced verbatim.

async function preFixRace(
    promoter: PrismaClient,
    writer: PrismaClient,
    actor: Actor,
    targetId: string,
    changes: Parameters<typeof import("../src/lib/user-mutation-guard").checkUserMutation>[0]["changes"],
    finalWrite: () => Promise<void>
) {
    const { checkUserMutation } = await import("../src/lib/user-mutation-guard");
    // 1. Authorize on the role as it stood at the START of the request —
    //    exactly what PUT/PATCH /api/users/[id], PATCH /api/users and PATCH
    //    /api/manager/employees/[id] did before round 12.
    const before = await writer.user.findUnique({ where: { id: targetId }, select: { role: true } });
    const verdict = checkUserMutation({ actor, target: { id: targetId, role: before!.role }, changes });
    assert.equal(verdict.ok, true, "authorized against a crew member, as the manager should be at this point");

    // 2. THE RACE: an admin promotion commits in the gap between that
    //    authorization and the write below — nothing in the vulnerable code
    //    holds this off, because it never re-reads the row.
    await promoter.user.update({ where: { id: targetId }, data: { role: "ADMIN" } });

    // 3. The vulnerable write: no re-check, no lock — it just trusts step 1.
    await finalWrite();
}

test("PRE-FIX CONTROL: the old ordering wrongly disables the now-admin account", { skip }, async () => {
    const promoter = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const writer = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const { manager, target, restore } = await seed(promoter, "prefix-status");

    try {
        await preFixRace(promoter, writer, manager, target.id, { status: "DISABLED" }, async () => {
            await writer.user.update({ where: { id: target.id }, data: { status: "DISABLED" } });
        });

        // THE BUG, reproduced: a manager's request, authorized against a crew
        // member, just disabled what is now an admin account.
        const after = await promoter.user.findUnique({ where: { id: target.id }, select: { role: true, status: true } });
        assert.equal(after?.role, "ADMIN");
        assert.equal(
            after?.status,
            "DISABLED",
            "the pre-fix ordering wrongly succeeds — this is exactly the hole withGuardedUserMutation closes"
        );
    } finally {
        await restore();
        await promoter.$disconnect().catch(() => {});
        await writer.$disconnect().catch(() => {});
    }
});

test("PRE-FIX CONTROL: the old ordering wrongly deletes the now-admin account", { skip }, async () => {
    const promoter = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const writer = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const { manager, target, restore } = await seed(promoter, "prefix-delete");

    try {
        await preFixRace(promoter, writer, manager, target.id, {}, async () => {
            await writer.user.delete({ where: { id: target.id } });
        });

        const after = await promoter.user.findUnique({ where: { id: target.id }, select: { role: true } });
        assert.equal(
            after,
            null,
            "the pre-fix ordering wrongly succeeds — a manager just deleted what is now an admin account"
        );
    } finally {
        await restore();
        await promoter.$disconnect().catch(() => {});
        await writer.$disconnect().catch(() => {});
    }
});

test("PRE-FIX CONTROL: the old ordering wrongly grants a permission on the now-admin account", { skip }, async () => {
    const promoter = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const writer = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const { manager, target, restore } = await seed(promoter, "prefix-perm");

    try {
        await preFixRace(
            promoter,
            writer,
            manager,
            target.id,
            { permissions: { schedules: true } },
            async () => {
                await writer.userPermission.upsert({
                    where: { userId: target.id },
                    create: { userId: target.id, schedules: true },
                    update: { schedules: true },
                });
            }
        );

        const permission = await promoter.userPermission.findUnique({ where: { userId: target.id } });
        assert.equal(
            permission?.schedules,
            true,
            "the pre-fix ordering wrongly succeeds — a manager just wrote a permission onto what is now an admin account"
        );
    } finally {
        await restore();
        await promoter.$disconnect().catch(() => {});
        await writer.$disconnect().catch(() => {});
    }
});
