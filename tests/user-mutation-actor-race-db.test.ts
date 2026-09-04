/**
 * TWO REAL CONNECTIONS, contending over the ACTOR's own authority while their
 * mutation is in flight.
 *
 * Round 12 closed the TARGET half of this: the row being written is now locked
 * FOR UPDATE and re-read inside the transaction, so a promotion committing in
 * the gap cannot leave a request acting on a row it was never authorized
 * against.
 *
 * The ACTOR half survived that fix (round 14, finding 3). Role, status and
 * permissions still came from the query the route ran BEFORE it opened a
 * transaction:
 *
 *   route              SELECT the caller -> MANAGER, with financialReports
 *   someone else       demote / disable / revoke, and COMMIT
 *   route              open a transaction and write, with the authority the
 *                      caller no longer has
 *
 * Three separate consequences, all reachable: `checkUserMutation` judged the
 * write against a stale role; `canWriteRates` (which reads
 * `permissions.financialReports`) let a stripped account set pay rates; and
 * NOTHING anywhere asked whether the actor was still ENABLED, so a disabled
 * account's in-flight request went through.
 *
 * And creation sat outside the guard entirely — `checkUserCreate` ran against
 * that same pre-transaction read, with the INSERT after it.
 *
 * withGuardedUserMutation / withGuardedUserCreate now lock and re-read BOTH
 * rows in ascending id order, inside the transaction, and re-run every check
 * against what those locks actually hold. This proves PostgreSQL serializes it
 * the way the code assumes — an injected sequence would only show the branch
 * exists.
 *
 * Opt-in by URL, like every other DB test here.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";
import path from "node:path";

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

async function seed(db: PrismaClient, suffix: string) {
    const actorEmail = `actor-race-actor-${suffix}@example.test`;
    const targetEmail = `actor-race-target-${suffix}@example.test`;
    await db.user.deleteMany({ where: { email: { in: [actorEmail, targetEmail] } } });

    const actor = await db.user.create({
        data: { name: "Race Actor", email: actorEmail, role: "MANAGER", status: "ACTIVATED" },
        select: { id: true },
    });
    // The permission that decides whether they may write pay rates.
    await db.userPermission.create({ data: { userId: actor.id, financialReports: true } });

    const target = await db.user.create({
        data: {
            name: "Race Target",
            email: targetEmail,
            role: "FIELD_CREW",
            status: "ACTIVATED",
            payType: "HOURLY",
            hourlyRate: 20,
        },
        select: { id: true },
    });

    return {
        actor,
        target,
        restore: async () => {
            await db.userPermission.deleteMany({ where: { userId: { in: [actor.id, target.id] } } }).catch(() => {});
            await db.user.deleteMany({ where: { email: { in: [actorEmail, targetEmail] } } }).catch(() => {});
        },
    };
}

/**
 * A change to the ACTOR's own authority, staged so the caller decides exactly
 * when it commits. `patch` is what a concurrent admin is doing to them.
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
            // The same FOR UPDATE the real guard takes on a target it is about
            // to write — this IS that write, seen from the other side.
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

/** A status write through the REAL guard, exactly as PUT /api/users/[id] drives it. */
async function guardedStatusWrite(db: PrismaClient, actorId: string, targetId: string) {
    const { withGuardedUserMutation } = await import("../src/lib/user-mutation-guard");
    return db.$transaction(
        async (tx) =>
            withGuardedUserMutation(
                tx as never,
                { actorId, targetId, changes: { status: "DISABLED" } },
                async () => {
                    await tx.user.update({ where: { id: targetId }, data: { status: "DISABLED" } });
                }
            ),
        { timeout: 30_000 }
    );
}

