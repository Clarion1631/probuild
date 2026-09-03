/**
 * POST /api/expenses/[id]/receipt and POST /api/expenses/[id]/approve
 * (Codex PR #442 round 35, items 2 and 3).
 *
 * Two holes in the same resource, and the same two causes behind both: a
 * decision taken before the write, and a write that named nothing but an id.
 *
 *   * The RECEIPT upload authorized, then spent however long a 10 MB photo
 *     takes going into storage, then wrote `receiptUrl` by bare id. A
 *     fallback-attributed expense can move to another job in that window, and
 *     two uploads can be in flight at once — so the write could land on a row
 *     the uploader has no access to, and the loser of a race left its object in
 *     the bucket with nothing pointing at it.
 *   * The APPROVE endpoint checked only that somebody was signed in. No
 *     permission, no project, no predicate: any authenticated account that knew
 *     an expense id could stamp any expense on any job "Reviewed", forging the
 *     human sign-off the receipt queue and the job-cost reports rely on.
 *
 * Prisma, the permission reader and Supabase storage are patched at require()
 * time — the same shape as tests/expense-edit-authz.test.ts. No mock.module:
 * CI is Node 20.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

interface FakeUser {
    id: string;
    role: string;
    permissions: Record<string, boolean> | null;
    projectIds: string[];
}

const BUCKET = "project-files";

let currentUser: FakeUser | null;
let storedExpense: Record<string, any> | null;
let updateArgs: { where: Record<string, any>; data: Record<string, unknown> } | null;
/**
 * What the LOCKED estimate read answers, when a test wants it to disagree with
 * the pre-transaction one. `undefined` means "the same fixture", which is every
 * other test.
 */
let lockedEstimateProject: string | null | undefined;
/** Every object currently in the fake bucket, by storage path. */
let objects: Set<string>;
/** A hook that runs between the LOCKED read and the write, to model a writer
 *  that did not take the lock. */
let betweenReadAndWrite: (() => void) | null;

const fakePrisma: any = {
    $transaction: async (fn: any) => fn(fakePrisma),
    $queryRawUnsafe: async (query: string) => {
        if (/FROM "Estimate"/.test(query) && /"projectId"/.test(query)) {
            if (lockedEstimateProject !== undefined) return [{ projectId: lockedEstimateProject }];
            return [{ projectId: storedExpense?.estimate?.projectId ?? null }];
        }
        return [{ lock_result: null }];
    },
    expense: {
        findUnique: async () => {
            const snapshot = storedExpense ? { ...storedExpense } : null;
            return snapshot;
        },
        updateMany: async (args: { where: Record<string, any>; data: Record<string, unknown> }) => {
            betweenReadAndWrite?.();
            const row = storedExpense;
            if (!row) return { count: 0 };
            const eq = (a: unknown, b: unknown) => (a ?? null) === (b ?? null);
            for (const key of ["receiptUrl", "projectId", "status", "qbPurchaseId"]) {
                if (key in args.where && !eq(row[key], args.where[key])) return { count: 0 };
            }
            // The fallback branch of `expenseStillOnProjectWhere`.
            if (args.where.estimate?.is?.projectId !== undefined) {
                if (row.estimate?.projectId !== args.where.estimate.is.projectId) return { count: 0 };
            }
            updateArgs = args;
            Object.assign(row, args.data);
            return { count: 1 };
        },
    },
};

const fakeStorage = {
    from: (bucket: string) => {
        assert.equal(bucket, BUCKET);
        return {
            upload: async (path: string) => {
                objects.add(path);
                return { error: null };
            },
            getPublicUrl: (path: string) => ({
                data: { publicUrl: `https://cdn.test/storage/v1/object/public/${BUCKET}/${path}` },
            }),
            remove: async (paths: string[]) => {
                for (const path of paths) objects.delete(path);
                return { error: null };
            },
        };
    },
};

