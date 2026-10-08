/**
 * Clearing a client's "Email 2 (spouse / partner)" must persist NULL.
 *
 * The bug: on /leads/[id] Client Details, clearing Email 2 and saving brought
 * the old address back. The sidebar sent `cAdditionalEmail || undefined` and
 * updateClient wrote `data.additionalEmail || undefined`, so "" became
 * `undefined` and Prisma skipped the column. Every client email then kept CC'ing
 * the address staff had just removed.
 *
 * Both write paths are checked against a REAL PostgreSQL: the updateClient
 * server action and PUT /api/clients/[id]. Opt-in by URL like the other DB tests
 * here, so a normal unit run never touches a developer database. Prisma is
 * patched to a client on that URL, and auth/next are stubbed at require() time
 * (same shape as tests/estimate-delete-receipt-guard.test.ts). Fixture data is
 * generic; the repo is public.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

const databaseUrl = process.env.PAYROLL_LOCK_TEST_URL;
const looksLikeProd = !!databaseUrl && /supabase\.(co|com)|ghzdbzdnwjxazvmcefbh/i.test(databaseUrl);
const skip = !databaseUrl
    ? "set PAYROLL_LOCK_TEST_URL to a disposable PostgreSQL URL"
    : looksLikeProd
        ? "refusing to run against what looks like production"
        : false;

const OLD = "old-partner@example.test";
const PRIMARY = "primary@example.test";

test("LeadDetailsSidebar sends a cleared Email 2 instead of dropping it", () => {
    const src = readFileSync("src/app/leads/[id]/LeadDetailsSidebar.tsx", "utf8");
    assert.ok(!src.includes("cAdditionalEmail || undefined"), "\"\" must reach the server, not become undefined");
    assert.ok(src.includes("additionalEmail: cAdditionalEmail.trim(),"));
});

async function importWith<T>(stubs: Record<string, unknown>, load: () => Promise<T>): Promise<T> {
    const originalRequire = Module.prototype.require;
    (Module.prototype as unknown as { require: (id: string) => unknown }).require = function (this: NodeModule, id: string) {
        if (Object.prototype.hasOwnProperty.call(stubs, id)) return stubs[id];
        // eslint-disable-next-line prefer-rest-params
        return originalRequire.apply(this, arguments as unknown as [string]);
    } as typeof Module.prototype.require;
    try {
        return await load();
    } finally {
        Module.prototype.require = originalRequire;
    }
}

const nextStubs = {
    "next/cache": { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (fn: unknown) => fn },
    "next/headers": { headers: () => new Map(), cookies: () => ({ getAll: () => [] }) },
    "next-auth": { getServerSession: async () => null },
};

const STAFF = { id: "staff-1", role: "ADMIN" };
const permissionsStub = {
    getCurrentUserWithPermissions: async () => STAFF,
    currentStaffUserOrNull: async () => STAFF,
    hasPermission: () => true,
    canAccessProject: () => true,
    canAccessEstimate: () => true,
    canCreateContractFor: () => true,
    canAccessContract: () => true,
    contractScopeWhere: () => ({}),
    estimateScopeWhere: () => ({}),
    estimateTotalsAreComplete: () => true,
    canWriteDocumentTemplateType: () => true,
    canUseDevAuthFallback: () => false,
    getUserWithPermissionsByEmail: async () => null,
    isAdminOrManager: () => true,
    PortalAuthError: class extends Error {},
};

type UpdateClient = (id: string, data: { name?: string; email?: string; additionalEmail?: string | null }) => Promise<unknown>;
type PutRoute = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

let db: PrismaClient | null = null;
let updateClient: UpdateClient | null = null;
let PUT: PutRoute | null = null;

function testDb() {
    db ??= new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    return db;
}

async function loadUpdateClient(): Promise<UpdateClient> {
    if (updateClient) return updateClient;
    const prismaStub = { prisma: testDb() };
    const mod = await importWith({
        ...nextStubs,
        "next/server": { after: (fn: () => unknown) => fn() },
        "@/lib/prisma": prismaStub,
        "./prisma": prismaStub,
        "@/lib/permissions": permissionsStub,
        "./permissions": permissionsStub,
        "next-auth/next": { getServerSession: async () => null },
    }, () => import("../src/lib/actions"));
    if (typeof mod.updateClient !== "function") throw new Error("client-additional-email-clear-db: mocks did not apply");
    updateClient = mod.updateClient as UpdateClient;
    return updateClient;
}

async function loadPut(): Promise<PutRoute> {
    if (PUT) return PUT;
    const real = testDb();
    // The route's manager check reads prisma.user; the client write is real.
    const routePrisma = { user: { findUnique: async () => ({ role: "MANAGER" }) }, client: real.client };
    const mod = await importWith({
        ...nextStubs,
        "@/lib/prisma": { prisma: routePrisma },
        "@/lib/auth": { authOptions: {} },
        "next-auth/next": { getServerSession: async () => ({ user: { email: "manager@example.test" } }) },
    }, () => import("../src/app/api/clients/[id]/route"));
    PUT = mod.PUT as PutRoute;
    return PUT;
}

async function withClient(tag: string, body: (id: string) => Promise<void>) {
    const client = await testDb().client.create({
        data: { name: `Email2 Clear ${tag}`, initials: "EC", email: PRIMARY, additionalEmail: OLD },
    });
    try {
        await body(client.id);
    } finally {
        await testDb().client.deleteMany({ where: { id: client.id } }).catch(() => {});
    }
}

const read = (id: string) => testDb().client.findUniqueOrThrow({ where: { id }, select: { email: true, additionalEmail: true } });
const reset = (id: string) => testDb().client.update({ where: { id }, data: { additionalEmail: OLD } });

after(async () => {
    await db?.$disconnect();
});

test("updateClient: omitted key leaves Email 2, a new address replaces it, blank clears it", { skip }, async () => {
    const update = await loadUpdateClient();
    await withClient(`a${Date.now()}`, async (id) => {
        await update(id, { name: "Email2 Clear renamed" });
        assert.deepEqual(await read(id), { email: PRIMARY, additionalEmail: OLD }, "key omitted -> unchanged");

        await update(id, { additionalEmail: "new@example.com" });
        assert.deepEqual(await read(id), { email: PRIMARY, additionalEmail: "new@example.com" });

        await update(id, { additionalEmail: "" });
        assert.deepEqual(await read(id), { email: PRIMARY, additionalEmail: null }, "\"\" -> null");

        await reset(id);
        await update(id, { additionalEmail: "   " });
        assert.deepEqual(await read(id), { email: PRIMARY, additionalEmail: null }, "whitespace -> null");
    });
});

test("PUT /api/clients/[id]: omitted key leaves Email 2, a new address replaces it, blank clears it", { skip }, async () => {
    const put = await loadPut();
    await withClient(`b${Date.now()}`, async (id) => {
        const send = async (body: Record<string, unknown>) => {
            const res = await put(
                new Request(`https://probuild.test/api/clients/${id}`, { method: "PUT", body: JSON.stringify(body) }),
                { params: Promise.resolve({ id }) },
            );
            assert.equal(res.status, 200, await res.clone().text());
        };

        await send({ name: "Email2 Clear renamed" });
        assert.deepEqual(await read(id), { email: PRIMARY, additionalEmail: OLD }, "key omitted -> unchanged");

        await send({ additionalEmail: "new@example.com" });
        assert.deepEqual(await read(id), { email: PRIMARY, additionalEmail: "new@example.com" });

        await send({ additionalEmail: "" });
        assert.deepEqual(await read(id), { email: PRIMARY, additionalEmail: null }, "\"\" -> null");

        await reset(id);
        await send({ additionalEmail: "   " });
        assert.deepEqual(await read(id), { email: PRIMARY, additionalEmail: null }, "whitespace -> null");
    });
});
