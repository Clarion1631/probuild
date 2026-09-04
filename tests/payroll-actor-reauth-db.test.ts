/**
 * TWO REAL CONNECTIONS, contending over the PAYROLL ACTOR's own authority while
 * their payroll write is in flight.
 *
 * Round 14 closed this for the team editor: withGuardedUserMutation locks and
 * re-reads the actor inside the transaction. The PAYROLL actions were a second
 * family of writers that never got the same treatment (round 21, P1). Every one
 * of them read
 *
 *   requirePayrollAccess()            -> ADMIN / financialReports, ACTIVATED
 *
 * and only THEN opened a transaction — which then waits. On the shared payroll
 * advisory lock, on the EXCLUSIVE one behind every in-flight hours writer, on
 * one User FOR UPDATE per imported member, and in the settle button's case on a
 * whole loop of one transaction per deferred day. Anything that revoked the
 * caller's access inside that window changed nothing about the write:
 *
 *   action    SELECT the caller -> MANAGER / FINANCE with financialReports
 *   someone   disable / demote / revoke, and COMMIT
 *   action    take the payroll lock, take the row locks, write
 *
 * requireFinancialActorInTx (src/lib/user-mutation-guard.ts) now locks the
 * actor's row FOR SHARE inside the transaction — together with the rows the
 * write will take, in one ascending-id sequence — and re-runs
 * `canActOnFinancials` on what the lock holds.
 *
 * This file proves PostgreSQL serializes it the way the code assumes. An
 * injected sequence would only show the branch exists. The SOURCE half — that
 * every payroll writer calls it, in the right place — is
 * tests/payroll-actor-reauth-manifest.test.ts.
 *
 * Opt-in by URL, like every other DB test here. Its own PrismaClient, never the
 * singleton: this suite must never be able to touch a developer database.
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
        promise.then(
            () => false,
            () => false
        ),
        new Promise((resolve) => setTimeout(() => resolve(marker), ms)).then((v) => v === marker),
    ]) as Promise<boolean>;
}

async function seed(
    db: PrismaClient,
    suffix: string,
    actor: { role: string; financialReports?: boolean } = { role: "MANAGER", financialReports: true }
) {
    const actorEmail = `payroll-actor-${suffix}@example.test`;
    const targetEmail = `payroll-target-${suffix}@example.test`;
    await db.userPermission.deleteMany({ where: { user: { email: { in: [actorEmail, targetEmail] } } } }).catch(() => {});
    await db.user.deleteMany({ where: { email: { in: [actorEmail, targetEmail] } } });

    const actorRow = await db.user.create({
        data: { name: "Payroll Actor", email: actorEmail, role: actor.role, status: "ACTIVATED" },
        select: { id: true },
    });
    await db.userPermission.create({
        data: { userId: actorRow.id, financialReports: actor.financialReports ?? true },
    });

    const target = await db.user.create({
        data: {
            name: "Payroll Target",
            email: targetEmail,
            role: "FIELD_CREW",
            status: "ACTIVATED",
            payType: "HOURLY",
            hourlyRate: 20,
        },
        select: { id: true },
    });

    return {
        actor: actorRow,
        target,
        restore: async () => {
            await db.userPermission.deleteMany({ where: { userId: { in: [actorRow.id, target.id] } } }).catch(() => {});
            await db.user.deleteMany({ where: { email: { in: [actorEmail, targetEmail] } } }).catch(() => {});
        },
    };
}

/**
 * A change to the ACTOR's own authority, staged so the caller decides exactly
 * when it commits — `patch` is what a concurrent admin is doing to them. The
 * FOR UPDATE it takes first is the same one every real user mutation takes
 * through withGuardedUserMutation, so this IS that write seen from the other
 * side.
 */
function stageActorChange(
    db: PrismaClient,
    actorId: string,
    patch: { user?: Record<string, unknown>; permissions?: Record<string, unknown> }
) {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
        release = resolve;
    });
    const running = db.$transaction(
        async (tx) => {
            await tx.$queryRawUnsafe(`SELECT "id" FROM "User" WHERE "id" = $1 FOR UPDATE`, actorId);
            if (patch.user) await tx.user.update({ where: { id: actorId }, data: patch.user });
            if (patch.permissions) {
                await tx.userPermission.update({ where: { userId: actorId }, data: patch.permissions });
            }
            await held;
        },
        { timeout: 30_000 }
    );
    return { running, release };
}

/**
 * setUserPayType's transaction, verbatim: the shared payroll advisory lock
 * (tier 1), the guarded actor + target row locks (tier 2), the write.
 *
 * Written out here rather than imported, because importing src/lib/actions.ts
 * would drag in next/cache, next-auth and the prisma SINGLETON — and the
 * singleton is the one client this suite must never use. The manifest test
 * (tests/payroll-actor-reauth-manifest.test.ts) is what holds this mirror to
 * the real action's shape.
 */
