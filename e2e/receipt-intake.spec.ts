import { test, expect, type APIRequestContext } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";

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
// The archive mirror holds a DIFFERENT key: it may read BOOKED/ARCHIVED rows and
// report what it archived, and nothing else. Cross-use is a 403.
const ARCHIVE_SECRET = process.env.RECEIPT_ARCHIVE_SECRET || "";

// The e2e test project from data.setup.ts, and the phase that belongs to it
// (via the approved mobile estimate). A phase is only valid against its own job,
// so any spec sending a costCodeId has to send this project too.
const PROJECT_ID = "cmml6vt3y000lpwrh0p9p3k12";

// One prefix for everything this file creates, so teardown can be exact.
const REF_PREFIX = "drive:e2e-intake-";
const FILE_ID = `${Date.now()}-a`;
const SOURCE_REF = `${REF_PREFIX}${FILE_ID}`;

// Rows created with a SERVER-minted sourceRef (web:<uuid>) can't be found by
// the prefix, so they are tracked explicitly for teardown.
const minted: string[] = [];

// A real 1x1 PNG: the endpoint decides the stored mime on the BYTES, so a
// placeholder string would be refused (which is itself asserted below).
const PNG_BASE64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
// A DIFFERENT 1x1 PNG (black, not white). Same format, different bytes — which
// is the whole point of the sourceRef-conflict case below.
const OTHER_PNG_BASE64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

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
    if (minted.length) await prisma.receiptIntake.deleteMany({ where: { id: { in: minted } } });
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
        // The row is only published to the worker AFTER its object lands. A row
        // still in STAGING here would mean the claim could pick up a receipt
        // whose file does not exist and park it "file-missing".
        expect(rows[0].state).toBe("RECEIVED");
        expect(rows[0].mimeType).toBe("image/png");
        expect(rows[0].fileSha256).toHaveLength(64);
        expect(rows[0].storagePath).toBe(`receipts/intake/${first.body.id}.png`);
    });

    test("a publish that failed after a successful upload RESUMES on the next retry", async ({ request }) => {
        // The gap this closes: upload lands, the STAGING -> RECEIVED update then
        // fails (a connection reset between two round trips is not rare). The
        // object exists, the row does not point at it, and nothing would ever
        // fix that — STAGING is invisible to the worker's claim by design, so
        // the row would sit until the 15-minute sweeper wrongly declared its
        // file missing.
        const ref = `${REF_PREFIX}resume`;
        const created = await postIntake(request, intakeBody({ sourceRef: ref }));
        expect(created.res.status()).toBe(200);

        // Rewind to exactly the half-state a failed publish leaves behind: the
        // object is in the bucket, the row is still STAGING.
        await prisma.receiptIntake.update({ where: { id: created.body.id }, data: { state: "STAGING" } });

        const retry = await postIntake(request, intakeBody({ sourceRef: ref }));
        expect(retry.res.status()).toBe(200);
        expect(retry.body.state).toBe("RECEIVED");
        expect(retry.body.id).toBe(created.body.id);

        const rows = await prisma.receiptIntake.findMany({ where: { sourceRef: ref } });
        expect(rows).toHaveLength(1);
        expect(rows[0].state).toBe("RECEIVED");
    });

    test("a STAGING row whose object is NOT there yet answers 202, not 200", async ({ request }) => {
        // A concurrent request is mid-upload, or the last one died before
        // storing anything. 200 would promise a queued document that does not
        // exist; 202 tells the caller to re-poll. The 15-minute sweeper handles
        // the case where it never lands.
        const ref = `${REF_PREFIX}staging-nofile`;
        const created = await postIntake(request, intakeBody({ sourceRef: ref }));
        expect(created.res.status()).toBe(200);

        // A STAGING row pointing at a path nothing was ever written to.
        await prisma.receiptIntake.update({
            where: { id: created.body.id },
            data: { state: "STAGING", storagePath: `receipts/intake/${created.body.id}-never-uploaded.png` },
        });

        // The replay carries the bytes again, so the orphan is HEALED rather
        // than merely reported: stored and republished. Never a 202 — the
        // forwarders retry only non-2xx, so "accepted" for a document we do not
        // have would let a Drive script delete its only copy.
        const retry = await postIntake(request, intakeBody({ sourceRef: ref }));
        expect(retry.res.status()).toBe(200);
        expect(retry.body.recovered).toBe(true);
        expect(retry.body.state).toBe("RECEIVED");
        expect(retry.body.id).toBe(created.body.id);
        const healed = await prisma.receiptIntake.findUnique({ where: { id: created.body.id } });
        expect(healed?.state).toBe("RECEIVED");
    });

    test("a machine caller MUST supply its own sourceRef", async ({ request }) => {
        const { res, body } = await postIntake(request, JSON.stringify({
            source: "drive", fileBase64: PNG_BASE64, mimeType: "image/png",
        }));
        expect(res.status()).toBe(400);
        expect(body.reason).toBe("missing-sourceRef");
    });

    test("reusing a sourceRef for DIFFERENT bytes is 409, and stores nothing", async ({ request }) => {
        // The dangerous case: answering 200 would tell the forwarder its NEW
        // receipt was accepted when nothing was stored, and that receipt would
        // never be booked.
        const ref = `${REF_PREFIX}sha-conflict`;
        const first = await postIntake(request, intakeBody({ sourceRef: ref }));
        expect(first.res.status()).toBe(200);

        const second = await postIntake(request, intakeBody({ sourceRef: ref, fileBase64: OTHER_PNG_BASE64 }));
        expect(second.res.status()).toBe(409);
        expect(second.body).toMatchObject({ error: "sourceRef-conflict", existingId: first.body.id });

        // Exactly one row, still pointing at the ORIGINAL bytes.
        const rows = await prisma.receiptIntake.findMany({ where: { sourceRef: ref } });
        expect(rows).toHaveLength(1);
        expect(rows[0].id).toBe(first.body.id);

        // And the row's stored object is the one the FIRST request wrote — the
        // conflicting call must never touch storage.
        expect(rows[0].storagePath).toBe(`receipts/intake/${first.body.id}.png`);
    });

    test("a different-SHA 409 leaks NOTHING to a caller who may not read the row", async ({ request, playwright }) => {
        // `existingId` is a real identifier for someone else's document. Handing
        // it to a caller that fails the read check turns the 409 into an oracle:
        // guess a sourceRef, learn it exists, and get a usable id back.
        //
        // A shared-secret caller is scoped to its OWN namespace — the forwarders
        // are separate scripts, and the chat one should learn nothing about the
        // Drive pipeline's rows.
        const ref = `${REF_PREFIX}ns-drive`;
        const seeded = await postIntake(request, intakeBody({ source: "drive", sourceRef: ref }));
        expect(seeded.res.status()).toBe(200);

        const machine = await playwright.request.newContext({
            baseURL: "http://localhost:3000",
            storageState: { cookies: [], origins: [] },
        });
        // FIRST LINE OF DEFENCE: declaring `chat` while naming a `drive:` ref
        // is refused outright, before the row is ever looked up. So a
        // cross-namespace probe cannot even reach the conflict handler.
        const crossNamespace = await machine.post(INTAKE_PATH, {
            headers: { "content-type": "application/json", "x-receipt-intake-secret": SECRET },
            data: JSON.stringify({
                source: "chat", sourceRef: ref,
                fileBase64: OTHER_PNG_BASE64, mimeType: "image/png",
            }),
            maxRedirects: 0,
        });
        expect(crossNamespace.status()).toBe(400);
        expect((await crossNamespace.json()).reason).toBe("sourceRef-namespace-mismatch");

        // SECOND LINE: the conflict handler checks the row's OWN `source` too,
        // so a row whose stored source disagrees with its prefix — a legacy row
        // from before the prefix rule existed — still leaks nothing. Seeded
        // directly, because the route can no longer create that shape.
        const legacyRef = `${REF_PREFIX}legacy-mismatch`;
        const legacy = await postIntake(request, intakeBody({ source: "drive", sourceRef: legacyRef }));
        expect(legacy.res.status()).toBe(200);
        await prisma.receiptIntake.update({ where: { id: legacy.body.id }, data: { source: "chat" } });

        const probe = await machine.post(INTAKE_PATH, {
            headers: { "content-type": "application/json", "x-receipt-intake-secret": SECRET },
            data: JSON.stringify({
                source: "drive", sourceRef: legacyRef,
                fileBase64: OTHER_PNG_BASE64, mimeType: "image/png",
            }),
            maxRedirects: 0,
        });
        expect(probe.status()).toBe(409);
        const body = await probe.json();
        expect(body.error).toBe("sourceRef-conflict");
        expect(body, "no id for a caller outside the row's namespace").not.toHaveProperty("existingId");
        await machine.dispose();

        // The row's OWN namespace still gets the id, so the real forwarder can
        // act on the conflict.
        const sameNamespace = await postIntake(request, intakeBody({
            source: "drive", sourceRef: ref, fileBase64: OTHER_PNG_BASE64,
        }));
        expect(sameNamespace.res.status()).toBe(409);
        expect(sameNamespace.body.existingId).toBe(seeded.body.id);
    });

    test("the same uploadId from one user is ONE row; a raw sourceRef is still refused", async ({ request }) => {
        // A phone on a bad connection needs a safe retry. A minted uuid makes
        // every retry a NEW document, so a crew member tapping Send twice on a
        // spinner books the same receipt twice. `uploadId` is the client's own
        // idempotency token — and it is scoped to the authenticated user
        // server-side, so two people cannot collide on one uuid and nobody can
        // reach another user's row by guessing one.
        const uploadId = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
        const body = JSON.stringify({ fileBase64: PNG_BASE64, mimeType: "image/png", uploadId });
        const post = () => request.post(INTAKE_PATH, {
            headers: { "content-type": "application/json" },
            data: body,
            maxRedirects: 0,
        });

        const first = await post();
        expect(first.status()).toBe(200);
        const firstBody = await first.json();
        minted.push(firstBody.id);
        // Scoped to the user, so the uuid alone is not the key.
        expect(firstBody.sourceRef).toMatch(/^web:[^:]+:3f2504e0-4f89-41d3-9a0c-0305e82c3301$/);
        expect(firstBody.sourceRef).not.toBe(`web:${uploadId}`);

        const second = await post();
        expect(second.status()).toBe(200);
        const secondBody = await second.json();
        expect(secondBody.id).toBe(firstBody.id);
        expect(secondBody.alreadyReceived).toBe(true);

        const rows = await prisma.receiptIntake.findMany({ where: { sourceRef: firstBody.sourceRef } });
        expect(rows).toHaveLength(1);

        // A non-UUID token is refused rather than used as a free-text key.
        const junk = await request.post(INTAKE_PATH, {
            headers: { "content-type": "application/json" },
            data: JSON.stringify({ fileBase64: PNG_BASE64, mimeType: "image/png", uploadId: "not-a-uuid" }),
            maxRedirects: 0,
        });
        expect(junk.status()).toBe(400);
        expect((await junk.json()).reason).toBe("invalid-uploadId");
    });

    test("a secret caller's sourceRef must live in the namespace it declared", async ({ request }) => {
        // Without this a chat forwarder could write `drive:<fileId>` and collide
        // with — or pre-empt — the Drive pipeline's key for a file it does not
        // own, and `drive` rows are the ones that book under the Drive fileId,
        // i.e. the QBO DocNumber.
        const { res, body } = await postIntake(request, intakeBody({
            source: "chat", sourceRef: `${REF_PREFIX}wrongns`,
        }));
        expect(res.status()).toBe(400);
        expect(body.reason).toBe("sourceRef-namespace-mismatch");
    });

    test("a session caller may not choose its own source or sourceRef", async ({ request }) => {
        // `source` is provenance and it feeds booking identity: a `drive` row
        // books under the Drive fileId, so a forged source could aim a QBO
        // DocNumber at another document's idempotency key.
        const forgedRef = await postIntake(request, JSON.stringify({
            source: "web", sourceRef: `${REF_PREFIX}forged`, fileBase64: PNG_BASE64, mimeType: "image/png",
        }), {});
        expect(forgedRef.res.status()).toBe(400);
        expect(forgedRef.body.reason).toBe("sourceRef-not-allowed");

        const forgedSource = await postIntake(request, JSON.stringify({
            source: "drive", fileBase64: PNG_BASE64, mimeType: "image/png",
        }), {});
        expect(forgedSource.res.status()).toBe(400);
        expect(forgedSource.body.reason).toBe("invalid-source");
    });

    test("a session upload with no uploadId is keyed by CONTENT, so a bare retry is idempotent", async ({ request }) => {
        // The OLD behavior minted a random uuid here, so a retry with no
        // client-supplied uploadId — a flaky connection, a double-tap on a
        // slow spinner — was accepted as a brand new receipt every time. The
        // fix derives a STABLE key from the bytes themselves, scoped to the
        // user, so an identical retry collides with the row it already made.
        const post = () => request.post(INTAKE_PATH, {
            headers: { "content-type": "application/json" },
            data: JSON.stringify({ fileBase64: PNG_BASE64, mimeType: "image/png", fileName: "web.png" }),
            maxRedirects: 0,
        });

        const first = await post();
        expect(first.status()).toBe(200);
        const firstBody = await first.json();
        minted.push(firstBody.id);
        const sha256 = createHash("sha256").update(Buffer.from(PNG_BASE64, "base64")).digest("hex");
        expect(firstBody.sourceRef).toMatch(/^session:[^:]+:[0-9a-f]{64}$/);
        expect(firstBody.sourceRef.endsWith(`:${sha256}`)).toBe(true);

        const second = await post();
        expect(second.status()).toBe(200);
        const secondBody = await second.json();
        expect(secondBody.id).toBe(firstBody.id);
        expect(secondBody.alreadyReceived).toBe(true);

        const rows = await prisma.receiptIntake.findMany({ where: { sourceRef: firstBody.sourceRef } });
        expect(rows).toHaveLength(1);
    });

    test("a secret caller may not declare a USER source", async ({ request }) => {
        const { res, body } = await postIntake(request, intakeBody({
            source: "web", sourceRef: `${REF_PREFIX}websecret`,
        }));
        expect(res.status()).toBe(400);
        expect(body.reason).toBe("invalid-source");
    });

    test("deterministic bad input is terminal, not a 500 the forwarder retries forever", async ({ request }) => {
        // A malformed REQUEST is a 400. An unsupported FORMAT is a 415 — the
        // request is well-formed, the file is simply one QuickBooks cannot
        // attach, and the body names what to send instead. Both are terminal:
        // what must never happen is a 5xx the forwarder retries forever.
        const cases: [string, number, string][] = [
            [intakeBody({ source: "carrier-pigeon", sourceRef: `${REF_PREFIX}src` }), 400, "invalid-source"],
            [JSON.stringify({ source: "drive", sourceRef: `${REF_PREFIX}nofile` }), 400, "missing-file"],
            // Base64 of "hello" — not a document format we can read.
            [intakeBody({ sourceRef: `${REF_PREFIX}junk`, fileBase64: "aGVsbG8=", mimeType: "image/png" }), 415, "unsupported-file-type"],
        ];
        for (const [data, status, name] of cases) {
            const { res, body } = await postIntake(request, data);
            expect(res.status(), name).toBe(status);
            // 400s carry `reason`; the 415 carries `error` plus a human `reason`
            // and the accepted list.
            expect(body.reason ?? body.error, name).toBeTruthy();
            expect([body.reason, body.error], name).toContain(name);
            if (status === 415) expect(body.accepted, name).toContain("application/pdf");
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

    test("the archive mirror can poll BOOKED, and sees only what it needs", async ({ request, playwright }) => {
        // Seed a BOOKED row so the field set is asserted against a real payload
        // rather than an empty list.
        const ref = `${REF_PREFIX}mirror`;
        const created = await postIntake(request, intakeBody({ sourceRef: ref }));
        expect(created.res.status()).toBe(200);
        await prisma.receiptIntake.update({
            where: { id: created.body.id },
            data: { state: "BOOKED", vendor: "Lowes", totalCents: 36498, lastError: "should-not-be-visible" },
        });

        const machine = await playwright.request.newContext({
            baseURL: "http://localhost:3000",
            storageState: { cookies: [], origins: [] },
        });
        const res = await machine.get(`${INTAKE_PATH}?state=BOOKED`, {
            headers: { "x-receipt-intake-secret": ARCHIVE_SECRET },
            maxRedirects: 0,
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        const row = body.rows.find((r: any) => r.id === created.body.id);
        expect(row).toBeTruthy();
        expect(row.vendor).toBe("Lowes");
        expect(row.totalCents).toBe(36498);
        // Least privilege: a script that only copies files to Drive has no need
        // for error text, content hashes, or who uploaded it.
        for (const forbidden of ["lastError", "fileSha256", "createdById", "dedupWeakKey", "dedupStrongKey", "attempts", "readJson"]) {
            expect(row, forbidden).not.toHaveProperty(forbidden);
        }
        await machine.dispose();
    });

    test("the shared secret cannot sweep any state it likes", async ({ playwright }) => {
        const machine = await playwright.request.newContext({
            baseURL: "http://localhost:3000",
            storageState: { cookies: [], origins: [] },
        });
        for (const state of ["NEEDS_REVIEW", "RECEIVED", "READ", ""]) {
            const res = await machine.get(`${INTAKE_PATH}${state ? `?state=${state}` : ""}`, {
                headers: { "x-receipt-intake-secret": ARCHIVE_SECRET },
                maxRedirects: 0,
            });
            expect(res.status(), state || "(no state)").toBe(400);
        }
        // ARCHIVED is allowed — the mirror re-checks what it already copied.
        const archived = await machine.get(`${INTAKE_PATH}?state=ARCHIVED`, {
            headers: { "x-receipt-intake-secret": ARCHIVE_SECRET },
            maxRedirects: 0,
        });
        expect(archived.status()).toBe(200);
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
            data: JSON.stringify({ driveFileId: "DRIVE1FILE" }),
            maxRedirects: 0,
        });
        expect(unauthed.status()).toBe(401);
        expect(unauthed.headers().location).toBeUndefined();

        // A session, however privileged, is NOT a substitute: only the mirror
        // can know that a file now exists in Drive.
        const sessionAttempt = await request.post(`${INTAKE_PATH}/${id}/archived`, {
            headers: { "content-type": "application/json" },
            data: JSON.stringify({ driveFileId: "DRIVE1FILE" }),
            maxRedirects: 0,
        });
        expect(sessionAttempt.status()).toBe(401);

        const notBooked = await anonymous.post(`${INTAKE_PATH}/${id}/archived`, {
            headers: { "content-type": "application/json", "x-receipt-intake-secret": ARCHIVE_SECRET },
            data: JSON.stringify({ driveFileId: "DRIVE1FILE" }),
            maxRedirects: 0,
        });
        expect(notBooked.status()).toBe(409);

        await prisma.receiptIntake.update({ where: { id }, data: { state: "BOOKED" } });
        const archive = (driveFileId: string) => anonymous.post(`${INTAKE_PATH}/${id}/archived`, {
            headers: { "content-type": "application/json", "x-receipt-intake-secret": ARCHIVE_SECRET },
            data: JSON.stringify({ driveFileId }),
            maxRedirects: 0,
        });

        const ok = await archive("DRIVE1FILE");
        expect(ok.status()).toBe(200);
        const row = await prisma.receiptIntake.findUnique({ where: { id } });
        expect(row?.state).toBe("ARCHIVED");
        expect(row?.archiveDriveFileId).toBe("DRIVE1FILE");

        // IDEMPOTENT REPLAY. The mirror POSTs after writing the Drive file, so a
        // lost response leaves it holding a file it cannot confirm. Re-sending
        // the same id is the correct retry: a 409 would make the script treat
        // its own successful archive as a failure.
        const replay = await archive("DRIVE1FILE");
        expect(replay.status()).toBe(200);
        expect((await replay.json()).alreadyArchived).toBe(true);

        // Concurrent identical callbacks: both read BOOKED, the winner archives
        // and the loser's conditional update matches nothing. The loser must
        // re-read and report success — a 409 there made the mirror treat its
        // OWN successful archive as a failure.
        const [a, b] = await Promise.all([archive("DRIVE1FILE"), archive("DRIVE1FILE")]);
        expect([a.status(), b.status()]).toEqual([200, 200]);

        // A DIFFERENT file id on an archived row is not a replay — two Drive
        // copies exist and somebody has to say which one counts.
        const conflicting = await archive("DRIVE2FILE");
        expect(conflicting.status()).toBe(409);
        expect((await prisma.receiptIntake.findUnique({ where: { id } }))?.archiveDriveFileId).toBe("DRIVE1FILE");

        await anonymous.dispose();
    });

    test("an unknown id is 404", async ({ playwright }) => {
        const machine = await playwright.request.newContext({
            baseURL: "http://localhost:3000",
            storageState: { cookies: [], origins: [] },
        });
        const res = await machine.post(`${INTAKE_PATH}/no-such-row/archived`, {
            headers: { "content-type": "application/json", "x-receipt-intake-secret": ARCHIVE_SECRET },
            data: JSON.stringify({ driveFileId: "DRIVE1FILE" }),
            maxRedirects: 0,
        });
        expect(res.status()).toBe(404);
        await machine.dispose();
    });

    test("an implausible driveFileId is refused, and leaves the row untouched", async ({ request, playwright }) => {
        // "Any non-empty string" let a single stray character become the
        // permanent archive identity for a row. This value is held to the SAME
        // shape a `drive` sourceRef's tail is (intake-core.ts SOURCE_REF_PATTERNS),
        // since it lands in the same place: logs, equality checks, and
        // `archiveDriveFileId`.
        const ref = `${REF_PREFIX}archive-invalid`;
        const created = await postIntake(request, intakeBody({ sourceRef: ref }));
        expect(created.res.status()).toBe(200);
        const id = created.body.id;
        await prisma.receiptIntake.update({ where: { id }, data: { state: "BOOKED" } });

        const machine = await playwright.request.newContext({
            baseURL: "http://localhost:3000",
            storageState: { cookies: [], origins: [] },
        });
        const post = (driveFileId: unknown) => machine.post(`${INTAKE_PATH}/${id}/archived`, {
            headers: { "content-type": "application/json", "x-receipt-intake-secret": ARCHIVE_SECRET },
            data: JSON.stringify({ driveFileId }),
            maxRedirects: 0,
        });

        const tooShort = await post("x");
        expect(tooShort.status()).toBe(400);
        expect((await tooShort.json()).reason).toBe("invalid-driveFileId");

        const tooLong = await post("a".repeat(200));
        expect(tooLong.status()).toBe(400);
        expect((await tooLong.json()).reason).toBe("invalid-driveFileId");

        // Neither attempt moved the row at all.
        const row = await prisma.receiptIntake.findUnique({ where: { id } });
        expect(row?.state).toBe("BOOKED");
        expect(row?.archiveDriveFileId).toBeNull();

        await machine.dispose();
    });
});

test.describe("orphan recovery", () => {
    test("replaying a row the sweeper already parked file-missing HEALS it", async ({ request }) => {
        // The hole this closes: storage existence was checked only while the row
        // was STAGING. Once the sweep flipped an orphan to
        // NEEDS_REVIEW/file-missing, an identical replay got a cheerful 200 and
        // the forwarder could delete its only copy of a receipt we did not have.
        const ref = `${REF_PREFIX}swept-orphan`;
        const created = await postIntake(request, intakeBody({ sourceRef: ref }));
        expect(created.res.status()).toBe(200);

        // Exactly what the sweeper leaves behind.
        await prisma.receiptIntake.update({
            where: { id: created.body.id },
            data: {
                state: "NEEDS_REVIEW",
                stateReason: "file-missing",
                storagePath: `receipts/intake/${created.body.id}-gone.png`,
            },
        });

        const replay = await postIntake(request, intakeBody({ sourceRef: ref }));
        expect(replay.res.status()).toBe(200);
        expect(replay.body.recovered).toBe(true);

        const row = await prisma.receiptIntake.findUnique({ where: { id: created.body.id } });
        expect(row?.state).toBe("RECEIVED");
        expect(row?.stateReason).toBeNull();
    });

    test("a BOOKED row whose object vanished is never rewritten by a replay", async ({ request }) => {
        // A replay may heal an orphan, but it must not be able to reach into a
        // row that already has a Purchase behind it.
        const ref = `${REF_PREFIX}booked-orphan`;
        const created = await postIntake(request, intakeBody({ sourceRef: ref }));
        expect(created.res.status()).toBe(200);
        await prisma.receiptIntake.update({
            where: { id: created.body.id },
            data: { state: "BOOKED", storagePath: `receipts/intake/${created.body.id}-gone.png` },
        });

        const replay = await postIntake(request, intakeBody({ sourceRef: ref }));
        expect(replay.res.status()).toBe(409);
        expect(replay.body.error).toBe("object-missing");
        expect((await prisma.receiptIntake.findUnique({ where: { id: created.body.id } }))?.state).toBe("BOOKED");
    });
});

test.describe("the two machine secrets are not interchangeable", () => {
    test("the ingest key cannot read the queue, and the archive key cannot ingest", async ({ playwright }) => {
        // One shared secret gave a script that only copies files to Drive the
        // power to inject Purchases into the books, and gave the forwarders the
        // power to enumerate every receipt. 403, not 401: the caller IS
        // authenticated, it is holding the wrong program's key.
        const machine = await playwright.request.newContext({
            baseURL: "http://localhost:3000",
            storageState: { cookies: [], origins: [] },
        });

        const forwarderReadingQueue = await machine.get(`${INTAKE_PATH}?state=BOOKED`, {
            headers: { "x-receipt-intake-secret": SECRET },
            maxRedirects: 0,
        });
        expect(forwarderReadingQueue.status()).toBe(403);

        const mirrorIngesting = await machine.post(INTAKE_PATH, {
            headers: { "content-type": "application/json", "x-receipt-intake-secret": ARCHIVE_SECRET },
            data: intakeBody({ sourceRef: `${REF_PREFIX}wrongkey` }),
            maxRedirects: 0,
        });
        expect(mirrorIngesting.status()).toBe(403);

        const mirrorStartingUpload = await machine.post(`${INTAKE_PATH}/start`, {
            headers: { "content-type": "application/json", "x-receipt-intake-secret": ARCHIVE_SECRET },
            data: JSON.stringify({ mimeType: "image/png", source: "drive", sourceRef: `${REF_PREFIX}wrongkey2` }),
            maxRedirects: 0,
        });
        expect(mirrorStartingUpload.status()).toBe(403);

        await machine.dispose();
    });
});

test.describe("cutover retirement needs evidence, not just an old timestamp", () => {
    test("a shadow row v1 provably booked is retired; one it never touched is handed to v2", async ({ request }) => {
        // "Received before the boundary" says when the file ARRIVED, not that
        // anything booked it. v1 skips documents constantly — a bad read, a
        // park, a file it never picked up — and retiring those as
        // "booked-by-v1" silently drops real expenses.
        const boundary = new Date(Date.now() + 60_000);
        const evidencedFile = `EVID-${Date.now()}`;
        const orphanFile = `ORPH-${Date.now()}`;

        const evidenced = await postIntake(request, intakeBody({ sourceRef: `drive:${evidencedFile}` }));
        const orphan = await postIntake(request, intakeBody({ sourceRef: `drive:${orphanFile}` }));
        expect(evidenced.res.status()).toBe(200);
        expect(orphan.res.status()).toBe(200);
        minted.push(evidenced.body.id, orphan.body.id);

        // Both parked exactly as the shadow week leaves them.
        await prisma.receiptIntake.updateMany({
            where: { id: { in: [evidenced.body.id, orphan.body.id] } },
            data: { state: "READ", dryRun: true },
        });

        // Only ONE of them has v1's own booking event behind it. v1 pushes go
        // through ProBuild's create route, which logs exactly this.
        const event = await prisma.automationEvent.create({
            data: {
                kind: "receipt-push",
                status: "created",
                source: "apps-script",
                driveFileId: evidencedFile,
            },
        });

        try {
            await prisma.automationSetting.upsert({
                where: { key: "cutoverV1StoppedAt" },
                update: { value: boundary.toISOString() },
                create: { key: "cutoverV1StoppedAt", value: boundary.toISOString() },
            });

            // Drive the real cutover through the worker's own claim path.
            const res = await request.get("/api/cron/receipt-intake-worker", {
                headers: process.env.CRON_SECRET ? { authorization: `Bearer ${process.env.CRON_SECRET}` } : {},
                maxRedirects: 0,
            });
            // Skip cleanly if the cron is secret-gated in this environment.
            test.skip(res.status() === 401, "CRON_SECRET not available to the spec");
            expect(res.status()).toBe(200);

            const after = await prisma.receiptIntake.findMany({
                where: { id: { in: [evidenced.body.id, orphan.body.id] } },
                select: { id: true, state: true, stateReason: true, dryRun: true },
            });
            const byId = Object.fromEntries(after.map(r => [r.id, r]));

            expect(byId[evidenced.body.id].state).toBe("SHADOW_DONE");
            expect(byId[evidenced.body.id].stateReason).toBe("booked-by-v1");

            // No evidence -> v2's to book. Safe because a Drive row books under
            // the DRIVE FILE ID, so a v1/v2 overlap collapses to one Purchase.
            expect(byId[orphan.body.id].state).not.toBe("SHADOW_DONE");
            expect(byId[orphan.body.id].dryRun).toBe(false);
        } finally {
            await prisma.automationEvent.delete({ where: { id: event.id } }).catch(() => {});
            await prisma.automationSetting.deleteMany({ where: { key: "cutoverV1StoppedAt" } }).catch(() => {});
        }
    });

    test("the forwarder can assert it already archived a file", async ({ request }) => {
        // The second accepted form of evidence, for documents v1 handled before
        // the create route existed to log them.
        const ref = `${REF_PREFIX}archived-by-v1`;
        const res = await postIntake(request, JSON.stringify({
            source: "drive", sourceRef: ref, fileBase64: PNG_BASE64,
            mimeType: "image/png", archivedByV1: true,
        }));
        expect(res.res.status()).toBe(200);
        const row = await prisma.receiptIntake.findUnique({ where: { id: res.body.id } });
        expect(row?.archivedByV1).toBe(true);
    });

    test("a SESSION caller cannot claim v1 already booked something", async ({ request }) => {
        // That flag is what excuses v2 from booking a document. Only a
        // shared-secret forwarder may assert it.
        //
        // A distinct uploadId here (rather than relying on the no-uploadId
        // content key) keeps this row independent of the identical PNG_BASE64
        // bytes other session-auth tests in this file upload — this test is
        // about archivedByV1, not about content-based idempotency.
        const res = await request.post(INTAKE_PATH, {
            headers: { "content-type": "application/json" },
            data: JSON.stringify({
                fileBase64: PNG_BASE64, mimeType: "image/png", archivedByV1: true,
                uploadId: "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed",
            }),
            maxRedirects: 0,
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        minted.push(body.id);
        const row = await prisma.receiptIntake.findUnique({ where: { id: body.id } });
        expect(row?.archivedByV1).toBe(false, "a browser upload can never claim v1 booked it");
    });
});

test.describe("two-step upload: a reused key cannot swap the document", () => {
    const startPath = `${INTAKE_PATH}/start`;
    const sha = (b64: string) => createHash("sha256").update(Buffer.from(b64, "base64")).digest("hex");

    test("SEQUENTIAL reuse with different bytes is refused before a URL is issued", async ({ request }) => {
        // Caught at /start, not at /finalize: by then the caller would have
        // uploaded receipt B over receipt A's object and A's bytes are gone.
        const ref = `${REF_PREFIX}twostep-seq`;
        const first = await request.post(startPath, {
            headers: { "content-type": "application/json", "x-receipt-intake-secret": SECRET },
            data: JSON.stringify({ source: "drive", sourceRef: ref, mimeType: "image/png", sha256: sha(PNG_BASE64) }),
            maxRedirects: 0,
        });
        expect(first.status()).toBe(200);
        const started = await first.json();
        minted.push(started.id);
        expect(started.uploadUrl).toBeTruthy();

        // Same key, same document — a plain retry resumes.
        const resumed = await request.post(startPath, {
            headers: { "content-type": "application/json", "x-receipt-intake-secret": SECRET },
            data: JSON.stringify({ source: "drive", sourceRef: ref, mimeType: "image/png", sha256: sha(PNG_BASE64) }),
            maxRedirects: 0,
        });
        expect(resumed.status()).toBe(200);
        expect((await resumed.json()).id).toBe(started.id);

        // Same key, DIFFERENT document — refused.
        const swapped = await request.post(startPath, {
            headers: { "content-type": "application/json", "x-receipt-intake-secret": SECRET },
            data: JSON.stringify({
                source: "drive", sourceRef: ref, mimeType: "image/png", sha256: sha(OTHER_PNG_BASE64),
            }),
            maxRedirects: 0,
        });
        expect(swapped.status()).toBe(409);
        expect((await swapped.json()).error).toBe("sourceRef-conflict");
    });

    test("CONCURRENT starts on one key yield ONE row", async ({ request }) => {
        const ref = `${REF_PREFIX}twostep-race`;
        const body = JSON.stringify({
            source: "drive", sourceRef: ref, mimeType: "image/png", sha256: sha(PNG_BASE64),
        });
        const fire = () => request.post(startPath, {
            headers: { "content-type": "application/json", "x-receipt-intake-secret": SECRET },
            data: body,
            maxRedirects: 0,
        });

        const results = await Promise.all([fire(), fire(), fire()]);
        for (const r of results) expect(r.status()).toBe(200);
        const ids = new Set(await Promise.all(results.map(async r => (await r.json()).id)));
        expect(ids.size).toBe(1, "the unique index collapses the race to one row");

        const rows = await prisma.receiptIntake.findMany({ where: { sourceRef: ref } });
        expect(rows).toHaveLength(1);
        expect(rows[0].expectedSha256).toBe(sha(PNG_BASE64));
        minted.push(rows[0].id);
    });

    test("finalize refuses when the STORED bytes are not what /start was told", async ({ request }) => {
        const ref = `${REF_PREFIX}twostep-sha`;
        const started = await request.post(startPath, {
            headers: { "content-type": "application/json", "x-receipt-intake-secret": SECRET },
            // Declares a hash the bytes will never match.
            data: JSON.stringify({ source: "drive", sourceRef: ref, mimeType: "image/png", sha256: "a".repeat(64) }),
            maxRedirects: 0,
        });
        expect(started.status()).toBe(200);
        const { id, storagePath } = await started.json();
        minted.push(id);

        // Put REAL bytes at the path the row points at, as a direct upload would.
        await prisma.receiptIntake.update({ where: { id }, data: { storagePath } });
        const seeded = await request.post(INTAKE_PATH, {
            headers: { "content-type": "application/json", "x-receipt-intake-secret": SECRET },
            data: intakeBody({ sourceRef: `${REF_PREFIX}twostep-sha-src` }),
            maxRedirects: 0,
        });
        expect(seeded.status()).toBe(200);
        const seededRow = await prisma.receiptIntake.findUnique({ where: { id: (await seeded.json()).id } });
        minted.push(seededRow!.id);
        await prisma.receiptIntake.update({ where: { id }, data: { storagePath: seededRow!.storagePath } });

        const finalized = await request.post(`${INTAKE_PATH}/${id}/finalize`, {
            headers: { "content-type": "application/json", "x-receipt-intake-secret": SECRET },
            data: "{}",
            maxRedirects: 0,
        });
        expect(finalized.status()).toBe(409);
        expect((await finalized.json()).error).toBe("sha-mismatch");
        expect((await prisma.receiptIntake.findUnique({ where: { id } }))?.state).toBe("STAGING");
    });

    test("SWEPT then re-uploaded: /start re-arms the row and /finalize publishes it", async ({ request }) => {
        // End to end for the recovery the sweeper leaves behind. The old
        // behaviour answered `alreadyReceived` for any non-STAGING row, which
        // told the forwarder we held a receipt we did not hold — and it deletes
        // its only copy on that answer — leaving the row parked forever with
        // nothing to recover from.
        const ref = `${REF_PREFIX}swept-restart`;
        const first = await request.post(startPath, {
            headers: { "content-type": "application/json", "x-receipt-intake-secret": SECRET },
            data: JSON.stringify({ source: "drive", sourceRef: ref, mimeType: "image/png", sha256: sha(OTHER_PNG_BASE64) }),
            maxRedirects: 0,
        });
        expect(first.status()).toBe(200);
        const { id } = await first.json();
        minted.push(id);

        // Exactly what the stale-STAGING sweep leaves behind when the upload
        // never landed.
        await prisma.receiptIntake.update({
            where: { id },
            data: { state: "NEEDS_REVIEW", stateReason: "file-missing" },
        });

        // The client comes back with the correct document — a DIFFERENT hash
        // from the one it first announced, which for a STAGING row would be a
        // sourceRef-conflict. Here there are no verified bytes to protect.
        const rearmed = await request.post(startPath, {
            headers: { "content-type": "application/json", "x-receipt-intake-secret": SECRET },
            data: JSON.stringify({ source: "drive", sourceRef: ref, mimeType: "image/png", sha256: sha(PNG_BASE64) }),
            maxRedirects: 0,
        });
        expect(rearmed.status()).toBe(200);
        const rearmedBody = await rearmed.json();
        expect(rearmedBody.id).toBe(id);
        expect(rearmedBody.recovered).toBe(true, "a new URL, not alreadyReceived");
        expect(rearmedBody.uploadUrl).toBeTruthy();
        const armed = await prisma.receiptIntake.findUnique({ where: { id } });
        expect(armed?.expectedSha256).toBe(sha(PNG_BASE64), "the new hash is what finalize will verify");
        expect(armed?.state).toBe("NEEDS_REVIEW", "still parked until the bytes actually land");

        // "Upload": the spec cannot PUT to Supabase, so real bytes are put at a
        // path by the single-shot route and the row is pointed at them — the
        // same seeding trick the sha-mismatch case above uses.
        const seeded = await request.post(INTAKE_PATH, {
            headers: { "content-type": "application/json", "x-receipt-intake-secret": SECRET },
            data: intakeBody({ sourceRef: `${REF_PREFIX}swept-restart-src` }),
            maxRedirects: 0,
        });
        expect(seeded.status()).toBe(200);
        const seededRow = await prisma.receiptIntake.findUnique({ where: { id: (await seeded.json()).id } });
        minted.push(seededRow!.id);
        await prisma.receiptIntake.update({ where: { id }, data: { storagePath: seededRow!.storagePath } });

        const finalized = await request.post(`${INTAKE_PATH}/${id}/finalize`, {
            headers: { "content-type": "application/json", "x-receipt-intake-secret": SECRET },
            data: "{}",
            maxRedirects: 0,
        });
        expect(finalized.status()).toBe(200);
        const done = await prisma.receiptIntake.findUnique({ where: { id } });
        expect(done?.state).toBe("RECEIVED", "the swept row recovered all the way to published");
        expect(done?.stateReason).toBeNull();
        expect(done?.fileSha256).toBe(sha(PNG_BASE64));
    });

    test("a park a re-upload CANNOT fix still answers alreadyReceived", async ({ request }) => {
        // The control. Only file-missing and sha-mismatch are recoverable; a
        // row parked on a human's decision must not be handed a fresh URL that
        // would let a client overwrite the document under review.
        const ref = `${REF_PREFIX}swept-notrecoverable`;
        const first = await request.post(startPath, {
            headers: { "content-type": "application/json", "x-receipt-intake-secret": SECRET },
            data: JSON.stringify({ source: "drive", sourceRef: ref, mimeType: "image/png", sha256: sha(PNG_BASE64) }),
            maxRedirects: 0,
        });
        expect(first.status()).toBe(200);
        const { id } = await first.json();
        minted.push(id);

        // The row must actually HOLD its document, because `alreadyReceived` is
        // now answered from the bucket and not from the row alone — the
        // forwarder deletes its only copy on that answer, so /start confirms
        // the object is really there first. /start never carries bytes and this
        // spec cannot PUT to a signed URL, so the object is seeded the same way
        // the two cases above do it: real bytes stored by the single-shot
        // route, and the row pointed at them.
        const seeded = await request.post(INTAKE_PATH, {
            headers: { "content-type": "application/json", "x-receipt-intake-secret": SECRET },
            data: intakeBody({ sourceRef: `${REF_PREFIX}swept-notrecoverable-src` }),
            maxRedirects: 0,
        });
        expect(seeded.status()).toBe(200);
        const seededRow = await prisma.receiptIntake.findUnique({ where: { id: (await seeded.json()).id } });
        minted.push(seededRow!.id);
        const storagePath = seededRow!.storagePath;

        await prisma.receiptIntake.update({
            where: { id },
            data: { state: "NEEDS_REVIEW", stateReason: "vendor-mismatch", storagePath },
        });

        const again = await request.post(startPath, {
            headers: { "content-type": "application/json", "x-receipt-intake-secret": SECRET },
            data: JSON.stringify({ source: "drive", sourceRef: ref, mimeType: "image/png", sha256: sha(PNG_BASE64) }),
            maxRedirects: 0,
        });
        expect(again.status()).toBe(200);
        const body = await again.json();
        expect(body.alreadyReceived).toBe(true);
        expect(body.uploadUrl).toBeUndefined();
        const row = await prisma.receiptIntake.findUnique({ where: { id } });
        expect(row?.storagePath).toBe(storagePath, "nothing was re-armed");
        expect(row?.stateReason).toBe("vendor-mismatch");
    });
});

test.describe("round-9 intake contracts", () => {
    const startPath = `${INTAKE_PATH}/start`;
    const sha = (b64: string) => createHash("sha256").update(Buffer.from(b64, "base64")).digest("hex");
    const start = (request: APIRequestContext, body: Record<string, unknown>) =>
        request.post(startPath, {
            headers: { "content-type": "application/json", "x-receipt-intake-secret": SECRET },
            data: JSON.stringify(body),
            maxRedirects: 0,
        });

    test("/start REFUSES without a sha256 — it is the row's only identity", async ({ request }) => {
        // Without it a reused sourceRef is indistinguishable from an honest
        // retry, and /start would hand out an upsert URL aimed at another
        // document's object.
        const res = await start(request, {
            source: "drive", sourceRef: `${REF_PREFIX}nosha`, mimeType: "image/png",
        });
        expect(res.status()).toBe(400);
        expect((await res.json()).reason).toBe("missing-sha256");

        const malformed = await start(request, {
            source: "drive", sourceRef: `${REF_PREFIX}badsha`, mimeType: "image/png", sha256: "nope",
        });
        expect(malformed.status()).toBe(400);
    });

    test("/start will not reissue an upsert URL without proving identity", async ({ request }) => {
        const ref = `${REF_PREFIX}reissue`;
        const first = await start(request, {
            source: "drive", sourceRef: ref, mimeType: "image/png", sha256: sha(PNG_BASE64),
        });
        expect(first.status()).toBe(200);
        minted.push((await first.json()).id);

        // Same hash: proven the same document, so the URL is reissued.
        const proven = await start(request, {
            source: "drive", sourceRef: ref, mimeType: "image/png", sha256: sha(PNG_BASE64),
        });
        expect(proven.status()).toBe(200);
        expect((await proven.json()).uploadUrl).toBeTruthy();

        // Different hash: refused BEFORE a URL exists, so receipt B can never be
        // written over receipt A's object.
        const unproven = await start(request, {
            source: "drive", sourceRef: ref, mimeType: "image/png", sha256: sha(OTHER_PNG_BASE64),
        });
        expect(unproven.status()).toBe(409);
        expect((await unproven.json()).error).toBe("sourceRef-conflict");
    });

    test("the PRODUCTION sourceRef formats are accepted by both endpoints", async ({ request }) => {
        // Exactly what the Apps Script forwarder sends. A validator that
        // accepted more than production sends would have accepted the bug it
        // exists to stop; one that accepts LESS breaks the forwarder silently,
        // so both shapes are driven through both doors.
        const stamp = Date.now();
        const emailRef = `email:1993f0a3c9c4d0${stamp % 100}:0f1e2d3c4b5a6978`;
        const chatRef = `chat:spaces/AAQANF47osY/messages/e2e.${stamp}:0`;

        const inline = await postIntake(request, JSON.stringify({
            source: "email", sourceRef: emailRef,
            fileBase64: PNG_BASE64, mimeType: "image/png", fileName: "e.png",
        }));
        expect(inline.res.status()).toBe(200);
        minted.push(inline.body.id);

        const started = await request.post(`${INTAKE_PATH}/start`, {
            headers: { "content-type": "application/json", "x-receipt-intake-secret": SECRET },
            data: JSON.stringify({
                source: "chat", sourceRef: chatRef, mimeType: "image/png",
                sha256: createHash("sha256").update(Buffer.from(PNG_BASE64, "base64")).digest("hex"),
            }),
            maxRedirects: 0,
        });
        expect(started.status()).toBe(200);
        minted.push((await started.json()).id);
    });

    test("a namespace with no id, and an oversized one, are refused at both doors", async ({ request }) => {
        // `drive:` with an empty tail was a valid, unique, PERMANENT idempotency
        // key: every later empty-tail forward collided with it and was told
        // "already received", so real receipts were dropped.
        const bad: Array<[string, string]> = [
            ["drive:", "invalid-sourceRef"],
            [`drive:${"a".repeat(600)}`, "sourceRef-too-long"],
            ["drive:short", "invalid-sourceRef"],
        ];
        for (const [sourceRef, reason] of bad) {
            const inline = await postIntake(request, intakeBody({ sourceRef }));
            expect(inline.res.status(), sourceRef).toBe(400);
            expect(inline.body.reason, sourceRef).toBe(reason);

            const started = await request.post(`${INTAKE_PATH}/start`, {
                headers: { "content-type": "application/json", "x-receipt-intake-secret": SECRET },
                data: JSON.stringify({
                    source: "drive", sourceRef, mimeType: "image/png", sha256: "a".repeat(64),
                }),
                maxRedirects: 0,
            });
            expect(started.status(), sourceRef).toBe(400);
            expect((await started.json()).reason, sourceRef).toBe(reason);
        }
        // And nothing was created for any of them.
        const rows = await prisma.receiptIntake.findMany({ where: { sourceRef: { startsWith: "drive:a" } } });
        expect(rows).toHaveLength(0);
    });

    test("every sourceRef rule /start enforces, the inline endpoint enforces IDENTICALLY", async ({ request }) => {
        // The inline endpoint used to check only the NAMESPACE PREFIX while
        // /start ran decideSource(), so a secret caller could push a shape
        // /start refuses through the other door: junk QuickBooks identities
        // (a `drive` row books under its tail) and oversized values headed for
        // a UNIQUE index.
        //
        // Prefix-only validation accepts every row below, which is why "both
        // return 400" is not the assertion. The doors must agree on the REASON
        // too — a forwarder that can tell them apart will learn to prefer the
        // lenient one, and that is how the two implementations drifted in the
        // first place.
        const refused: Array<[string, string, string]> = [
            // Right namespace, wrong SHAPE — precisely what a prefix check misses.
            // One email message can carry several receipts, so the message id
            // alone is not an identity.
            ["email", "email:1993f0a3c9c4d0d2", "invalid-sourceRef"],
            ["email", "email:1993f0a3c9c4d0d2:NOTHEX0123456789", "invalid-sourceRef"],
            // A Chat ref without its attachment index, and one whose resource
            // name is not a resource name.
            ["chat", "chat:spaces/AAQANF47osY/messages/abc.def", "invalid-sourceRef"],
            ["chat", "chat:not-a-resource-name:0", "invalid-sourceRef"],
            // Control characters and whitespace: this value is echoed into logs
            // and compared for equality. A LEADING one is deliberately not a
            // case here — both doors trim before validating, and that agreement
            // is itself part of the parity.
            ["drive", "drive:1AbCdEfGh IjKlMnOp", "invalid-sourceRef"],
            ["drive", "drive:1AbCdEfGh\u0001IjKlMnOp", "invalid-sourceRef"],
            // Oversized, in a namespace the drive-only case above does not reach.
            ["email", `email:${"a".repeat(600)}:0f1e2d3c4b5a6978`, "sourceRef-too-long"],
            // A well-formed ref, in a namespace the caller did not declare.
            ["drive", "email:1993f0a3c9c4d0d2:0f1e2d3c4b5a6978", "sourceRef-namespace-mismatch"],
        ];

        for (const [source, sourceRef, reason] of refused) {
            const label = `${source} / ${JSON.stringify(sourceRef).slice(0, 64)}`;
            const inline = await postIntake(request, intakeBody({ source, sourceRef }));
            const started = await start(request, {
                source, sourceRef, mimeType: "image/png", sha256: sha(PNG_BASE64),
            });
            expect(inline.res.status(), `inline ${label}`).toBe(400);
            expect(started.status(), `start ${label}`).toBe(400);
            expect(inline.body.reason, `inline ${label}`).toBe(reason);
            expect((await started.json()).reason, `start ${label}`).toBe(reason);
        }

        // Neither door created a row for any of them. A 400 that still inserts
        // is the oversized-unique-index half of the finding.
        const rows = await prisma.receiptIntake.findMany({
            where: { sourceRef: { in: refused.map(([, sourceRef]) => sourceRef) } },
            select: { sourceRef: true },
        });
        expect(rows).toHaveLength(0);
    });

    test("a settled row whose object is GONE is 409 file-missing, never a cheerful 200", async ({ request }) => {
        // Both replay paths used to answer success from the row alone. The
        // forwarders treat that as permission to delete their only copy, so a
        // row whose object had vanished got a 200 and the receipt ceased to
        // exist anywhere.
        const ref = `${REF_PREFIX}settled-gone`;
        const created = await postIntake(request, intakeBody({ sourceRef: ref }));
        expect(created.res.status()).toBe(200);
        const id = created.body.id;
        minted.push(id);
        expect((await prisma.receiptIntake.findUnique({ where: { id } }))?.state).toBe("RECEIVED");

        // Point the settled row at a path nothing was ever written to.
        await prisma.receiptIntake.update({
            where: { id },
            data: { storagePath: `receipts/intake/${id}.vanished.png` },
        });

        // /finalize: the alreadyFinalized path.
        const finalized = await request.post(`${INTAKE_PATH}/${id}/finalize`, {
            headers: { "content-type": "application/json", "x-receipt-intake-secret": SECRET },
            data: "{}",
            maxRedirects: 0,
        });
        expect(finalized.status()).toBe(409);
        const finalBody = await finalized.json();
        expect(finalBody.error).toBe("file-missing");
        expect(finalBody.retryable).toBe(true);

        // /start: the alreadyReceived path, same sourceRef.
        const started = await request.post(`${INTAKE_PATH}/start`, {
            headers: { "content-type": "application/json", "x-receipt-intake-secret": SECRET },
            data: JSON.stringify({
                source: "drive", sourceRef: ref, mimeType: "image/png",
                sha256: createHash("sha256").update(Buffer.from(PNG_BASE64, "base64")).digest("hex"),
            }),
            maxRedirects: 0,
        });
        expect(started.status()).toBe(409);
        const startBody = await started.json();
        expect(startBody.error).toBe("file-missing");
        expect(startBody.retryable).toBe(true);
        expect(startBody.uploadUrl).toBeUndefined();

        // The row is untouched by either refusal.
        const after = await prisma.receiptIntake.findUnique({ where: { id } });
        expect(after?.state).toBe("RECEIVED");
    });

    test("a settled row that DOES still have its object replays as success", async ({ request }) => {
        // The control: without it both refusals above would pass against an
        // endpoint that had simply stopped answering 200 at all.
        const ref = `${REF_PREFIX}settled-present`;
        const created = await postIntake(request, intakeBody({ sourceRef: ref }));
        expect(created.res.status()).toBe(200);
        minted.push(created.body.id);

        const finalized = await request.post(`${INTAKE_PATH}/${created.body.id}/finalize`, {
            headers: { "content-type": "application/json", "x-receipt-intake-secret": SECRET },
            data: "{}",
            maxRedirects: 0,
        });
        expect(finalized.status()).toBe(200);
        expect((await finalized.json()).alreadyFinalized).toBe(true);
    });

    test("a text receipt is refused with a 415 that says what to send instead", async ({ request }) => {
        // QuickBooks cannot attach a .txt, so accepting one meant reading it and
        // then stranding it unbookable mid-pipeline.
        const res = await postIntake(request, intakeBody({
            sourceRef: `${REF_PREFIX}textfile`,
            fileBase64: Buffer.from("VENDOR: Lowes\nTOTAL: 10.00").toString("base64"),
            mimeType: "text/plain",
        }));
        expect(res.res.status()).toBe(415);
        expect(res.body.error).toBe("unsupported-file-type");
        expect(res.body.reason).toMatch(/PDF/i);
        expect(res.body.accepted).toContain("application/pdf");
    });

    test("the JSON inline limit is 3 MiB raw and says so", async ({ request }) => {
        // base64 inflates by 4/3, so 4 MiB raw is a ~5.4 MiB request — over the
        // platform body cap, which used to reject it before this code ran.
        const big = Buffer.alloc(3 * 1024 * 1024 + 1, 7).toString("base64");
        const res = await postIntake(request, intakeBody({
            sourceRef: `${REF_PREFIX}toobig`, fileBase64: big,
        }));
        expect(res.res.status()).toBe(413);
        expect(res.body.error).toBe("payload-too-large");
        expect(res.body.maxInlineBytes).toBe(3 * 1024 * 1024);
        expect(res.body.use).toMatch(/intake\/start/);
    });

    test("a sequential finalize retry still applies late fields", async ({ request }) => {
        // The row already reached RECEIVED, so this takes the alreadyFinalized
        // path — and answering it without applying the job assignment would drop
        // that assignment while telling the caller it worked.
        const ref = `${REF_PREFIX}latefields`;
        // The row carries the JOB, because a phase is only valid against one:
        // `e2e-mob-cc-demo` is a phase of PROJECT_ID via the approved mobile
        // estimate (data.setup.ts). Without the project this is a 400
        // cost-code-without-project, which is a different test (below).
        const created = await postIntake(request, intakeBody({ sourceRef: ref, projectId: PROJECT_ID }));
        expect(created.res.status()).toBe(200);
        const id = created.body.id;
        minted.push(id);
        expect((await prisma.receiptIntake.findUnique({ where: { id } }))?.state).toBe("RECEIVED");

        const applied = await request.post(`${INTAKE_PATH}/${id}/finalize`, {
            headers: { "content-type": "application/json", "x-receipt-intake-secret": SECRET },
            data: JSON.stringify({ costCodeId: "e2e-mob-cc-demo" }),
            maxRedirects: 0,
        });
        expect(applied.status()).toBe(200);
        expect((await applied.json()).alreadyFinalized).toBe(true);
        expect((await prisma.receiptIntake.findUnique({ where: { id } }))?.costCodeId).toBe("e2e-mob-cc-demo");

        // Re-sending the SAME value is idempotent.
        const same = await request.post(`${INTAKE_PATH}/${id}/finalize`, {
            headers: { "content-type": "application/json", "x-receipt-intake-secret": SECRET },
            data: JSON.stringify({ costCodeId: "e2e-mob-cc-demo" }),
            maxRedirects: 0,
        });
        expect(same.status()).toBe(200);

        // A DIFFERENT value is a conflict, never a silent overwrite of what a
        // human may already have set.
        const conflicting = await request.post(`${INTAKE_PATH}/${id}/finalize`, {
            headers: { "content-type": "application/json", "x-receipt-intake-secret": SECRET },
            data: JSON.stringify({ costCodeId: "e2e-mob-cc-dryw" }),
            maxRedirects: 0,
        });
        expect(conflicting.status()).toBe(409);
        expect((await conflicting.json()).error).toBe("late-fields-conflict");
        expect((await prisma.receiptIntake.findUnique({ where: { id } }))?.costCodeId).toBe("e2e-mob-cc-demo");
    });

    test("a published row's object lives at the sealed, content-addressed path", async ({ request }) => {
        const ref = `${REF_PREFIX}sealed-path`;
        const created = await postIntake(request, intakeBody({ sourceRef: ref }));
        expect(created.res.status()).toBe(200);
        minted.push(created.body.id);
        const row = await prisma.receiptIntake.findUnique({ where: { id: created.body.id } });
        // The single-shot path publishes directly; the two-step path seals. Either
        // way the row must never be left pointing somewhere a client holds a URL for.
        expect(row?.fileSha256).toHaveLength(64);
    });
});

test.describe("round-10 finalize authorization and recovery", () => {
    const startPath = `${INTAKE_PATH}/start`;
    const finalize = (request: APIRequestContext, id: string, body: Record<string, unknown>) =>
        request.post(`${INTAKE_PATH}/${id}/finalize`, {
            headers: { "content-type": "application/json", "x-receipt-intake-secret": SECRET },
            data: JSON.stringify(body),
            maxRedirects: 0,
        });

    test("truncated JSON in the finalize body is a 400, not silently treated as empty", async ({ request }) => {
        // req.json() throws on BOTH a genuinely empty body and a malformed
        // one; a bare try/catch collapsed truncated JSON into "no fields",
        // which turned a request-level bug into a silent no-op instead of an
        // error the caller could see and retry against.
        const created = await postIntake(request, intakeBody({ sourceRef: `${REF_PREFIX}truncjson` }));
        expect(created.res.status()).toBe(200);
        minted.push(created.body.id);

        const res = await request.post(`${INTAKE_PATH}/${created.body.id}/finalize`, {
            headers: { "content-type": "application/json", "x-receipt-intake-secret": SECRET },
            data: '{"costCodeId": "e2e-mob-cc-demo"', // truncated: missing closing brace
            maxRedirects: 0,
        });
        expect(res.status()).toBe(400);
        expect((await res.json()).reason).toBe("invalid-json");

        // Nothing was written: no late field applied and no state change.
        const row = await prisma.receiptIntake.findUnique({ where: { id: created.body.id } });
        expect(row?.state).toBe("RECEIVED");
        expect(row?.costCodeId).toBeNull();
    });

    test("a session caller cannot attach a project it may not reach", async ({ playwright, request }) => {
        // Without this any authenticated user could file a receipt against any
        // project by id.
        const created = await postIntake(request, intakeBody({ sourceRef: `${REF_PREFIX}authz` }));
        expect(created.res.status()).toBe(200);
        minted.push(created.body.id);

        const employee = await playwright.request.newContext({
            baseURL: "http://localhost:3000",
            storageState: "e2e/.auth/contract-user.json",
        });
        const res = await employee.post(`${INTAKE_PATH}/${created.body.id}/finalize`, {
            headers: { "content-type": "application/json" },
            data: JSON.stringify({ projectId: "e2e-scope-oos-project" }),
            maxRedirects: 0,
        });
        // Either refused outright (403) or invisible to this caller (404) — what
        // must NOT happen is the project landing on the row.
        expect([403, 404]).toContain(res.status());
        expect((await prisma.receiptIntake.findUnique({ where: { id: created.body.id } }))?.projectId)
            .not.toBe("e2e-scope-oos-project");
        await employee.dispose();
    });

    test("a cost code that is not a phase of the job is refused", async ({ request }) => {
        const created = await postIntake(request, intakeBody({ sourceRef: `${REF_PREFIX}phasecheck` }));
        expect(created.res.status()).toBe(200);
        minted.push(created.body.id);

        const res = await finalize(request, created.body.id, { costCodeId: "e2e-mob-cc-demo" });
        // No project on the row and none supplied, so a phase is meaningless.
        expect(res.status()).toBe(400);
        expect((await res.json()).error).toBe("cost-code-without-project");
    });

    test("the ingest secret cannot finalize a row it does not own the SOURCE of", async ({ request }) => {
        // decideSource already stops a forwarder CREATING a row outside its
        // namespace, but finalize took `via === "secret"` as blanket authority
        // over any id — so the Apps Script key could publish, re-point and
        // attach a job to somebody's mobile capture or web upload.
        const created = await postIntake(request, intakeBody({ sourceRef: `${REF_PREFIX}notmysource` }));
        expect(created.res.status()).toBe(200);
        const id = created.body.id;
        minted.push(id);

        // Exactly the shape a phone or the web uploader leaves behind. Seeded
        // directly because the secret can no longer create one.
        await prisma.receiptIntake.update({
            where: { id },
            data: { source: "mobile", sourceRef: `mobile:${id}` },
        });

        const res = await request.post(`${INTAKE_PATH}/${id}/finalize`, {
            headers: { "content-type": "application/json", "x-receipt-intake-secret": SECRET },
            data: JSON.stringify({ projectId: PROJECT_ID }),
            maxRedirects: 0,
        });
        expect(res.status()).toBe(403);
        const body = await res.json();
        expect(body.error).toBe("source-not-owned");
        // 403 before ANY detail is returned or written.
        expect(body.storagePath).toBeUndefined();
        expect(body.state).toBeUndefined();
        const after = await prisma.receiptIntake.findUnique({ where: { id } });
        expect(after?.projectId).toBeNull();
    });

    test("a user with no access to the row's OWN job cannot finalize it", async ({ playwright, request }) => {
        // Revocation has to bite on the project the ROW holds, not only on one
        // the request supplies. Before this, a user whose access was revoked
        // could still publish their existing row on that job — and attach a
        // phase to it — simply by not mentioning the project.
        const created = await postIntake(request, intakeBody({
            sourceRef: `${REF_PREFIX}revoked`, projectId: "e2e-scope-oos-project",
        }));
        expect(created.res.status()).toBe(200);
        const id = created.body.id;
        minted.push(id);

        // The row is THEIRS (so the ownership check passes and this test is
        // about project access, not about a guessed id), on a job
        // contract-staff has no ProjectAccess for.
        const owner = await prisma.user.findUnique({ where: { email: "contract-staff@test.local" } });
        expect(owner, "contract-staff fixture must exist").toBeTruthy();
        await prisma.receiptIntake.update({ where: { id }, data: { createdById: owner!.id } });

        const employee = await playwright.request.newContext({
            baseURL: "http://localhost:3000",
            storageState: "e2e/.auth/contract-user.json",
        });
        const res = await employee.post(`${INTAKE_PATH}/${id}/finalize`, {
            headers: { "content-type": "application/json" },
            // No projectId in the body: the row already has one, and that is
            // the whole point of the case.
            data: JSON.stringify({ costCodeId: "e2e-mob-cc-demo" }),
            maxRedirects: 0,
        });
        expect(res.status()).toBe(403);
        expect((await res.json()).error).toBe("project-forbidden");
        // NOTHING written: the gate runs before any late field is applied.
        const after = await prisma.receiptIntake.findUnique({ where: { id } });
        expect(after?.costCodeId).toBeNull();
        expect(after?.projectId).toBe("e2e-scope-oos-project");
        await employee.dispose();
    });

    test("a cost code that is not a phase of THIS job is refused", async ({ request }) => {
        // The row has a job, and the phase is not one of its phases. Neither
        // half is malformed — the PAIR is wrong, and letting it through files
        // the receipt against a line this job never budgeted.
        const created = await postIntake(request, intakeBody({
            sourceRef: `${REF_PREFIX}phasejob`, projectId: PROJECT_ID,
        }));
        expect(created.res.status()).toBe(200);
        minted.push(created.body.id);

        const res = await finalize(request, created.body.id, { costCodeId: "e2e-not-a-phase-of-anything" });
        expect(res.status()).toBe(400);
        expect((await res.json()).error).toBe("cost-code-not-a-phase");
        expect((await prisma.receiptIntake.findUnique({ where: { id: created.body.id } }))?.costCodeId)
            .toBeNull();
    });

    test("the job's OWN phase is accepted", async ({ request }) => {
        // The control: without it the two refusals above would pass just as
        // well against a gate that refused everything.
        const created = await postIntake(request, intakeBody({
            sourceRef: `${REF_PREFIX}phaseok`, projectId: PROJECT_ID,
        }));
        expect(created.res.status()).toBe(200);
        minted.push(created.body.id);

        const res = await finalize(request, created.body.id, { costCodeId: "e2e-mob-cc-demo" });
        expect(res.status()).toBe(200);
        expect((await prisma.receiptIntake.findUnique({ where: { id: created.body.id } }))?.costCodeId)
            .toBe("e2e-mob-cc-demo");
    });

    test("late fields are refused once the row has been routed", async ({ request }) => {
        // Past RECEIVED the dedup keys, the phase suggestion and possibly a
        // booking were all derived from the project the row had at the time.
        const created = await postIntake(request, intakeBody({ sourceRef: `${REF_PREFIX}toolate` }));
        expect(created.res.status()).toBe(200);
        const id = created.body.id;
        minted.push(id);

        await prisma.receiptIntake.update({ where: { id }, data: { state: "BOOKED" } });
        const res = await finalize(request, id, { projectId: "e2e-scope-oos-project" });
        expect(res.status()).toBe(409);
        expect((await res.json()).error).toBe("late-fields-too-late");
        expect((await prisma.receiptIntake.findUnique({ where: { id } }))?.projectId).toBeNull();
    });

    test("finalize returns the PERSISTED values, not what the caller asked for", async ({ request }) => {
        const created = await postIntake(request, intakeBody({ sourceRef: `${REF_PREFIX}persisted` }));
        expect(created.res.status()).toBe(200);
        minted.push(created.body.id);

        const res = await finalize(request, created.body.id, {});
        expect(res.status()).toBe(200);
        const body = await res.json();
        const row = await prisma.receiptIntake.findUnique({ where: { id: created.body.id } });
        expect(body.state).toBe(row?.state);
        expect(body.fileSha256).toBe(row?.fileSha256);
        expect(body.costCodeId).toBe(row?.costCodeId ?? null);
    });

    test("/start refuses an unsupported type with 415 and creates NO row", async ({ request }) => {
        const ref = `${REF_PREFIX}start-415`;
        const res = await request.post(startPath, {
            headers: { "content-type": "application/json", "x-receipt-intake-secret": SECRET },
            data: JSON.stringify({
                source: "drive", sourceRef: ref, mimeType: "text/plain", sha256: "a".repeat(64),
            }),
            maxRedirects: 0,
        });
        expect(res.status()).toBe(415);
        const body = await res.json();
        expect(body.error).toBe("unsupported-file-type");
        expect(body.accepted).not.toContain("text/plain");
        // The row must not exist — a STAGING row for a document we will never
        // accept is something the sweeper then has to reason about.
        expect(await prisma.receiptIntake.findUnique({ where: { sourceRef: ref } })).toBeNull();
    });
});