type Handler = (req: any, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
let uploadReceipt: Handler;
let approve: Handler;

before(async () => {
    const originalRequire = Module.prototype.require;
    (Module.prototype as unknown as { require: (id: string) => unknown }).require = function (
        this: NodeModule,
        id: string,
    ) {
        if (id === "@/lib/prisma") return { prisma: fakePrisma };
        if (id === "@/lib/supabase") {
            return { STORAGE_BUCKET: BUCKET, getSupabase: () => ({ storage: fakeStorage }) };
        }
        if (id === "@/lib/permissions") {
            return {
                getCurrentUserWithPermissions: async () => currentUser,
                hasPermission: (user: FakeUser | null, key: string) =>
                    !!user && (user.role === "ADMIN" || user.permissions?.[key] === true),
                canAccessProject: (user: FakeUser, projectId: string) =>
                    user.role === "ADMIN" || user.projectIds.includes(projectId),
            };
        }
        if (id === "next-auth/next") return { getServerSession: async () => ({ user: { email: "x@y.z" } }) };
        if (id === "@/lib/auth") return { authOptions: {} };
        // eslint-disable-next-line prefer-rest-params
        return originalRequire.apply(this, arguments as unknown as [string]);
    } as typeof Module.prototype.require;

    let receiptMod: any;
    let approveMod: any;
    try {
        receiptMod = await import("../src/app/api/expenses/[id]/receipt/route");
        approveMod = await import("../src/app/api/expenses/[id]/approve/route");
    } finally {
        Module.prototype.require = originalRequire;
    }
    if (typeof receiptMod.POST !== "function" || typeof approveMod.POST !== "function") {
        throw new Error("expense-receipt-approve-authz: mocks did not apply");
    }
    uploadReceipt = receiptMod.POST;
    approve = approveMod.POST;
});

beforeEach(() => {
    currentUser = { id: "u1", role: "MANAGER", permissions: { timeClock: true }, projectIds: ["job-1"] };
    storedExpense = {
        id: "e1",
        qbPurchaseId: null,
        status: "Pending",
        receiptUrl: null,
        projectId: "job-1",
        estimateId: "est-job-1",
        estimate: { projectId: "job-1" },
    };
    updateArgs = null;
    lockedEstimateProject = undefined;
    objects = new Set();
    betweenReadAndWrite = null;
});

/** A minimal `File` the route's own checks accept. */
function receiptFile(name = "receipt.jpg") {
    return new File([new Uint8Array([1, 2, 3, 4])], name, { type: "image/jpeg" });
}

function upload(file: File = receiptFile()) {
    const form = new FormData();
    form.set("file", file);
    return uploadReceipt(
        { formData: async () => form } as any,
        { params: Promise.resolve({ id: "e1" }) },
    );
}

function callApprove() {
    return approve({} as any, { params: Promise.resolve({ id: "e1" }) });
}

// ── item 2: the upload window ──────────────────────────────────────────────

test("a successful upload stores the object and points the row at it", async () => {
    const res = await upload();
    assert.equal(res.status, 200);
    assert.equal(objects.size, 1, "control: the object is kept");
    assert.match((await res.json()).receiptUrl, /storage\/v1\/object\/public/);
    assert.equal(storedExpense?.receiptUrl, updateArgs?.data.receiptUrl);
});

test("an estimate that MOVES mid-upload is refused, and the object is removed", async () => {
    // A fallback-attributed row answers through its estimate, and somebody can
    // re-point that estimate to another job while the photo is going up. The
    // write would then attach a receipt to a job this uploader has never had
    // access to — authorized against the job the row LEFT.
    storedExpense = {
        ...(storedExpense as object), projectId: null,
        estimate: { projectId: "job-1" },
    };
    lockedEstimateProject = "job-2";

    const res = await upload();
    assert.equal(res.status, 403, "the actor has no access to the job it is on NOW");
    assert.equal(updateArgs, null, "nothing is written");
    assert.equal(objects.size, 0, "and no orphan is left behind in storage");
    assert.equal(storedExpense?.receiptUrl, null);
});

test("two concurrent uploads: one wins, the loser's object is removed", async () => {
    // Both wrote `receiptUrl` by bare id, so the later one silently replaced
    // the earlier and the loser's file stayed in the bucket forever with
    // nothing referencing it.
    const winner = "expenses/e1/receipt/9999999999999_winner.jpg";
    betweenReadAndWrite = () => {
        // A writer that did NOT take the lock lands first: it stores its own
        // object and claims the column.
        objects.add(winner);
        storedExpense!.receiptUrl = `https://cdn.test/storage/v1/object/public/${BUCKET}/${winner}`;
        betweenReadAndWrite = null;
    };

    const res = await upload(receiptFile("loser.jpg"));
    assert.equal(res.status, 409, "the loser is told, not silently discarded");
    assert.equal((await res.json()).code, "EXPENSE_REATTRIBUTED");
    assert.deepEqual([...objects], [winner], "only the winner's object survives");
    assert.match(String(storedExpense?.receiptUrl), /winner\.jpg$/, "and the row still points at it");
});

test("replacing an earlier receipt deletes the object it replaced", async () => {
    // The other half of the same rule: when this request DOES win, the object
    // the row used to point at is now unreferenced.
    const old = "expenses/e1/receipt/1111111111111_old.jpg";
    objects.add(old);
    storedExpense!.receiptUrl = `https://cdn.test/storage/v1/object/public/${BUCKET}/${old}`;

    const res = await upload(receiptFile("new.jpg"));
    assert.equal(res.status, 200);
    assert.equal(objects.size, 1, "exactly one object remains");
    assert.ok(!objects.has(old), "and it is not the replaced one");
});

test("a receiptUrl this route does not own is never deleted", async () => {
    // A Drive link, a receipt-intake object under its own bucket, a legacy bare
    // path: the cleanup deletes REAL FILES, and the only ones it is entitled to
    // delete are the ones it created.
    storedExpense!.receiptUrl = "https://drive.google.com/file/d/abc/view";
    objects.add("expenses/OTHER/receipt/keep.jpg");

    const res = await upload();
    assert.equal(res.status, 200);
    assert.ok(objects.has("expenses/OTHER/receipt/keep.jpg"), "another row's object is untouched");
    assert.equal(objects.size, 2, "the new object plus the one it had no business removing");
});

test("the upload still refuses a user with no access to the job", async () => {
    currentUser = { id: "u2", role: "FIELD_CREW", permissions: { timeClock: true }, projectIds: ["other"] };
    const res = await upload();
    assert.equal(res.status, 403);
    assert.equal(objects.size, 0, "and refuses BEFORE anything reaches storage");
});

// ── item 3: approve is not an open door ────────────────────────────────────

test("approve requires the same timeClock permission PUT and DELETE require", async () => {
    currentUser = { id: "u3", role: "FIELD_CREW", permissions: {}, projectIds: ["job-1"] };
    const res = await callApprove();
    assert.equal(res.status, 403);
    assert.equal(updateArgs, null);
    assert.equal(storedExpense?.status, "Pending", "the sign-off is not forged");
});

test("approve refuses an expense on a job the actor cannot access", async () => {
    currentUser = { id: "u4", role: "MANAGER", permissions: { timeClock: true }, projectIds: ["other-job"] };
    const res = await callApprove();
    assert.equal(res.status, 403);
    assert.equal(storedExpense?.status, "Pending");
});

test("approve is 401 with no session, and fails CLOSED with no resolvable job", async () => {
    currentUser = null;
    assert.equal((await callApprove()).status, 401);

    currentUser = { id: "u1", role: "MANAGER", permissions: { timeClock: true }, projectIds: ["job-1"] };
    storedExpense = { ...(storedExpense as object), projectId: null, estimate: { projectId: null } };
    assert.equal((await callApprove()).status, 403, "no scope to authorize against");
});

test("approve authorizes on the job the expense is actually ON, not its estimate's", async () => {
    // A re-attributed expense: the column says job-1, the estimate still says
    // job-2. The job it LEFT confers nothing.
    storedExpense = {
        ...(storedExpense as object), projectId: "job-1", estimate: { projectId: "job-2" },
    };
    currentUser = { id: "u-old", role: "MANAGER", permissions: { timeClock: true }, projectIds: ["job-2"] };
    assert.equal((await callApprove()).status, 403);

    currentUser = { id: "u-new", role: "MANAGER", permissions: { timeClock: true }, projectIds: ["job-1"] };
    assert.equal((await callApprove()).status, 200);
    assert.equal(storedExpense?.status, "Reviewed");
});

test("approve is refused when the row moves between the read and the write", async () => {
    const res = await callApprove();
    assert.equal(res.status, 200, "control");

    storedExpense = { ...(storedExpense as object), status: "Pending" };
    betweenReadAndWrite = () => {
        storedExpense!.projectId = "job-2";
        betweenReadAndWrite = null;
    };
    const stale = await callApprove();
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).code, "EXPENSE_REATTRIBUTED");
    assert.equal(storedExpense?.status, "Pending", "not stamped under a stale permission");
});