async function payrollPayTypeWrite(db: PrismaClient, actorId: string, targetId: string, payType: string) {
    const { acquirePayrollWriteLock } = await import("../src/lib/payroll-period");
    const { requireFinancialActorInTx } = await import("../src/lib/user-mutation-guard");
    const { payrollEligibleUserWhere } = await import("../src/lib/payroll-config");
    return db.$transaction(
        async (tx) => {
            await acquirePayrollWriteLock(tx as never);
            await requireFinancialActorInTx(tx as never, actorId, {
                alsoLock: [{ id: targetId, mode: "FOR UPDATE" }],
            });
            return tx.user.updateMany({
                where: { AND: [payrollEligibleUserWhere(), { id: targetId, status: { not: "DISABLED" } }] },
                data: { payType, payrollRevision: { increment: 1 } },
            });
        },
        { timeout: 30_000 }
    );
}

/** discardPayrollPeriod / unlockPayrollPeriod's shape: the EXCLUSIVE lock, then ADMIN under it. */
async function adminOnlyPeriodWrite(db: PrismaClient, actorId: string) {
    const { acquirePayrollLockCreationLock } = await import("../src/lib/payroll-period");
    const { requireFinancialActorInTx } = await import("../src/lib/user-mutation-guard");
    return db.$transaction(
        async (tx) => {
            await acquirePayrollLockCreationLock(tx as never);
            return requireFinancialActorInTx(tx as never, actorId, { requireAdmin: true });
        },
        { timeout: 30_000 }
    );
}

async function refusal(promise: Promise<unknown>): Promise<{ status?: number; message: string }> {
    const { isUserMutationActorInvalidError, isUserMutationRefusedError } = await import(
        "../src/lib/user-mutation-guard"
    );
    try {
        await promise;
        return { message: "__IT SUCCEEDED__" };
    } catch (error) {
        if (isUserMutationActorInvalidError(error) || isUserMutationRefusedError(error)) {
            return { status: error.verdict.status, message: error.verdict.error };
        }
        return { message: String((error as Error).message ?? error) };
    }
}

async function payTypeOf(db: PrismaClient, id: string): Promise<string | null> {
    const row = await db.user.findUnique({ where: { id }, select: { payType: true } });
    return row?.payType ?? null;
}

// ── the actor is disabled mid-flight ──────────────────────────────────────

test("DISABLED mid-flight: the payroll write BLOCKS on the actor's row, then is refused", { skip }, async () => {
    const changer = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const writer = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const { actor, target, restore } = await seed(changer, "disable");
    try {
        const staged = stageActorChange(changer, actor.id, { user: { status: "DISABLED" } });
        await new Promise((resolve) => setTimeout(resolve, 200));

        const write = payrollPayTypeWrite(writer, actor.id, target.id, "SALARY");
        // It genuinely waits on the actor's row lock. Before the fix the
        // payroll actions never touched that row at all and went straight
        // through.
        assert.equal(await stillPending(write, 700), true, "the payroll write must wait on the actor's row");

        staged.release();
        await staged.running;

        const verdict = await refusal(write);
        assert.equal(verdict.status, 403, verdict.message);
        assert.match(verdict.message, /disabled/i);
        assert.equal(await payTypeOf(changer, target.id), "HOURLY", "a refusal is not a partial write");
    } finally {
        await restore();
        await Promise.all([changer.$disconnect(), writer.$disconnect()]);
    }
});

test("PENDING mid-flight: refused — 'not disabled' is not the same as 'activated'", { skip }, async () => {
    // PENDING is what an admin revoking access by resetting somebody produces,
    // and what every create in this app produces. canActOnFinancials is
    // POSITIVE about status for exactly this reason.
    const changer = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const writer = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const { actor, target, restore } = await seed(changer, "pending");
    try {
        const staged = stageActorChange(changer, actor.id, { user: { status: "PENDING" } });
        await new Promise((resolve) => setTimeout(resolve, 200));

        const write = payrollPayTypeWrite(writer, actor.id, target.id, "SALARY");
        assert.equal(await stillPending(write, 700), true);
        staged.release();
        await staged.running;

        const verdict = await refusal(write);
        assert.equal(verdict.status, 403, verdict.message);
        assert.match(verdict.message, /not activated/i);
        assert.equal(await payTypeOf(changer, target.id), "HOURLY");
    } finally {
        await restore();
        await Promise.all([changer.$disconnect(), writer.$disconnect()]);
    }
});

// ── demotion out of the staff set ─────────────────────────────────────────