/** A rate write through the REAL guard and the REAL rate writer. */
async function guardedRateWrite(db: PrismaClient, actorId: string, targetId: string, rate: string) {
    const { withGuardedUserMutation } = await import("../src/lib/user-mutation-guard");
    const { applyRateChangeInTx } = await import("../src/lib/pay-rate-write");
    const rateChange = { hourlyRate: rate };
    return db.$transaction(
        async (tx) =>
            withGuardedUserMutation(
                tx as never,
                { actorId, targetId, changes: {}, data: {}, rateChange },
                async (_target, actor) => {
                    // The LOCKED actor — this is the object canWriteRates judges.
                    const result = await applyRateChangeInTx(tx as never, actor, targetId, rateChange);
                    if (!result.ok) throw new Error(`RATE_REFUSED: ${result.error}`);
                    return result;
                }
            ),
        { timeout: 30_000 }
    );
}

async function refusal(promise: Promise<unknown>): Promise<{ status?: number; message: string }> {
    const { isUserMutationRefusedError, isUserMutationActorInvalidError } = await import(
        "../src/lib/user-mutation-guard"
    );
    try {
        await promise;
        return { message: "__IT SUCCEEDED__" };
    } catch (error) {
        if (isUserMutationRefusedError(error) || isUserMutationActorInvalidError(error)) {
            return { status: error.verdict.status, message: error.verdict.error };
        }
        return { message: String((error as Error).message ?? error) };
    }
}

// ── demotion ──────────────────────────────────────────────────────────────

test("DEMOTED mid-flight: the write BLOCKS, then is refused — nothing changes", { skip }, async () => {
    const changer = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const writer = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const { actor, target, restore } = await seed(changer, "demote");
    try {
        // An admin is demoting the manager to FIELD_CREW, mid-transaction.
        const staged = stageActorChange(changer, actor.id, { user: { role: "FIELD_CREW" } });
        await new Promise((resolve) => setTimeout(resolve, 200));

        const write = guardedStatusWrite(writer, actor.id, target.id);
        // It genuinely waits on the actor's row lock. Before the fix it never
        // touched that row at all and went straight through.
        assert.equal(await stillPending(write, 700), true, "the write must wait on the actor's row");

        staged.release();
        await staged.running;

        const verdict = await refusal(write);
        assert.equal(verdict.status, 403, verdict.message);
        assert.match(verdict.message, /managers and admins/);

        const after = await changer.user.findUnique({ where: { id: target.id }, select: { status: true } });
        assert.equal(after?.status, "ACTIVATED", "a refusal is not a partial write");
    } finally {
        await restore();
        await Promise.all([changer.$disconnect(), writer.$disconnect()]);
    }
});

// ── disabling ─────────────────────────────────────────────────────────────

test("DISABLED mid-flight: refused — nothing ever asked this question before", { skip }, async () => {
    // Not a regression of an existing check: NOTHING anywhere asked whether the
    // actor was still enabled. Disabling somebody wrote their row and every
    // reader had already read it.
    const changer = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const writer = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const { actor, target, restore } = await seed(changer, "disable");
    try {
        const staged = stageActorChange(changer, actor.id, { user: { status: "DISABLED" } });
        await new Promise((resolve) => setTimeout(resolve, 200));

        const write = guardedStatusWrite(writer, actor.id, target.id);
        assert.equal(await stillPending(write, 700), true);

        staged.release();
        await staged.running;

        const verdict = await refusal(write);
        assert.equal(verdict.status, 403, verdict.message);
        assert.match(verdict.message, /disabled/i);

        const after = await changer.user.findUnique({ where: { id: target.id }, select: { status: true } });
        assert.equal(after?.status, "ACTIVATED");
    } finally {
        await restore();
        await Promise.all([changer.$disconnect(), writer.$disconnect()]);
    }
});

// ── permission revocation, through the RATE writer ────────────────────────

