/**
 * THE GLOBAL LOCK ORDER, held to by PostgreSQL rather than by a comment.
 *
 * Tier 1 is the payroll advisory lock; tier 2 is the User row. Every payroll
 * writer takes them in that order, and lockPayrollPeriod takes tier 1 and then
 * reads the roster FOR SHARE — so as long as nobody inverts the pair, the two
 * cannot close a cycle.
 *
 * THE INVERSION (round 13, finding 1). withGuardedUserMutation decided whether
 * to take tier 1 by looking at the Prisma `data` payload alone. The rate fields
 * do not travel in `data` — they go SEPARATELY to applyRateChangeInTx, which
 * takes tier 1 itself. So for a RATE-ONLY edit (`data` empty, or naming only
 * columns like pinCode) the guard skipped tier 1, took the target row FOR
 * UPDATE, and only then let the rate writer ask for the advisory lock:
 *
 *   rate edit          BEGIN; SELECT role ... FOR UPDATE   -> holds the ROW
 *   lockPayrollPeriod  BEGIN; pg_advisory_xact_lock        -> holds TIER 1
 *   lockPayrollPeriod  SELECT ... FOR SHARE on that row    -> waits on the rate edit
 *   rate edit          pg_advisory_xact_lock_shared        -> waits on the period lock
 *
 * which is a deadlock, and PostgreSQL says so.
 *
 * The fix is one predicate (takesPayrollWriteLock) asked of the WHOLE request,
 * so tier 1 is taken before tier 2 whenever any part of the request will need
 * it. These cases run BOTH orders on two real connections, with the pre-fix
 * sequence written out beside them as the control.
 *
 * Opt-in by URL, like every other DB test here.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";

const databaseUrl = process.env.PAYROLL_LOCK_TEST_URL;
const skip = !databaseUrl && "set PAYROLL_LOCK_TEST_URL to a disposable PostgreSQL URL";

/** The key both halves hash. Same string as PAYROLL_ADVISORY_LOCK_KEY. */
const KEY = "payroll-period";

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
    const email = `lock-order-${suffix}@example.test`;
    await db.user.deleteMany({ where: { email } });
    const user = await db.user.create({
        data: {
            name: `Lock Order ${suffix}`,
            email,
            role: "FIELD_CREW",
            status: "ACTIVATED",
            payType: "HOURLY",
            hourlyRate: 20,
        },
        select: { id: true, role: true },
    });
    // A BYSTANDER: an ordinary roster member, on the same period, whose row the
    // staged period lock holds FOR SHARE. It is what makes "this blocked" mean
    // "it blocked on tier 1" and nothing else.
    const bystanderEmail = `lock-order-bystander-${suffix}@example.test`;
    await db.user.deleteMany({ where: { email: bystanderEmail } });
    const bystander = await db.user.create({
        data: {
            name: `Bystander ${suffix}`,
            email: bystanderEmail,
            role: "FIELD_CREW",
            status: "ACTIVATED",
            payType: "HOURLY",
            hourlyRate: 20,
        },
        select: { id: true },
    });

    // A REAL actor row. The guard locks and re-reads the actor inside the
    // transaction now (round 14, finding 3), so a made-up id is a 403 rather
    // than a rate edit.
    const actorEmail = `lock-order-actor-${suffix}@example.test`;
    await db.user.deleteMany({ where: { email: actorEmail } });
    const actor = await db.user.create({
        data: { name: `Lock Order Actor ${suffix}`, email: actorEmail, role: "ADMIN", status: "ACTIVATED" },
        select: { id: true },
    });

    return {
        user,
        bystander,
        actor,
        restore: async () => {
            await db.user
                .deleteMany({ where: { email: { in: [email, bystanderEmail, actorEmail] } } })
                .catch(() => {});
        },
    };
}

/**
 * A period lock, staged: takes tier 1 EXCLUSIVE, then reads a roster row
 * FOR SHARE, then waits for the caller to release it. Exactly the shape
 * lockPayrollPeriod has.
 *
 * `userId` is the row it holds, which is DELIBERATELY a parameter. Point it at
 * a BYSTANDER and the advisory lock is the only thing that can make anybody
 * wait — which is how these cases tell "tier 1 held it" apart from "a row lock
 * held it". Point it at the contended row and you get the cycle the pre-fix
 * control needs.
 */
