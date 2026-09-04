/**
 * POST /api/users answers 201 with the row that was actually committed.
 *
 * The handler creates the user and then applies rates through
 * `applyRateChangeInTx`, which runs its OWN `tx.user.update` — so the object
 * `tx.user.create` returned is a snapshot from BEFORE that update. Returning it
 * meant the 201 body reported `hourlyRate: null`, `payType: null`,
 * `payrollRevision: 0` and `lastRateSyncAt: null` for a user who had just been
 * given a rate: a body that contradicted the committed row, on the payroll
 * fields specifically, and a caller UI that rendered "no rate set" for a rate
 * somebody had just typed in.
 *
 * Driven as a REAL request against the REAL handler. Only two things are
 * intercepted — the NextAuth session and the auth module it is configured from —
 * because there is no other way to be signed in inside a unit test. Everything
 * that matters here is the genuine article: the real `applyRateChangeInTx` does
 * the rate write (including the `payrollRevision: { increment: 1 }` and the
 * `lastRateSyncAt` stamp), against a fake client that models a row the way
 * Postgres would, and the assertion compares the response body against that
 * row read back afterwards.
 *
 * The interception is a scoped `Module.prototype.require` patch rather than
 * node:test's `mock.module()` — see tests/takeoff-convert-tax.test.ts's header
 * for why (`mock.module()` corrupts the require chain on the Node 20 CI pins).
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import Module from "node:module";

process.env.NEXTAUTH_SECRET ??= "test-secret-for-users-create-payroll-body";
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test?pgbouncer=true";
// Leave RESEND_API_KEY unset: the invite email is not what this measures, and
// the handler already skips it when there is no key.
delete process.env.RESEND_API_KEY;

const ADMIN_EMAIL = "admin@example.test";
const NEW_EMAIL = "new.hire@example.test";

type Row = Record<string, unknown>;

/** The one row the fake database holds, plus a log of what touched it. */
let row: Row | null = null;
let locked: string[] = [];

/** `{ increment: n }` and Prisma.Decimal are what a real update would receive. */
function applyUpdate(target: Row, data: Record<string, unknown>) {
    for (const [key, value] of Object.entries(data)) {
        if (value && typeof value === "object" && "increment" in (value as Record<string, unknown>)) {
            target[key] = Number(target[key] ?? 0) + Number((value as { increment: number }).increment);
            continue;
        }
        target[key] = value;
    }
}

function fakeTx() {
    return {
        $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
            // The FOR UPDATE row lock, and then the staff-role read that gates
            // every rate write (round 8, finding 2).
            if (sql.includes("FOR UPDATE")) locked.push(String(args[0]));
            const id = String(args[0]);
            // withGuardedUserCreate locks and re-reads the ACTOR inside the
            // transaction now (round 14, finding 3) — creation used to be
            // decided against the route's pre-transaction read. A fake that
            // answered FIELD_CREW for every id therefore refused every create.
            if (/UserPermission/.test(sql)) return [];
            if (id === "u-admin") return [{ id, role: "ADMIN", status: "ACTIVATED" }];
            return [{ id, role: "FIELD_CREW", status: "ACTIVATED" }];
        },
        // The payroll advisory lock — tier 1 of the global lock order, taken by
        // applyRateChangeInTx before the row lock (round 33, finding 1).
        $executeRawUnsafe: async (_sql: string, ...args: unknown[]) => {
            locked.push(`advisory:${String(args[0])}`);
            return 0;
        },
        user: {
            create: async ({ data }: { data: Record<string, unknown> }) => {
                row = {
                    id: "u-new",
                    // A BCRYPT-SHAPED value, so "the 201 body has no pinCode"
                    // is a statement about the serializer and not about an
                    // empty column (round 8, finding 1).
                    pinCode: "$2a$10$abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUV",
                    // The database defaults the handler's create does not set —
                    // exactly the fields that made the stale body wrong.
                    hourlyRate: null,
                    burdenRate: null,
                    payType: null,
                    payrollRevision: 0,
                    lastRateSyncAt: null,
                    ...data,
                };
                // A COPY. `create` handing back a live reference would make the
                // stale-body bug invisible: the old object would appear to
                // update itself, and this test would pass against the bug.
                return { ...row };
            },
            update: async ({ data }: { data: Record<string, unknown> }) => {
                if (!row) throw new Error("update before create");
                applyUpdate(row, data);
                return { ...row };
            },
            findUniqueOrThrow: async () => {
                if (!row) throw new Error("no such row");
                return { ...row };
            },
        },
    };
}