test("REVOKED mid-flight: the rate write is refused by canWriteRates on the LOCKED actor", { skip }, async () => {
    // The permission half. `canWriteRates` reads `permissions.financialReports`,
    // and it used to read it off the route's pre-transaction copy — so an
    // account stripped of payroll access a millisecond earlier still set pay.
    const changer = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const writer = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const { actor, target, restore } = await seed(changer, "revoke");
    try {
        // Demoted out of the always-allowed roles AND stripped of the
        // permission, which is what a revocation actually is: hasPermission
        // returns true for ADMIN and MANAGER unconditionally, so leaving them a
        // manager would not test the permission at all.
        const staged = stageActorChange(changer, actor.id, {
            user: { role: "FIELD_CREW" },
            permissions: { financialReports: false },
        });
        await new Promise((resolve) => setTimeout(resolve, 200));

        const write = guardedRateWrite(writer, actor.id, target.id, "44.00");
        assert.equal(await stillPending(write, 700), true);

        staged.release();
        await staged.running;

        const verdict = await refusal(write);
        // Refused by the guard's own role check first — which is the correct
        // answer and the stronger one. What matters is that the rate did not
        // land.
        assert.equal(verdict.status ?? 403, 403, verdict.message);

        const after = await changer.user.findUnique({ where: { id: target.id }, select: { hourlyRate: true } });
        assert.equal(String(after?.hourlyRate), "20", "the rate must be untouched");
    } finally {
        await restore();
        await Promise.all([changer.$disconnect(), writer.$disconnect()]);
    }
});

test("the PERMISSIONS handed downstream are the ones read under the lock", { skip }, async () => {
    // What this does NOT claim: that revoking financialReports from a MANAGER
    // stops them writing rates. It does not, and that is deliberate —
    // hasPermission returns true for ADMIN and MANAGER unconditionally
    // (src/lib/access-rules.ts: "managers have full access app-wide"), and these
    // three routes only admit MANAGER and ADMIN in the first place. Asserting a
    // refusal here would be asserting a behaviour the app does not have.
    //
    // What it DOES pin is the mechanism: the permission set the guard hands the
    // rate writer is re-read inside the transaction, so it reflects a revocation
    // that committed a moment ago rather than the copy the route loaded before
    // it opened one. That is the object `canWriteRates` judges, and it is what
    // makes the role case above a property of the guard rather than a
    // coincidence.
    const changer = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const writer = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const { actor, target, restore } = await seed(changer, "revoke-only");
    try {
        const { withGuardedUserMutation } = await import("../src/lib/user-mutation-guard");

        // Seeded true; revoked, and committed, before the write opens.
        const staged = stageActorChange(changer, actor.id, { permissions: { financialReports: false } });
        staged.release();
        await staged.running;

        type Seen = { role: string; status: string; permissions: Record<string, unknown> | null };
        const captured: Seen[] = [];
        await writer.$transaction(async (tx) =>
            withGuardedUserMutation(
                tx as never,
                { actorId: actor.id, targetId: target.id, changes: { status: "DISABLED" } },
                async (_target, lockedActor) => {
                    captured.push(lockedActor);
                    await tx.user.update({ where: { id: target.id }, data: { status: "DISABLED" } });
                }
            )
        );

        assert.equal(captured.length, 1, "the guard must hand the write its locked actor");
        const seen = captured[0];
        assert.equal(seen.role, "MANAGER");
        assert.equal(seen.status, "ACTIVATED");
        // THE assertion: the revocation is visible. The route's pre-transaction
        // copy still said true.
        assert.equal(seen.permissions?.financialReports, false);
    } finally {
        await restore();
        await Promise.all([changer.$disconnect(), writer.$disconnect()]);
    }
});

// ── creation ──────────────────────────────────────────────────────────────

test("CREATE: an actor demoted mid-flight mints nothing", { skip }, async () => {
    const changer = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const writer = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const { actor, restore } = await seed(changer, "create");
    const createdEmail = "actor-race-created@example.test";
    await changer.user.deleteMany({ where: { email: createdEmail } });
    try {
        const { withGuardedUserCreate } = await import("../src/lib/user-mutation-guard");

        const staged = stageActorChange(changer, actor.id, { user: { role: "FIELD_CREW" } });
        await new Promise((resolve) => setTimeout(resolve, 200));

        const creating = writer.$transaction(
            async (tx) =>
                withGuardedUserCreate(tx as never, { actorId: actor.id, role: "FIELD_CREW" }, async () => {
                    return tx.user.create({
                        data: { email: createdEmail, role: "FIELD_CREW", status: "PENDING" },
                        select: { id: true },
                    });
                }),
            { timeout: 30_000 }
        );
        assert.equal(await stillPending(creating, 700), true, "the create must wait on the actor's row");

        staged.release();
        await staged.running;

        const verdict = await refusal(creating);
        assert.equal(verdict.status, 403, verdict.message);
        assert.equal(
            await changer.user.count({ where: { email: createdEmail } }),
            0,
            "no row may be left behind by a refused create"
        );
    } finally {
        await changer.user.deleteMany({ where: { email: createdEmail } }).catch(() => {});
        await restore();
        await Promise.all([changer.$disconnect(), writer.$disconnect()]);
    }
});