function stagePeriodLock(db: PrismaClient, userId: string) {
    let release: () => void = () => {};
    let reachedRow: () => void = () => {};
    const held = new Promise<void>((resolve) => {
        release = resolve;
    });
    const atRow = new Promise<void>((resolve) => {
        reachedRow = resolve;
    });
    const running = db.$transaction(
        async (tx) => {
            await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1))`, KEY);
            await tx.$queryRawUnsafe(`SELECT "id" FROM "User" WHERE "id" = $1 FOR SHARE`, userId);
            reachedRow();
            await held;
        },
        { timeout: 30_000 }
    );
    return { running, release, atRow };
}

/**
 * A tx client that runs `hook` ONCE, immediately after the first
 * `... FOR UPDATE` this transaction issues.
 *
 * That instant is the whole question. If the guard has already taken tier 1 by
 * then, whatever the hook starts can only queue behind the advisory lock; if it
 * has not, the transaction is sitting on a row with tier 1 still to come, which
 * is the half-built inversion.
 */
function clientPausingAfterRowLock(tx: unknown, hook: () => Promise<void>) {
    let fired = false;
    return new Proxy(tx as Record<string, unknown>, {
        get(target, prop, receiver) {
            const value = Reflect.get(target, prop, receiver);
            if (prop !== "$queryRawUnsafe" || typeof value !== "function") return value;
            return async (query: string, ...values: unknown[]) => {
                const result = await (value as (q: string, ...v: unknown[]) => Promise<unknown>).call(
                    target,
                    query,
                    ...values
                );
                if (!fired && /FOR UPDATE/i.test(query)) {
                    fired = true;
                    await hook();
                }
                return result;
            };
        },
    });
}

/** A rate-only edit through the REAL guard and the REAL rate writer. */
async function guardedRateEdit(
    db: PrismaClient,
    actorId: string,
    userId: string,
    rate: string,
    afterRowLock?: () => Promise<void>
) {
    const { withGuardedUserMutation } = await import("../src/lib/user-mutation-guard");
    const { applyRateChangeInTx } = await import("../src/lib/pay-rate-write");
    const rateChange = { hourlyRate: rate };
    return db.$transaction(
        async (rawTx) => {
            const tx = afterRowLock ? clientPausingAfterRowLock(rawTx, afterRowLock) : rawTx;
            return withGuardedUserMutation(
                tx as never,
                {
                    actorId,
                    targetId: userId,
                    // NOTHING in `changes` and NOTHING in `data`: this is the
                    // rate-only shape the old predicate was blind to.
                    changes: {},
                    data: {},
                    rateChange,
                },
                async (_target, actor) => {
                    const result = await applyRateChangeInTx(tx as never, actor, userId, rateChange);
                    if (!result.ok) throw new Error(result.error);
                    return result;
                }
            );
        },
        { timeout: 30_000 }
    );
}

// ── the predicate itself ───────────────────────────────────────────────────

test("the predicate answers for the WHOLE request, not half of it", async () => {
    const { takesPayrollWriteLock, touchesPayrollRateState, touchesExportUserState } = await import(
        "../src/lib/payroll-period"
    );

    // The exact shape that inverted the order: nothing export-affecting in
    // `data`, everything in the rate payload.
    assert.equal(touchesExportUserState({ pinCode: "hash" }), false);
    assert.equal(takesPayrollWriteLock({ data: { pinCode: "hash" }, rateChange: { hourlyRate: "30" } }), true);

    // Either half alone is enough.
    assert.equal(takesPayrollWriteLock({ data: { status: "ACTIVATED" } }), true);
    assert.equal(takesPayrollWriteLock({ rateChange: { payType: "HOURLY" } }), true);
    assert.equal(takesPayrollWriteLock({ rateChange: { burdenRate: "3" } }), true);

    // And neither half is over-eager. The rate side is VALUE-based on purpose:
    // every route builds one object literal carrying all three fields whether
    // or not the request named them, so a key-based test would take the payroll
    // lock on every single team-member edit.
    assert.equal(
        takesPayrollWriteLock({
            data: { showOnDispatch: true },
            rateChange: { hourlyRate: undefined, burdenRate: undefined, payType: undefined },
        }),
        false
    );
    assert.equal(touchesPayrollRateState({ hourlyRate: undefined }), false);
    assert.equal(touchesPayrollRateState(undefined), false);
    // ...whereas the `data` side is KEY-based, and stays that way.
    assert.equal(touchesExportUserState({ status: undefined }), true);
});

// ── order A: the rate edit starts first ────────────────────────────────────

test("RATE EDIT FIRST: it holds tier 1, so the period lock simply queues behind it", { skip }, async () => {
    const writer = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const locker = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const { user, bystander, actor, restore } = await seed(writer, "a");
    try {
        // The guarded rate edit runs to completion on its own — it never has to
        // wait for anything, because it takes tier 1 before tier 2.
        await guardedRateEdit(writer, actor.id, user.id, "27.25");

        // And a period lock afterwards sees the committed value.
        const staged = stagePeriodLock(locker, bystander.id);
        await staged.atRow;
        staged.release();
        await staged.running;

        const row = await writer.user.findUnique({ where: { id: user.id }, select: { hourlyRate: true } });
        assert.equal(String(row?.hourlyRate), "27.25");
    } finally {
        await restore();
        await Promise.all([writer.$disconnect(), locker.$disconnect()]);
    }
});

// ── order B: the period lock starts first ──────────────────────────────────

test("PERIOD LOCK FIRST: the rate edit BLOCKS on tier 1 holding no row, then completes", { skip }, async () => {
    const writer = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const locker = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const { user, bystander, actor, restore } = await seed(writer, "b");
    try {
        // The period lock holds a BYSTANDER's row, not the one being edited, so
        // the ONLY thing that can make the rate edit wait is tier 1. If the
        // guard skipped the advisory lock the edit would sail through here.
        const staged = stagePeriodLock(locker, bystander.id);
        await staged.atRow;

        const editing = guardedRateEdit(writer, actor.id, user.id, "33.00");
        // It really is waiting, not racing through: the period lock holds tier 1
        // EXCLUSIVE, and the rate edit asks for it before it touches the row.
        assert.equal(await stillPending(editing, 700), true, "the rate edit must wait for the period lock");

        staged.release();
        await staged.running;
        await editing;

        const row = await writer.user.findUnique({ where: { id: user.id }, select: { hourlyRate: true } });
        assert.equal(String(row?.hourlyRate), "33");
    } finally {
        await restore();
        await Promise.all([writer.$disconnect(), locker.$disconnect()]);
    }
});

// ── the REAL guard, interleaved at the exact instant that used to deadlock ──

test("INTERLEAVED: a period lock arriving while the guard holds the row does NOT deadlock", { skip }, async () => {
    // THE distinguishing case. The two orders above pass either way — with the
    // fix the edit waits on tier 1, without it the edit waits on a row — and a
    // "did it block?" assertion cannot tell those apart. This one can.
    //
    // The period lock is started at the one instant that matters: right after
    // the guard has taken the target row FOR UPDATE, and it reaches for THAT
    // row. Under the old predicate the guard had not taken tier 1 yet, so the
    // period lock got it and the two closed a cycle. With the fix tier 1 is
    // already held, so the period lock queues on the advisory lock and never
    // reaches the row at all.
    const writer = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const locker = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const { user, actor, restore } = await seed(writer, "d");
    let periodLock: Promise<unknown> = Promise.resolve();
    try {
        const editing = guardedRateEdit(writer, actor.id, user.id, "41.00", async () => {
            periodLock = locker.$transaction(
                async (tx) => {
                    await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1))`, KEY);
                    await tx.$queryRawUnsafe(`SELECT "id" FROM "User" WHERE "id" = $1 FOR SHARE`, user.id);
                },
                { timeout: 30_000 }
            );
            // Long enough for it to reach whichever lock it is going to wait on.
            await new Promise((resolve) => setTimeout(resolve, 600));
            // And it IS waiting — on tier 1, which this transaction holds.
            assert.equal(await stillPending(periodLock, 200), true, "the period lock should be queued on tier 1");
        });

        // BOTH complete. Under the pre-fix order one of them was killed with
        // `deadlock detected` instead.
        await editing;
        await periodLock;

        const row = await writer.user.findUnique({ where: { id: user.id }, select: { hourlyRate: true } });
        assert.equal(String(row?.hourlyRate), "41");
    } finally {
        await periodLock.catch(() => {});
        await restore();
        await Promise.all([writer.$disconnect(), locker.$disconnect()]);
    }
});