function installFakePrisma() {
    row = null;
    locked = [];
    (globalThis as Record<string, unknown>).prisma = {
        user: {
            findUnique: async ({ where }: { where: { email?: string } }) => {
                // The caller lookup...
                if (where.email === ADMIN_EMAIL) {
                    return { id: "u-admin", email: ADMIN_EMAIL, role: "ADMIN", permissions: {} };
                }
                // ...and the "does this email already exist" check.
                return null;
            },
        },
        $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(fakeTx()),
        // autoGrantNewProjects false, so no project fan-out runs.
        userPermission: { create: async () => ({ autoGrantNewProjects: false }) },
    };
}

const SESSION_SPECIFIER = "next-auth/next";
const AUTH_SPECIFIER = "@/lib/auth";

let POST: (req: Request) => Promise<Response>;

before(async () => {
    installFakePrisma();

    const originalRequire = Module.prototype.require;
    const hits = new Set<string>();
    (Module.prototype as unknown as { require: (id: string) => unknown }).require = function (
        this: NodeModule,
        id: string
    ) {
        if (id === SESSION_SPECIFIER) {
            hits.add(id);
            return { getServerSession: async () => ({ user: { email: ADMIN_EMAIL } }) };
        }
        if (id === AUTH_SPECIFIER) {
            hits.add(id);
            // The handler only ever passes this through to getServerSession,
            // which is faked above — loading the real NextAuth configuration
            // would drag in provider credentials this test has no business
            // needing.
            return { authOptions: {} };
        }
        // eslint-disable-next-line prefer-rest-params
        return originalRequire.apply(this, arguments as unknown as [string]);
    } as typeof Module.prototype.require;

    let routeModule: { POST?: unknown };
    try {
        routeModule = await import("../src/app/api/users/route");
    } finally {
        Module.prototype.require = originalRequire;
    }

    if (typeof routeModule.POST !== "function") {
        throw new Error(
            `users-create-payroll-body.test.ts: the require() patch did not apply — POST is ` +
                `${typeof routeModule.POST}, and the specifiers hit were [${[...hits].join(", ")}]. ` +
                `If the route's own imports resolve to something other than "${SESSION_SPECIFIER}" / ` +
                `"${AUTH_SPECIFIER}" on this Node/tsx combination, update those constants to match.`
        );
    }
    POST = routeModule.POST as typeof POST;
});