test("CREATE CONTROL: an undisturbed actor still creates", { skip }, async () => {
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const { actor, restore } = await seed(db, "create-ok");
    const createdEmail = "actor-race-created-ok@example.test";
    await db.user.deleteMany({ where: { email: createdEmail } });
    try {
        const { withGuardedUserCreate } = await import("../src/lib/user-mutation-guard");
        await db.$transaction(async (tx) =>
            withGuardedUserCreate(tx as never, { actorId: actor.id, role: "FIELD_CREW" }, async () =>
                tx.user.create({ data: { email: createdEmail, role: "FIELD_CREW", status: "PENDING" } })
            )
        );
        assert.equal(await db.user.count({ where: { email: createdEmail } }), 1);
    } finally {
        await db.user.deleteMany({ where: { email: createdEmail } }).catch(() => {});
        await restore();
        await db.$disconnect();
    }
});

// ── the pre-fix control ───────────────────────────────────────────────────

test("PRE-FIX CONTROL: authorizing on the pre-read actor wrongly succeeds", { skip }, async () => {
    // The old shape, written out: read the actor BEFORE the transaction, decide,
    // then open a transaction and write. Without this the refusals above could
    // be passing on a race that was never winnable.
    const changer = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const writer = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const { actor, target, restore } = await seed(changer, "prefix");
    try {
        const { checkUserMutation } = await import("../src/lib/user-mutation-guard");

        // 1. The route's pre-transaction read. Still a MANAGER here.
        const preRead = await writer.user.findUnique({
            where: { id: actor.id },
            select: { id: true, role: true },
        });

        // 2. The demotion commits, in full, before the write even opens.
        const staged = stageActorChange(changer, actor.id, { user: { role: "FIELD_CREW" } });
        staged.release();
        await staged.running;

        // 3. The write proceeds on the stale authority. Note the TARGET is
        //    re-read under FOR UPDATE — round 12's fix is present and does not
        //    help, because the stale value is on the other side.
        await writer.$transaction(async (tx) => {
            const rows = (await tx.$queryRawUnsafe(
                `SELECT "id", "role" FROM "User" WHERE "id" = $1 FOR UPDATE`,
                target.id
            )) as Array<{ id: string; role: string }>;
            const verdict = checkUserMutation({
                actor: preRead as { id: string; role: string },
                target: rows[0],
                changes: { status: "DISABLED" },
            });
            assert.equal(verdict.ok, true, "the stale MANAGER role passes the check — that is the bug");
            await tx.user.update({ where: { id: target.id }, data: { status: "DISABLED" } });
        });

        const after = await changer.user.findUnique({ where: { id: target.id }, select: { status: true } });
        assert.equal(after?.status, "DISABLED", "a demoted account disabled somebody — the hole, verbatim");

        // And the real guard refuses the very same thing.
        await changer.user.update({ where: { id: target.id }, data: { status: "ACTIVATED" } });
        const guarded = await refusal(guardedStatusWrite(writer, actor.id, target.id));
        assert.equal(guarded.status, 403, guarded.message);
    } finally {
        await restore();
        await Promise.all([changer.$disconnect(), writer.$disconnect()]);
    }
});

// ── deadlock freedom ──────────────────────────────────────────────────────

