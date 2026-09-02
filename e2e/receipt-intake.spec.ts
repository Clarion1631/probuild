import { test, expect, type APIRequestContext } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

/**
 * POST/GET /api/receipts/intake — request-level auth matrix and idempotency.
 *
 * `/api/receipts/intake` is on the proxy's EXACT-match public bypass
 * (src/proxy.ts), which means the route handler is the only thing standing
 * between an anonymous caller and a write. Source-reading proves nothing about
 * that; these tests drive the real HTTP surface against the throwaway CI
 * Postgres (data.setup.ts guards prod — docs/TESTING.md).
 *
 * Shaped after e2e/portal-estimate-access.spec.ts and
 * e2e/deposit-ingest.spec.ts: every negative case asserts a JSON 401/403 and
 * NOT a 307 to /login, because a redirect is what a machine caller silently
 * mis-reads as "try again later" forever.
 *
 * NOT covered here, deliberately: the "RECEIPT_INTAKE_SECRET is unset" case.
 * A spec cannot unset an env var on the server process it is talking to, so
 * that fail-closed branch is pinned as a unit test instead —
 * tests/receipt-intake-auth.test.ts, "the secret check fails CLOSED when the
 * env var is unset or empty".
 *
 * Auth: RECEIPT_INTAKE_SECRET must be set for the server under test. CI wires
 * it as a literal in .github/workflows/ci.yml (nothing external depends on the
 * value), same pattern as DEPOSIT_INGEST_SECRET.
 */

const prisma = new PrismaClient();
const INTAKE_PATH = "/api/receipts/intake";
const SECRET = process.env.RECEIPT_INTAKE_SECRET || "";

// One prefix for everything this file creates, so teardown can be exact.
const REF_PREFIX = "drive:e2e-intake-";
const FILE_ID = `${Date.now()}-a`;
const SOURCE_REF = `${REF_PREFIX}${FILE_ID}`;

// A real 1x1 PNG: the endpoint decides the stored mime on the BYTES, so a
// placeholder string would be refused (which is itself asserted below).
const PNG_BASE64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function intakeBody(overrides: Record<string, unknown> = {}) {
    return JSON.stringify({
        source: "drive",
        sourceRef: SOURCE_REF,
        fileBase64: PNG_BASE64,
        mimeType: "image/png",
        fileName: "e2e-receipt.png",
        ...overrides,
    });
}

async function postIntake(
    request: APIRequestContext,
    data: string,
    headers: Record<string, string> = { "x-receipt-intake-secret": SECRET },
) {
    const res = await request.post(INTAKE_PATH, {
        headers: { "content-type": "application/json", ...headers },
        data,
        maxRedirects: 0, // a 307 to /login must FAIL this suite, not be followed
    });
    let body: any = null;
    try { body = await res.json(); } catch { /* non-JSON body is itself a failure signal */ }
    return { res, body };
}

test.beforeAll(async () => {
    expect(
        SECRET,
        "RECEIPT_INTAKE_SECRET must be set for the server under test (ci.yml sets it; locally export it before `npm run dev`)",
    ).toBeTruthy();
    await prisma.receiptIntake.deleteMany({ where: { sourceRef: { startsWith: REF_PREFIX } } });
});

test.afterAll(async () => {
    await prisma.receiptIntake.deleteMany({ where: { sourceRef: { startsWith: REF_PREFIX } } });
    await prisma.$disconnect();
});

