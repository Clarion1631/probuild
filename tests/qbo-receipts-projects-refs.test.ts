/**
 * GET /api/integrations/qbo-receipts/projects (PR-2, section G2a of the
 * qbo-bank-only-cutover-plan): adds an ADDITIVE `projectRefs: [{id, name}]`
 * field alongside the existing `projects: [name, ...]` array, so the Apps
 * Script's scanner can resolve a Drive folder name to a real projectId
 * without breaking `reconcileIntakeFolders.js`, which depends on the
 * existing `projects` shape.
 *
 * Prisma is patched at require() time — no `mock.module` (CI is Node 20;
 * see tests/qbo-sync-route-auth.test.ts for why).
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

const PRISMA_SPECIFIER = "@/lib/prisma";

let projectRows: Array<{ id: string; name: string }>;
let findManyThrows: unknown;

const fakePrisma = {
    project: {
        findMany: async () => {
            if (findManyThrows) throw findManyThrows;
            return projectRows;
        },
    },
};

let GET: (req: Request) => Promise<Response>;

before(async () => {
    const originalRequire = Module.prototype.require;
    (Module.prototype as unknown as { require: (id: string) => unknown }).require = function (
        this: NodeModule,
        id: string,
    ) {
        if (id === PRISMA_SPECIFIER) return { prisma: fakePrisma };
        // eslint-disable-next-line prefer-rest-params
        return originalRequire.apply(this, arguments as unknown as [string]);
    } as typeof Module.prototype.require;

    let mod: { GET?: unknown };
    try {
        mod = await import("../src/app/api/integrations/qbo-receipts/projects/route");
    } finally {
        Module.prototype.require = originalRequire;
    }
    if (typeof mod.GET !== "function") {
        throw new Error("qbo-receipts/projects: mock did not apply — GET export is " + typeof mod.GET);
    }
    GET = mod.GET as any;
});

beforeEach(() => {
    process.env.RECEIPT_INGEST_SECRET = "test-secret";
    projectRows = [
        { id: "proj-b", name: "Berg ADU" },
        { id: "proj-a", name: "Adkins Kitchen" },
    ];
    findManyThrows = null;
});

function request(key?: string) {
    const headers = new Headers();
    if (key !== undefined) headers.set("x-ingest-key", key);
    return new Request("http://localhost/api/integrations/qbo-receipts/projects", { headers }) as any;
}

test("no key: 401, unauthorized, before any Prisma call", async () => {
    delete process.env.RECEIPT_INGEST_SECRET;
    const res = await GET(request());
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { ok: false, reason: "unauthorized" });
});

test("wrong key: 401, unauthorized", async () => {
    const res = await GET(request("wrong"));
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { ok: false, reason: "unauthorized" });
});

test("correct key: 200 with the EXISTING `projects` shape unchanged", async () => {
    const res = await GET(request("test-secret"));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    // Order and shape preserved exactly as reconcileIntakeFolders.js expects:
    // a flat array of names, already sorted by the query.
    assert.deepEqual(body.projects, ["Berg ADU", "Adkins Kitchen"]);
});

test("correct key: 200 with the NEW additive `projectRefs` field", async () => {
    const res = await GET(request("test-secret"));
    const body = await res.json();
    assert.deepEqual(body.projectRefs, [
        { id: "proj-b", name: "Berg ADU" },
        { id: "proj-a", name: "Adkins Kitchen" },
    ]);
});

test("`projects` and `projectRefs` stay in the same order, one-to-one", async () => {
    const res = await GET(request("test-secret"));
    const body = await res.json();
    assert.equal(body.projects.length, body.projectRefs.length);
    body.projects.forEach((name: string, i: number) => {
        assert.equal(body.projectRefs[i].name, name);
    });
});

test("an empty project list returns both fields as empty arrays, not omitted", async () => {
    projectRows = [];
    const res = await GET(request("test-secret"));
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.deepEqual(body.projects, []);
    assert.deepEqual(body.projectRefs, []);
});

test("a list failure still answers 500/list-failed — unchanged by the additive field", async () => {
    findManyThrows = new Error("connection reset");
    const res = await GET(request("test-secret"));
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { ok: false, reason: "list-failed" });
});