function createRequest(body: Record<string, unknown>) {
    return new Request("https://example.test/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
}

test("the 201 body carries the rate that was committed, not the pre-update snapshot", async () => {
    installFakePrisma();

    const res = await POST(
        createRequest({ name: "New Hire", email: NEW_EMAIL, role: "FIELD_CREW", hourlyRate: "34.50", payType: "HOURLY" })
    );
    assert.equal(res.status, 201);
    const body = (await res.json()) as Record<string, unknown>;

    // The row as the database holds it after the transaction committed.
    assert.ok(row, "the transaction must have created a row");
    const committed = row as Row;

    assert.equal(String(body.hourlyRate), "34.5", "the rate the caller sent, echoed from the committed row");
    assert.equal(body.payType, "HOURLY");
    assert.equal(body.payrollRevision, 1, "applyRateChangeInTx bumps the replay counter — the body must show it");
    assert.ok(body.lastRateSyncAt, "and the confirmation stamp it wrote");

    // Field by field against the committed row, so a future field added to the
    // create cannot quietly go stale in the response the same way.
    for (const field of ["hourlyRate", "payType", "payrollRevision", "lastRateSyncAt"]) {
        assert.equal(
            JSON.stringify(body[field]),
            JSON.stringify(committed[field] instanceof Date ? (committed[field] as Date).toISOString() : committed[field]),
            `${field} in the 201 body must equal the committed row`
        );
    }

    // The rate write really did take its locks inside the same transaction, in
    // the global order: payroll advisory lock first, THEN the owner row.
    assert.deepEqual(
        locked,
        ["advisory:payroll-period", "u-new"],
        "applyRateChangeInTx takes the payroll lock, then locks the owner row it is about to write"
    );
});

test("the pre-update snapshot is genuinely different — this test could fail", async () => {
    // Guard against a fixture that would pass either way: the values the OLD
    // code returned are asserted to be the defaults, so the assertions above are
    // distinguishing two different objects rather than restating one.
    installFakePrisma();
    await POST(createRequest({ email: NEW_EMAIL, hourlyRate: "34.50", payType: "HOURLY" }));

    const committed = row as Row;
    assert.notEqual(committed.hourlyRate, null, "the committed row moved off its defaults");
    assert.equal(committed.payrollRevision, 1);
});

test("a create with no payroll fields still answers with the committed row", async () => {
    // applyRateChangeInTx short-circuits to `{ ok: true, changed: false }` when
    // nothing payroll-related is supplied, so the re-read must simply agree with
    // the create rather than depending on an update having happened.
    installFakePrisma();
    const res = await POST(createRequest({ name: "No Rate", email: NEW_EMAIL, role: "FIELD_CREW" }));
    assert.equal(res.status, 201);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.hourlyRate, null);
    assert.equal(body.payrollRevision, 0);
    assert.deepEqual(locked, [], "and no row lock is taken for a write that touches no rates");
});

test("the handler returns the re-read, never the create's return value", () => {
    // The behavioural tests above run against a fake client; this pins the shape
    // in the source so the fix cannot be undone by handing `created` back again
    // while the fake still happens to agree.
    const source = readFileSync(path.join(__dirname, "..", "src", "app", "api", "users", "route.ts"), "utf8");
    const tx = source.slice(source.indexOf("newUser = await prisma.$transaction"), source.indexOf("} catch (error) {"));
    assert.match(tx, /return tx\.user\.findUniqueOrThrow\(\{ where: \{ id: created\.id \} \}\);/);
    assert.ok(!/\breturn created;/.test(tx), "returning the pre-update snapshot is the bug");
    // And the re-read is INSIDE the transaction, so it cannot observe a
    // half-committed state or another writer's row.
    assert.ok(
        tx.indexOf("applyRateChangeInTx") < tx.indexOf("findUniqueOrThrow"),
        "the re-read must come after the rate write, in the same transaction"
    );
});

test("the 201 body never carries the PIN hash", async () => {
    // POST /api/users answered with a full findUniqueOrThrow row, so the bcrypt
    // hash of the PIN it had just set went straight back out in the response —
    // to a browser, a log, and anything in between (round 8, finding 1). GET
    // /api/users already stripped it; the rule now lives in one helper that
    // every User response uses.
    installFakePrisma();
    const res = await POST(createRequest({ name: "New Hire", email: NEW_EMAIL, pinCode: "1234" }));
    assert.equal(res.status, 201);
    const body = (await res.json()) as Record<string, unknown>;

    assert.ok(!("pinCode" in body), "a credential hash has no audience");
    assert.equal(body.hasPin, true, "the fact the UI actually renders, without the hash");

    // THE CONTROL: the committed row really does hold one, so the assertion
    // above is about the serializer rather than about an absent value.
    assert.ok((row as Row).pinCode, "the fake database stored a hash to leak");
});

test("toSafeUser drops the hash and keeps everything else", async () => {
    const { toSafeUser, toSafeUserOrNull } = await import("../src/lib/user-serialization");
    const safe = toSafeUser({ id: "u1", email: "a@b.c", pinCode: "$2a$10$x", role: "ADMIN" });
    assert.deepEqual(safe, { id: "u1", email: "a@b.c", role: "ADMIN", hasPin: true });
    assert.equal(toSafeUser({ id: "u1", pinCode: null }).hasPin, false);
    assert.equal(toSafeUserOrNull(null), null);
});