test.describe("intake auth is fail-closed", () => {
    test("no credentials at all is a JSON 401, never a redirect to /login", async ({ playwright }) => {
        const anonymous = await playwright.request.newContext({
            baseURL: "http://localhost:3000",
            storageState: { cookies: [], origins: [] },
        });
        const { res, body } = await postIntake(anonymous, intakeBody({ sourceRef: `${REF_PREFIX}anon` }), {});
        expect(res.status()).toBe(401);
        expect(res.headers().location, "a redirect here would look like a retryable failure to a bot").toBeUndefined();
        expect(body).toMatchObject({ ok: false, reason: "unauthorized" });
        await anonymous.dispose();
    });

    test("a BOGUS session cookie is 401, not a pass", async ({ playwright }) => {
        // The getclients-auth-gate lesson: a dev-auth fallback (or a gate that
        // only checks for the presence of a cookie) hides exactly this hole.
        const forged = await playwright.request.newContext({
            baseURL: "http://localhost:3000",
            storageState: {
                cookies: [{
                    name: "next-auth.session-token",
                    value: "not-a-real-jwt",
                    domain: "localhost",
                    path: "/",
                    expires: -1,
                    httpOnly: true,
                    secure: false,
                    sameSite: "Lax" as const,
                }],
                origins: [],
            },
        });
        const { res } = await postIntake(forged, intakeBody({ sourceRef: `${REF_PREFIX}bogus` }), {});
        expect(res.status()).toBe(401);
        expect(res.headers().location).toBeUndefined();
        await forged.dispose();
    });

    test("a WRONG secret is refused outright, and does not fall through to the session", async ({ request }) => {
        // `request` carries the ADMIN storage state. A stale forwarder secret
        // must still be a 401 — otherwise a rotated secret would silently keep
        // working from any browser that happened to be signed in.
        const { res, body } = await postIntake(request, intakeBody({ sourceRef: `${REF_PREFIX}wrong` }), {
            "x-receipt-intake-secret": "definitely-not-the-secret",
        });
        expect(res.status()).toBe(401);
        expect(body).toMatchObject({ ok: false, reason: "unauthorized" });
    });

    test("an empty secret header is not a bypass", async ({ playwright }) => {
        const anonymous = await playwright.request.newContext({
            baseURL: "http://localhost:3000",
            storageState: { cookies: [], origins: [] },
        });
        const { res } = await postIntake(anonymous, intakeBody({ sourceRef: `${REF_PREFIX}empty` }), {
            "x-receipt-intake-secret": "",
        });
        expect(res.status()).toBe(401);
        await anonymous.dispose();
    });
});

test.describe("intake POST", () => {
    test("the same sourceRef twice yields ONE row and the SAME id", async ({ request }) => {
        const first = await postIntake(request, intakeBody());
        expect(first.res.status(), JSON.stringify(first.body)).toBe(200);
        expect(first.body.ok).toBe(true);
        expect(first.body.state).toBe("RECEIVED");
        expect(first.body.sourceRef).toBe(SOURCE_REF);
        // Shadow week: dry-run is the default and is captured per row.
        expect(first.body.dryRun).toBe(true);

        const second = await postIntake(request, intakeBody());
        expect(second.res.status()).toBe(200);
        expect(second.body.alreadyReceived).toBe(true);
        expect(second.body.id).toBe(first.body.id);

        const rows = await prisma.receiptIntake.findMany({ where: { sourceRef: SOURCE_REF } });
        expect(rows).toHaveLength(1);
        expect(rows[0].id).toBe(first.body.id);
        expect(rows[0].mimeType).toBe("image/png");
        expect(rows[0].fileSha256).toHaveLength(64);
        expect(rows[0].storagePath).toBe(`receipts/intake/${first.body.id}.png`);
    });

    test("a machine caller MUST supply its own sourceRef", async ({ request }) => {
        const { res, body } = await postIntake(request, JSON.stringify({
            source: "drive", fileBase64: PNG_BASE64, mimeType: "image/png",
        }));
        expect(res.status()).toBe(400);
        expect(body.reason).toBe("missing-sourceRef");
    });

    test("deterministic bad input is a 400, not a 500 the forwarder retries forever", async ({ request }) => {
        const cases: [string, string][] = [
            [intakeBody({ source: "carrier-pigeon", sourceRef: `${REF_PREFIX}src` }), "invalid-source"],
            [JSON.stringify({ source: "drive", sourceRef: `${REF_PREFIX}nofile` }), "missing-file"],
            // Base64 of "hello" — not a document format we can read.
            [intakeBody({ sourceRef: `${REF_PREFIX}junk`, fileBase64: "aGVsbG8=", mimeType: "image/png" }), "unsupported-file-type"],
        ];
        for (const [data, reason] of cases) {
            const { res, body } = await postIntake(request, data);
            expect(res.status(), reason).toBe(400);
            expect(body.reason).toBe(reason);
        }
    });

    test("a declared mime cannot override the bytes", async ({ request }) => {
        // Claiming application/pdf over PNG bytes must store image/png.
        const ref = `${REF_PREFIX}sniff`;
        const { res, body } = await postIntake(request, intakeBody({ sourceRef: ref, mimeType: "application/pdf" }));
        expect(res.status()).toBe(200);
        const row = await prisma.receiptIntake.findUnique({ where: { id: body.id } });
        expect(row?.mimeType).toBe("image/png");
    });
});