test("two managers editing EACH OTHER at once do not deadlock — ascending id order", { skip }, async () => {
    // Both transactions need the same two rows. The guard takes them in
    // ascending id order, so whichever starts first holds the lower id and the
    // other queues; taking "actor then target" would have given the two
    // transactions opposite orders and closed a cycle.
    const a = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const b = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const emails = ["actor-race-pair-1@example.test", "actor-race-pair-2@example.test"];
    await a.user.deleteMany({ where: { email: { in: emails } } });
    const one = await a.user.create({
        data: { name: "Pair One", email: emails[0], role: "ADMIN", status: "ACTIVATED" },
        select: { id: true },
    });
    const two = await a.user.create({
        data: { name: "Pair Two", email: emails[1], role: "ADMIN", status: "ACTIVATED" },
        select: { id: true },
    });
    try {
        const results = await Promise.allSettled([
            guardedStatusWrite(a, one.id, two.id),
            guardedStatusWrite(b, two.id, one.id),
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

test("a manager editing THEMSELVES takes one lock, not two — and is still refused", { skip }, async () => {
    // The degenerate case: actor and target are one row. It is locked once, in
    // the stronger mode, so a self-edit cannot wait on itself.
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const { actor, restore } = await seed(db, "self");
    try {
        const verdict = await refusal(guardedStatusWrite(db, actor.id, actor.id));
        assert.equal(verdict.status, 403, verdict.message);
        assert.match(verdict.message, /your own status/i);
        const after = await db.user.findUnique({ where: { id: actor.id }, select: { status: true } });
        assert.equal(after?.status, "ACTIVATED");
    } finally {
        await restore();
        await db.$disconnect();
    }
});

// -- A PENDING actor is not an authorized actor (round 16, finding 3) -------

test("PENDING mid-flight: refused — 'not disabled' was never the same as 'activated'", { skip }, async () => {
    // checkActorUsable rejected only DISABLED. PENDING is the status EVERY
    // create in this app produces, and it is what an admin revoking access by
    // resetting somebody produces too — so an account that had been put back to
    // 'invited, not yet activated' kept every authority it had a moment before.
    const changer = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const writer = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const { actor, target, restore } = await seed(changer, "pending");
    try {
        const staged = stageActorChange(changer, actor.id, { user: { status: "PENDING" } });
        await new Promise((resolve) => setTimeout(resolve, 200));

        const write = guardedStatusWrite(writer, actor.id, target.id);
        assert.equal(await stillPending(write, 700), true, "the write must wait on the actor's row");

        staged.release();
        await staged.running;

        const verdict = await refusal(write);
        assert.equal(verdict.status, 403, verdict.message);
        assert.match(verdict.message, /not activated/i);

        const after = await changer.user.findUnique({ where: { id: target.id }, select: { status: true } });
        assert.equal(after?.status, "ACTIVATED", "a refusal is not a partial write");
    } finally {
        await restore();
        await Promise.all([changer.$disconnect(), writer.$disconnect()]);
    }
});

test("the status check is POSITIVE — every non-ACTIVATED status is refused", async () => {
    // A denylist of two is correct until the third status exists. USER_STATUSES
    // has three members and exactly one means 'may act'.
    const { checkActorUsable } = await import("../src/lib/user-mutation-guard");
    const { USER_STATUSES } = await import("../src/lib/user-mutation-guard");
    for (const status of USER_STATUSES) {
        const verdict = checkActorUsable({ id: "u1", role: "MANAGER", status });
        assert.equal(verdict.ok, status === "ACTIVATED", status);
    }
    // ...including one nobody has added yet.
    assert.equal(checkActorUsable({ id: "u1", role: "MANAGER", status: "SUSPENDED" }).ok, false);
    assert.equal(checkActorUsable(null).ok, false);
});

// -- Project access is a permission change (round 16, finding 4) -----------

/** A project-access write through the REAL guard, as PUT /api/users/[id] drives it. */
async function guardedProjectWrite(db: PrismaClient, actorId: string, targetId: string, projectIds: string[]) {
    const { withGuardedUserMutation } = await import("../src/lib/user-mutation-guard");
    return db.$transaction(
        async (tx) =>
            withGuardedUserMutation(tx as never, { actorId, targetId, changes: {} }, async () => {
                await tx.projectAccess.deleteMany({ where: { userId: targetId } });
                if (projectIds.length > 0) {
                    await tx.projectAccess.createMany({
                        data: projectIds.map((projectId) => ({ userId: targetId, projectId })),
                        skipDuplicates: true,
                    });
                }
            }),
        { timeout: 30_000 }
    );
}

test("PROJECT ACCESS: a demoted, disabled or PENDING actor writes nothing", { skip }, async () => {
    // It used to run in its own transaction AFTER the guarded one, and a
    // project-only body never opened the guarded one at all — so which jobs a
    // person can see was writable with no authority check of any kind.
    const changer = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const writer = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    for (const [label, patch] of [
        ["demoted", { user: { role: "FIELD_CREW" } }],
        ["disabled", { user: { status: "DISABLED" } }],
        ["pending", { user: { status: "PENDING" } }],
    ] as const) {
        const { actor, target, restore } = await seed(changer, `project-${label}`);
        try {
            const staged = stageActorChange(changer, actor.id, patch);
            await new Promise((resolve) => setTimeout(resolve, 200));

            const write = guardedProjectWrite(writer, actor.id, target.id, []);
            assert.equal(await stillPending(write, 700), true, label);
            staged.release();
            await staged.running;

            const verdict = await refusal(write);
            assert.equal(verdict.status, 403, `${label}: ${verdict.message}`);
        } finally {
            await restore();
        }
    }
    await Promise.all([changer.$disconnect(), writer.$disconnect()]);
});

test("PROJECT ACCESS: a target promoted to ADMIN mid-flight refuses a manager", { skip }, async () => {
    // The target half, on the project path — round 12's fix reached the profile
    // writes but not this one, because this one was not in the transaction.
    const promoter = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const writer = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const { actor, target, restore } = await seed(promoter, "project-target");
    try {
        const staged = stageActorChange(promoter, target.id, { user: { role: "ADMIN" } });
        await new Promise((resolve) => setTimeout(resolve, 200));

        const write = guardedProjectWrite(writer, actor.id, target.id, []);
        assert.equal(await stillPending(write, 700), true);
        staged.release();
        await staged.running;

        const verdict = await refusal(write);
        assert.equal(verdict.status, 403, verdict.message);
        assert.match(verdict.message, /admin/i);
    } finally {
        await restore();
        await Promise.all([promoter.$disconnect(), writer.$disconnect()]);
    }
});

test("PROJECT ACCESS CONTROL: an undisturbed manager still writes it", { skip }, async () => {
    // Without this every refusal above could be a path that never works.
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const { actor, target, restore } = await seed(db, "project-ok");
    try {
        await guardedProjectWrite(db, actor.id, target.id, []);
        assert.equal(await db.projectAccess.count({ where: { userId: target.id } }), 0);
    } finally {
        await restore();
        await db.$disconnect();
    }
});

test("a project-only PUT body goes through the guard at all", () => {
    // The route-level half: the condition that decides whether the guarded
    // transaction opens must include `projectIds`, or a body carrying only
    // project ids skips every check above.
    const source = readFileSync(
        path.join(__dirname, "..", "src", "app", "api", "users", "[id]", "route.ts"),
        "utf8"
    );
    assert.match(source, /projectIds !== undefined\s*\n?\s*\) \{/, "the guard must open for a project-only body");
    // And the writes are INSIDE the guarded closure, not in a second
    // transaction after it.
    const guarded = source.slice(source.indexOf("withGuardedUserMutation("));
    const closure = guarded.slice(0, guarded.indexOf("} catch (error) {"));
    assert.match(closure, /tx\.projectAccess\.deleteMany/, "project access must be written on the guarded tx");
    assert.match(closure, /tx\.projectAccess\.createMany/);
    assert.ok(
        !/prisma\.projectAccess\./.test(source),
        "no project-access write may run on the singleton, outside the guard"
    );
});