// ── the pre-fix control: the same two, inverted, really do deadlock ─────────

test("PRE-FIX CONTROL: taking the row before tier 1 DEADLOCKS against a period lock", { skip }, async () => {
    // Written out in the exact vulnerable order the guard used to produce for a
    // rate-only edit: row FOR UPDATE first, advisory lock second. Without this
    // the two cases above could be passing on a mechanism that was never at
    // risk.
    const writer = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const locker = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const { user, restore } = await seed(writer, "c");
    try {
        let rowTaken: () => void = () => {};
        const atRow = new Promise<void>((resolve) => {
            rowTaken = resolve;
        });
        let advisoryGo: () => void = () => {};
        const waitToAskForTier1 = new Promise<void>((resolve) => {
            advisoryGo = resolve;
        });

        const inverted = writer.$transaction(
            async (tx) => {
                // TIER 2 FIRST — the inversion.
                await tx.$queryRawUnsafe(`SELECT "role" FROM "User" WHERE "id" = $1 FOR UPDATE`, user.id);
                rowTaken();
                await waitToAskForTier1;
                // ...and only now tier 1, which is what applyRateChangeInTx did.
                await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock_shared(hashtext($1))`, KEY);
                await tx.$executeRawUnsafe(`UPDATE "User" SET "hourlyRate" = 99 WHERE "id" = $1`, user.id);
            },
            { timeout: 30_000 }
        );

        await atRow;
        // The period lock now takes tier 1 and reaches for the row the inverted
        // transaction is holding.
        const periodLock = locker.$transaction(
            async (tx) => {
                await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1))`, KEY);
                await tx.$queryRawUnsafe(`SELECT "id" FROM "User" WHERE "id" = $1 FOR SHARE`, user.id);
            },
            { timeout: 30_000 }
        );
        // Give it time to take tier 1 and block on the row.
        assert.equal(await stillPending(periodLock, 500), true, "the period lock should be waiting on the row");

        advisoryGo();

        // One of the two is chosen as the victim; PostgreSQL reports 40P01.
        const results = await Promise.allSettled([inverted, periodLock]);
        const messages = results
            .filter((r): r is PromiseRejectedResult => r.status === "rejected")
            .map((r) => String(r.reason?.message ?? r.reason));
        assert.equal(
            messages.some((m) => /deadlock detected/i.test(m)),
            true,
            `expected a deadlock from the inverted order, got: ${JSON.stringify(messages)}`
        );
    } finally {
        await restore();
        await Promise.all([writer.$disconnect(), locker.$disconnect()]);
    }
});