test.describe("intake GET", () => {
    test("an ADMIN session can read the queue", async ({ request }) => {
        await postIntake(request, intakeBody({ sourceRef: `${REF_PREFIX}list` }));
        const res = await request.get(`${INTAKE_PATH}?state=RECEIVED&take=200`, { maxRedirects: 0 });
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(body.ok).toBe(true);
        expect(body.rows.some((r: any) => r.sourceRef === `${REF_PREFIX}list`)).toBe(true);
        // The raw model output never leaves the server.
        expect(body.rows[0]).not.toHaveProperty("readJson");
    });

    test("the archive mirror can poll with the shared secret", async ({ playwright }) => {
        const machine = await playwright.request.newContext({
            baseURL: "http://localhost:3000",
            storageState: { cookies: [], origins: [] },
        });
        const res = await machine.get(`${INTAKE_PATH}?state=BOOKED`, {
            headers: { "x-receipt-intake-secret": SECRET },
            maxRedirects: 0,
        });
        expect(res.status()).toBe(200);
        await machine.dispose();
    });

    test("a staff user without a bookkeeping role gets 403, not a redirect", async ({ playwright }) => {
        // contract-user.json is an EMPLOYEE (e2e/auth-contract.setup.ts). An
        // ADMIN session can never reach this branch, so this second storage
        // state IS the test.
        const employee = await playwright.request.newContext({
            baseURL: "http://localhost:3000",
            storageState: "e2e/.auth/contract-user.json",
        });
        const res = await employee.get(INTAKE_PATH, { maxRedirects: 0 });
        expect(res.status()).toBe(403);
        expect(res.headers().location).toBeUndefined();
        await employee.dispose();
    });

    test("no credentials is 401", async ({ playwright }) => {
        const anonymous = await playwright.request.newContext({
            baseURL: "http://localhost:3000",
            storageState: { cookies: [], origins: [] },
        });
        const res = await anonymous.get(INTAKE_PATH, { maxRedirects: 0 });
        expect(res.status()).toBe(401);
        expect(res.headers().location).toBeUndefined();
        await anonymous.dispose();
    });
});

test.describe("archive callback", () => {
    test("it is secret-only and refuses a row that is not BOOKED", async ({ request, playwright }) => {
        const ref = `${REF_PREFIX}archive`;
        const created = await postIntake(request, intakeBody({ sourceRef: ref }));
        expect(created.res.status()).toBe(200);
        const id = created.body.id;

        const anonymous = await playwright.request.newContext({
            baseURL: "http://localhost:3000",
            storageState: { cookies: [], origins: [] },
        });
        const unauthed = await anonymous.post(`${INTAKE_PATH}/${id}/archived`, {
            headers: { "content-type": "application/json" },
            data: JSON.stringify({ driveFileId: "DRIVE1" }),
            maxRedirects: 0,
        });
        expect(unauthed.status()).toBe(401);
        expect(unauthed.headers().location).toBeUndefined();

        // A session, however privileged, is NOT a substitute: only the mirror
        // can know that a file now exists in Drive.
        const sessionAttempt = await request.post(`${INTAKE_PATH}/${id}/archived`, {
            headers: { "content-type": "application/json" },
            data: JSON.stringify({ driveFileId: "DRIVE1" }),
            maxRedirects: 0,
        });
        expect(sessionAttempt.status()).toBe(401);

        const notBooked = await anonymous.post(`${INTAKE_PATH}/${id}/archived`, {
            headers: { "content-type": "application/json", "x-receipt-intake-secret": SECRET },
            data: JSON.stringify({ driveFileId: "DRIVE1" }),
            maxRedirects: 0,
        });
        expect(notBooked.status()).toBe(409);

        await prisma.receiptIntake.update({ where: { id }, data: { state: "BOOKED" } });
        const ok = await anonymous.post(`${INTAKE_PATH}/${id}/archived`, {
            headers: { "content-type": "application/json", "x-receipt-intake-secret": SECRET },
            data: JSON.stringify({ driveFileId: "DRIVE1" }),
            maxRedirects: 0,
        });
        expect(ok.status()).toBe(200);
        const row = await prisma.receiptIntake.findUnique({ where: { id } });
        expect(row?.state).toBe("ARCHIVED");
        expect(row?.archiveDriveFileId).toBe("DRIVE1");

        await anonymous.dispose();
    });

    test("an unknown id is 404", async ({ playwright }) => {
        const machine = await playwright.request.newContext({
            baseURL: "http://localhost:3000",
            storageState: { cookies: [], origins: [] },
        });
        const res = await machine.post(`${INTAKE_PATH}/no-such-row/archived`, {
            headers: { "content-type": "application/json", "x-receipt-intake-secret": SECRET },
            data: JSON.stringify({ driveFileId: "DRIVE1" }),
            maxRedirects: 0,
        });
        expect(res.status()).toBe(404);
        await machine.dispose();
    });
});