test("approve pins the status it was decided FROM", async () => {
    betweenReadAndWrite = () => {
        storedExpense!.status = "Reviewed";
        betweenReadAndWrite = null;
    };
    const stale = await callApprove();
    assert.equal(stale.status, 409, "somebody else's decision is not silently re-stamped");
});

test("approve refuses a QuickBooks-owned expense, before and after the read", async () => {
    storedExpense = { ...(storedExpense as object), qbPurchaseId: "qb-1" };
    const res = await callApprove();
    assert.equal(res.status, 409, "the guard still answers");
    assert.match((await res.json()).error, /QuickBooks/);

    // ...and a Purchase id that lands in the GAP is caught by the predicate.
    storedExpense = { ...(storedExpense as object), qbPurchaseId: null, status: "Pending" };
    betweenReadAndWrite = () => {
        storedExpense!.qbPurchaseId = "qb-2";
        betweenReadAndWrite = null;
    };
    assert.equal((await callApprove()).status, 409);
    assert.equal(storedExpense?.status, "Pending");
});

test("approve takes the shared per-expense lock", async () => {
    const locks: unknown[][] = [];
    const original = fakePrisma.$queryRawUnsafe;
    fakePrisma.$queryRawUnsafe = async (...args: unknown[]) => { locks.push(args); return [{}]; };
    try {
        await callApprove();
        // The attribution PARENTS are share-locked ahead of it (round 40,
        // item 1), so this counts the per-expense lock specifically rather
        // than every raw statement.
        const advisory = locks.filter(call => /pg_advisory_xact_lock/.test(String(call[0])));
        assert.equal(advisory.length, 1, "exactly one per-expense lock");
        assert.equal(advisory[0][1], "expense:e1", "the same key every other writer uses");
        // ...and it comes AFTER them. Expense is LAST in the global order, and
        // this handler taking it first is exactly what round 40 found.
        assert.ok(
            locks.findIndex(call => /FOR SHARE/.test(String(call[0]))) <
                locks.findIndex(call => /pg_advisory_xact_lock/.test(String(call[0]))),
            "the attribution parents are locked before the expense row",
        );
    } finally {
        fakePrisma.$queryRawUnsafe = original;
    }
});

test("a fallback-attributed approve is refused when the estimate MOVES", async () => {
    // The gate BEFORE the transaction and the gate INSIDE it are not the same
    // question, and only this shape tells them apart: the row has no
    // `projectId` of its own, so it answers through its estimate — and somebody
    // re-points that estimate between the two. The pre-check passes against the
    // job it was on; the locked one is the only thing that can see the job it
    // is on NOW.
    storedExpense = {
        ...(storedExpense as object), projectId: null, estimate: { projectId: "job-1" },
    };
    lockedEstimateProject = "job-2";

    const res = await callApprove();
    assert.equal(res.status, 403, "403, not 409: this is a fact about the ACTOR");
    assert.equal(updateArgs, null);
    assert.equal(storedExpense?.status, "Pending", "no sign-off under a stale permission");
});