// ── the seed in the apply script follows the same protocol (finding 4) ─────

test("SEED: the payType seed serializes against a period lock and bumps the revision", { skip }, async () => {
    // scripts/apply-payroll-phase5.mjs seeds payType = SALARY for the emails an
    // operator listed. payType is half the Gusto roster predicate, so this is a
    // payroll write like any other — and it used to run as a bare UPDATE on the
    // pooled connection with no advisory lock and no payrollRevision bump
    // (round 13, finding 4). This is the statement it now runs, on real
    // connections, against a real period lock.
    const seeder = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const locker = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const email = `lock-order-seed-target@example.test`;
    await seeder.user.deleteMany({ where: { email } });
    const user = await seeder.user.create({
        data: { name: "Seed Target", email, role: "MANAGER", status: "ACTIVATED" },
        select: { id: true, payrollRevision: true },
    });
    assert.equal(user.payrollRevision, 0);
    // The period lock holds a BYSTANDER, and it has to: the seed's own target
    // has payType NULL, so it is not on the roster predicate
    // (ACTIVATED AND HOURLY) and `SELECT ... FOR SHARE` could never have locked
    // it. That is precisely why an advisory lock is the only defence here — the
    // same reasoning the activation race rests on.
    const { bystander, restore: restoreBystander } = await seed(seeder, "seed");

    const runSeed = () =>
        seeder.$transaction(
            async (tx) => {
                await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock_shared(hashtext($1))`, KEY);
                return tx.$executeRawUnsafe(
                    `UPDATE "User"
                        SET "payType" = 'SALARY', "payrollRevision" = "payrollRevision" + 1
                      WHERE "payType" IS NULL AND lower("email") = ANY($1::text[])`,
                    [email]
                );
            },
            { timeout: 30_000 }
        );

    try {
        // A period lock is mid-transaction, holding tier 1 EXCLUSIVE.
        const staged = stagePeriodLock(locker, bystander.id);
        await staged.atRow;

        const seeding = runSeed();
        assert.equal(
            await stillPending(seeding, 700),
            true,
            "the seed must wait for the period lock — this is the whole point of the advisory lock"
        );

        staged.release();
        await staged.running;
        assert.equal(await seeding, 1, "one row seeded");

        const after = await seeder.user.findUnique({
            where: { id: user.id },
            select: { payType: true, payrollRevision: true },
        });
        assert.equal(after?.payType, "SALARY");
        assert.equal(after?.payrollRevision, 1, "a changed row moves the counter");

        // IDEMPOTENT, and the counter proves it: a second run matches nothing,
        // so nothing is written and the revision does not move. A seed that
        // bumped on every run would invalidate a rate-import approval each time
        // somebody re-ran the deploy step.
        assert.equal(await runSeed(), 0, "a second run changes no rows");
        const twice = await seeder.user.findUnique({
            where: { id: user.id },
            select: { payrollRevision: true },
        });
        assert.equal(twice?.payrollRevision, 1, "the revision only moves for rows that actually changed");
    } finally {
        await restoreBystander();
        await seeder.user.deleteMany({ where: { email } }).catch(() => {});
        await Promise.all([seeder.$disconnect(), locker.$disconnect()]);
    }
});

test("SEED CONTROL: without the advisory lock the seed does NOT wait", { skip }, async () => {
    // The pre-fix shape. Without it, "the seed waited" above could be a seed
    // that waits on something else entirely.
    const seeder = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const locker = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const email = `lock-order-seed-control-target@example.test`;
    await seeder.user.deleteMany({ where: { email } });
    const user = await seeder.user.create({
        data: { name: "Seed Control", email, role: "MANAGER", status: "ACTIVATED" },
        select: { id: true },
    });
    const { bystander, restore: restoreBystander } = await seed(seeder, "seed-control");

    try {
        const staged = stagePeriodLock(locker, bystander.id);
        await staged.atRow;

        // The OLD statement: no lock, no revision bump. It commits straight
        // through the period lock — which is exactly how a period could be
        // frozen around a roster that had already moved.
        const bare = seeder.$executeRawUnsafe(
            `UPDATE "User" SET "payType" = 'SALARY' WHERE "payType" IS NULL AND lower("email") = ANY($1::text[])`,
            [email]
        );
        assert.equal(await stillPending(bare, 700), false, "the unlocked seed does not wait — that was the bug");
        assert.equal(await bare, 1);

        staged.release();
        await staged.running;

        const after = await seeder.user.findUnique({ where: { id: user.id }, select: { payrollRevision: true } });
        assert.equal(after?.payrollRevision, 0, "and it moved no revision either");
    } finally {
        await restoreBystander();
        await seeder.user.deleteMany({ where: { email } }).catch(() => {});
        await Promise.all([seeder.$disconnect(), locker.$disconnect()]);
    }
});