test("DEMOTED to CLIENT mid-flight: refused — a customer is not a payroll actor", { skip }, async () => {
    // The staff half of canActOnFinancials. `financialReports` is an assignable
    // permission, so the role check is what keeps a portal account off this
    // surface (round 15, finding 1) — and it has to be re-asked, because a
    // demotion can land after the door check.
    const changer = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const writer = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const { actor, target, restore } = await seed(changer, "client");
    try {
        const staged = stageActorChange(changer, actor.id, { user: { role: "CLIENT" } });
        await new Promise((resolve) => setTimeout(resolve, 200));

        const write = payrollPayTypeWrite(writer, actor.id, target.id, "SALARY");
        assert.equal(await stillPending(write, 700), true);
        staged.release();
        await staged.running;

        const verdict = await refusal(write);
        assert.equal(verdict.status, 403, verdict.message);
        assert.match(verdict.message, /no longer has payroll access/i);
        assert.equal(await payTypeOf(changer, target.id), "HOURLY");
    } finally {
        await restore();
        await Promise.all([changer.$disconnect(), writer.$disconnect()]);
    }
});

// ── the permission itself ─────────────────────────────────────────────────

test("financialReports REVOKED mid-flight: refused", { skip }, async () => {
    // A FINANCE actor, deliberately: hasPermission returns true for ADMIN and
    // MANAGER unconditionally (src/lib/access-rules.ts — "managers have full
    // access app-wide"), so revoking the permission from a manager would test
    // nothing at all. FINANCE is the role for which the permission is the whole
    // grant.
    const changer = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const writer = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const { actor, target, restore } = await seed(changer, "revoke", { role: "FINANCE", financialReports: true });
    try {
        // The control, first: this actor CAN write before the revocation.
        const before = await payrollPayTypeWrite(writer, actor.id, target.id, "SALARY");
        assert.equal(before.count, 1, "a FINANCE actor with financialReports is a payroll actor");
        await changer.user.update({ where: { id: target.id }, data: { payType: "HOURLY" } });

        const staged = stageActorChange(changer, actor.id, { permissions: { financialReports: false } });
        await new Promise((resolve) => setTimeout(resolve, 200));

        const write = payrollPayTypeWrite(writer, actor.id, target.id, "SALARY");
        assert.equal(await stillPending(write, 700), true, "the write must wait on the actor's row");
        staged.release();
        await staged.running;

        const verdict = await refusal(write);
        assert.equal(verdict.status, 403, verdict.message);
        assert.match(verdict.message, /no longer has payroll access/i);
        assert.equal(await payTypeOf(changer, target.id), "HOURLY", "the pay type must be untouched");
    } finally {
        await restore();
        await Promise.all([changer.$disconnect(), writer.$disconnect()]);
    }
});

// ── the control ───────────────────────────────────────────────────────────

test("CONTROL: an undisturbed actor still commits the payroll write", { skip }, async () => {
    // Without this every refusal above could be a path that never works.
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const { actor, target, restore } = await seed(db, "control");
    try {
        const result = await payrollPayTypeWrite(db, actor.id, target.id, "SALARY");
        assert.equal(result.count, 1);
        assert.equal(await payTypeOf(db, target.id), "SALARY");
    } finally {
        await restore();
        await db.$disconnect();
    }
});

// ── the ADMIN-only period actions ─────────────────────────────────────────

test("requireAdmin: a MANAGER who passes canActOnFinancials is still refused", { skip }, async () => {
    // discardPayrollPeriod and unlockPayrollPeriod are ADMIN-only at the door.
    // canActOnFinancials admits a MANAGER, so re-checking only that would be
    // WEAKER than the check it replaces — and a weaker guard that reads like a
    // guard is worse than none.
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const manager = await seed(db, "admin-manager", { role: "MANAGER" });
    const admin = await seed(db, "admin-admin", { role: "ADMIN" });
    try {
        const verdict = await refusal(adminOnlyPeriodWrite(db, manager.actor.id));
        assert.equal(verdict.status, 403, verdict.message);
        assert.match(verdict.message, /only an admin/i);

        // The control: an ADMIN passes the same call.
        const allowed = await adminOnlyPeriodWrite(db, admin.actor.id);
        assert.equal(allowed.role, "ADMIN");
        assert.equal(allowed.status, "ACTIVATED");
    } finally {
        await manager.restore();
        await admin.restore();
        await db.$disconnect();
    }
});

test("requireAdmin: an ADMIN demoted mid-flight is refused", { skip }, async () => {
    const changer = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const writer = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const { actor, restore } = await seed(changer, "admin-demote", { role: "ADMIN" });
    try {
        const staged = stageActorChange(changer, actor.id, { user: { role: "MANAGER" } });
        await new Promise((resolve) => setTimeout(resolve, 200));

        const write = adminOnlyPeriodWrite(writer, actor.id);
        assert.equal(await stillPending(write, 700), true, "the unlock must wait on the actor's row");
        staged.release();
        await staged.running;

        const verdict = await refusal(write);
        assert.equal(verdict.status, 403, verdict.message);
        assert.match(verdict.message, /only an admin/i);
    } finally {
        await restore();
        await Promise.all([changer.$disconnect(), writer.$disconnect()]);
    }
});

// ── the pre-fix control ───────────────────────────────────────────────────

test("PRE-FIX CONTROL: authorizing on the pre-read actor wrongly succeeds", { skip }, async () => {
    // The old shape, written out: read the caller BEFORE the transaction,
    // decide, then take the payroll lock and the target row and write. Without
    // this the refusals above could be passing on a race that was never
    // winnable.
    const changer = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const writer = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const { actor, target, restore } = await seed(changer, "prefix", { role: "FINANCE", financialReports: true });
    try {
        const { canActOnFinancials } = await import("../src/lib/financial-access");
        const { acquirePayrollWriteLock } = await import("../src/lib/payroll-period");
        const { lockOwnerRowForUpdate } = await import("../src/lib/pay-rate-guard");

        // 1. requirePayrollAccess()'s read, before any transaction opens.
        const preRead = await writer.user.findUnique({
            where: { id: actor.id },
            select: { id: true, role: true, status: true, permissions: true },
        });
        assert.equal(canActOnFinancials(preRead), true, "the caller was a payroll actor when the door check ran");

        // 2. The revocation commits, in full, before the write even opens.
        const staged = stageActorChange(changer, actor.id, { permissions: { financialReports: false } });
        staged.release();
        await staged.running;

        // 3. The write proceeds on the stale authority — the exact code the
        //    payroll actions used to run.
        await writer.$transaction(async (tx) => {
            await acquirePayrollWriteLock(tx as never);
            await lockOwnerRowForUpdate(tx as never, target.id);
            await tx.user.updateMany({
                where: { id: target.id },
                data: { payType: "SALARY", payrollRevision: { increment: 1 } },
            });
        });
        assert.equal(
            await payTypeOf(changer, target.id),
            "SALARY",
            "an actor with no payroll access set a pay type — the hole, verbatim"
        );

        // 4. And the guarded write refuses the very same thing.
        await changer.user.update({ where: { id: target.id }, data: { payType: "HOURLY" } });
        const guarded = await refusal(payrollPayTypeWrite(writer, actor.id, target.id, "SALARY"));
        assert.equal(guarded.status, 403, guarded.message);
        assert.equal(await payTypeOf(changer, target.id), "HOURLY");
    } finally {
        await restore();
        await Promise.all([changer.$disconnect(), writer.$disconnect()]);
    }
});

// ── deadlock freedom ──────────────────────────────────────────────────────

test("two payroll writes that are each other's actor and target do not deadlock", { skip }, async () => {
    // Both transactions need the same two User rows. Every payroll path now
    // takes them through ONE ordered locker (lockUserRowsAscending), so
    // whichever starts first holds the lower id and the other queues. Taking
    // "actor then target" would have given the two transactions opposite orders
    // and closed a cycle.
    const a = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const b = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const emails = ["payroll-pair-1@example.test", "payroll-pair-2@example.test"];
    await a.userPermission.deleteMany({ where: { user: { email: { in: emails } } } }).catch(() => {});
    await a.user.deleteMany({ where: { email: { in: emails } } });
    const one = await a.user.create({
        data: { name: "Pair One", email: emails[0], role: "ADMIN", status: "ACTIVATED", payType: "HOURLY" },
        select: { id: true },
    });
    const two = await a.user.create({
        data: { name: "Pair Two", email: emails[1], role: "ADMIN", status: "ACTIVATED", payType: "HOURLY" },
        select: { id: true },
    });
    try {
        const results = await Promise.allSettled([
            payrollPayTypeWrite(a, one.id, two.id, "SALARY"),
            payrollPayTypeWrite(b, two.id, one.id, "SALARY"),
        ]);
        const messages = results
            .filter((r): r is PromiseRejectedResult => r.status === "rejected")
            .map((r) => String(r.reason?.message ?? r.reason));
        assert.equal(
            messages.some((m) => /deadlock detected/i.test(m)),
            false,
            `the ordered locks must not deadlock, got: ${JSON.stringify(messages)}`
        );
    } finally {
        await a.user.deleteMany({ where: { email: { in: emails } } }).catch(() => {});
        await Promise.all([a.$disconnect(), b.$disconnect()]);
    }
});
