/**
 * The intake endpoint's auth boundary, at the two places it can fail open:
 * the proxy's bypass set, and the shared-secret comparison.
 *
 * The bypass is what makes the handler the ONLY gate, so its shape is a
 * security assertion: exact paths, no descendants. A wildcard here would
 * pre-authorize any future /api/receipts/* route the moment someone creates
 * the file — which is the mistake the office-tasks comment already warns about.
 *
 * src/proxy.ts statically imports @/lib/staff-status (prisma), so the env those
 * modules expect is set before the dynamic import; nothing here hits a database.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.NEXTAUTH_SECRET ??= "test-secret";
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";

const loadProxy = () => import("../src/proxy");
const loadAuth = () => import("../src/lib/receipt-intake/intake-auth");
const loadFileType = () => import("../src/lib/receipt-intake/file-type");

test("the intake paths bypass the proxy so machine callers get a clean 401", async () => {
    const { isPublicProxyBypass } = await loadProxy();
    for (const path of [
        "/api/receipts/intake",
        "/api/receipts/intake/",
        "/api/receipts/intake/abc123/archived",
        "/api/receipts/intake/abc123/archived/",
    ]) {
        assert.equal(isPublicProxyBypass(path), true, path);
    }
});

test("the bypass does NOT widen to descendants or to the rest of /api/receipts", async () => {
    const { isPublicProxyBypass } = await loadProxy();
    for (const path of [
        "/api/receipts/intake/abc123",            // a future detail route
        "/api/receipts/intake/abc123/anything",   // a future sub-route
        "/api/receipts/intake/abc123/archived/x", // deeper than the callback
        "/api/receipts/parse",                    // the v1 AI parser keeps the proxy
        "/api/receipts",
        "/api/receipts-intake",                   // no dash-for-slash confusion
    ]) {
        assert.equal(isPublicProxyBypass(path), false, path);
    }
});

test("the secret check fails CLOSED when the env var is unset or empty", async () => {
    const { secretMatches } = await loadAuth();
    // The getclients-auth-gate lesson: an unset secret must refuse, never allow.
    assert.equal(secretMatches("anything", undefined), false);
    assert.equal(secretMatches("", undefined), false);
    assert.equal(secretMatches("", ""), false);
    assert.equal(secretMatches(null, "real-secret"), false);
    assert.equal(secretMatches("wrong", "real-secret"), false);
    assert.equal(secretMatches("real-secret", "real-secret"), true);
});

test("the stored mime is decided on the BYTES, not the caller's header", async () => {
    const { sniffMime } = await loadFileType();
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const gif = Buffer.from("GIF89a-----");
    const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBP")]);
    const pdf = Buffer.from("%PDF-1.7\n...");
    const ftyp = (brand: string) => Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from(`ftyp${brand}`)]);

    // A lie in the header cannot change the answer.
    assert.equal(sniffMime(jpeg, "text/plain"), "image/jpeg");
    assert.equal(sniffMime(png, "application/pdf"), "image/png");
    assert.equal(sniffMime(gif, "image/jpeg"), "image/gif");
    assert.equal(sniffMime(webp, "image/png"), "image/webp");
    assert.equal(sniffMime(pdf, "image/png"), "application/pdf");
    // ISO/IEC 23008-12 major brands. iPhones emit `heic`/`heix` for stills and
    // the HEVC brands for a burst or a Live Photo still — an earlier `hei`
    // prefix check silently refused hevc/hevx, so those uploads came back
    // "unsupported-file-type" from a perfectly readable photo.
    for (const brand of ["heic", "heix", "hevc", "hevx", "msf1"]) {
        assert.equal(sniffMime(ftyp(brand), "image/jpeg"), "image/heic", brand);
    }
    // The generic HEIF brands keep their own content type.
    for (const brand of ["mif1", "heif"]) {
        assert.equal(sniffMime(ftyp(brand), "image/jpeg"), "image/heif", brand);
    }
    // An unrelated ftyp box (an MP4) is not a receipt.
    assert.equal(sniffMime(ftyp("isom"), "image/heic"), null);

    // text/plain is REFUSED outright now: QuickBooks cannot attach a .txt, so
    // accepting one meant reading it and then stranding it unbookable.
    assert.equal(sniffMime(Buffer.from("VENDOR: Lowes"), "text/plain; charset=utf-8"), null);
    // Anything unrecognised, and every empty file, is refused.
    assert.equal(sniffMime(Buffer.from("MZ\x90\x00"), "application/pdf"), null);
    assert.equal(sniffMime(Buffer.alloc(0), "text/plain"), null);
});

test("a Next-Action dispatch on a bypassed intake path is 403, not waved through", async () => {
    // Phase 2's Codex review: the bypass returned NextResponse.next() for ANY
    // request, including one carrying a `next-action` header. Next's action IDs
    // are global, so such a POST invokes SOMEONE ELSE'S action and never reaches
    // this route's code — meaning the in-handler x-receipt-intake-secret check,
    // which is the only gate these paths have, never runs. A machine caller
    // carries no session cookie, so the stale-cookie guard does not cover it
    // either. Bypassing the proxy must never also bypass the action boundary.
    const { default: proxy } = await loadProxy();
    const { NextRequest } = await import("next/server");
    const event = { waitUntil() {} } as any;
    // The proxy short-circuits to next() in development, so the real path is
    // only reachable with NODE_ENV=production.
    // NODE_ENV is typed read-only; the proxy reads it at call time, so a cast
    // is the only way to exercise the non-development branch here.
    const env = process.env as Record<string, string | undefined>;
    const prod = env.NODE_ENV;
    env.NODE_ENV = "production";

    try {
        for (const path of [
            "/api/receipts/intake",
            "/api/receipts/intake/",
            "/api/receipts/intake/abc123/archived",
        ]) {
            const res = await proxy(
                new NextRequest(`https://probuild.test${path}`, {
                    method: "POST",
                    headers: { "next-action": "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" },
                }),
                event,
            );
            assert.ok(res, `${path} produced no response`);
            assert.equal(res.status, 403, `${path} must refuse an action dispatch`);
            // NextResponse.next() carries x-middleware-next: 1. Anything else
            // means the proxy kept control, which is the point.
            assert.equal(res.headers.get("x-middleware-next"), null, path);
        }

        // A NORMAL request on the same paths still gets the bypass, so the
        // machine callers this route exists for are unaffected.
        const normal = await proxy(
            new NextRequest("https://probuild.test/api/receipts/intake", {
                method: "POST",
                headers: { "x-receipt-intake-secret": "whatever" },
            }),
            event,
        );
        assert.ok(normal, "the normal request produced no response");
        assert.equal(normal.headers.get("x-middleware-next"), "1", "the bypass still works without next-action");
    } finally {
        env.NODE_ENV = prod;
    }
});

test("the two-step upload paths bypass the proxy, exactly", async () => {
    const { isPublicProxyBypass } = await loadProxy();
    for (const path of [
        "/api/receipts/intake/start",
        "/api/receipts/intake/start/",
        "/api/receipts/intake/abc123/finalize",
        "/api/receipts/intake/abc123/finalize/",
    ]) {
        assert.equal(isPublicProxyBypass(path), true, path);
    }
    // ...and no wider than that.
    for (const path of [
        "/api/receipts/intake/start/extra",
        "/api/receipts/intake/abc123/finalize/extra",
        "/api/receipts/intake/abc123",
        "/api/receipts/intake/abc123/other",
    ]) {
        assert.equal(isPublicProxyBypass(path), false, path);
    }
});

test("a Next-Action dispatch is refused on the two-step paths too", async () => {
    // Same reasoning as the single-shot route: these bypass the proxy, so the
    // in-handler secret/session check is their ONLY gate, and an action dispatch
    // never reaches the handler at all.
    const { default: proxy } = await loadProxy();
    const { NextRequest } = await import("next/server");
    const event = { waitUntil() {} } as any;
    const env = process.env as Record<string, string | undefined>;
    const prod = env.NODE_ENV;
    env.NODE_ENV = "production";
    try {
        for (const path of ["/api/receipts/intake/start", "/api/receipts/intake/abc123/finalize"]) {
            const res = await proxy(
                new NextRequest(`https://probuild.test${path}`, {
                    method: "POST",
                    headers: { "next-action": "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" },
                }),
                event,
            );
            assert.ok(res, path);
            assert.equal(res.status, 403, `${path} must refuse an action dispatch`);
            assert.equal(res.headers.get("x-middleware-next"), null, path);
        }
        // A normal machine POST still passes through.
        const normal = await proxy(
            new NextRequest("https://probuild.test/api/receipts/intake/start", {
                method: "POST",
                headers: { "x-receipt-intake-secret": "whatever" },
            }),
            event,
        );
        assert.equal(normal!.headers.get("x-middleware-next"), "1");
    } finally {
        env.NODE_ENV = prod;
    }
});

test("provenance rules are shared by BOTH upload paths", async () => {
    // decideSource is the single implementation, so the two-step flow cannot
    // drift into accepting a caller-chosen source or sourceRef.
    const { decideSource, MAX_INLINE_UPLOAD_BYTES, MAX_STORED_BYTES } =
        await import("../src/lib/receipt-intake/intake-core");

    const session = { ok: true, via: "session", userVia: "next-auth", user: { id: "u1", role: "ADMIN" } } as any;
    assert.deepEqual(decideSource(session, { source: "drive" }), { ok: false, reason: "invalid-source" });
    assert.deepEqual(decideSource(session, { sourceRef: "web:x" }), { ok: false, reason: "sourceRef-not-allowed" });
    assert.deepEqual(decideSource(session, { uploadId: "nope" }), { ok: false, reason: "invalid-uploadId" });

    const scoped = decideSource(session, { uploadId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301" });
    assert.ok(scoped.ok);
    assert.equal(scoped.sourceRef, "web:u1:3f2504e0-4f89-41d3-9a0c-0305e82c3301", "scoped to the USER");

    const mobile = { ok: true, via: "session", userVia: "mobile-jwt", user: { id: "u2", role: "FIELD_CREW" } } as any;
    const minted = decideSource(mobile, {});
    assert.ok(minted.ok);
    assert.match(minted.sourceRef, /^mobile:[0-9a-f-]{36}$/);

    const secret = {
        ok: true, via: "secret", user: null, userVia: null,
        capability: "ingest", allowedSources: new Set(["drive", "email", "chat"]),
    } as any;
    assert.deepEqual(decideSource(secret, { source: "chat", sourceRef: "drive:x" }),
        { ok: false, reason: "sourceRef-namespace-mismatch" });
    assert.deepEqual(decideSource(secret, { source: "web", sourceRef: "web:x" }),
        { ok: false, reason: "invalid-source" });
    assert.ok(decideSource(secret, { source: "drive", sourceRef: "drive:FILE1" }).ok);

    // The inline body cap is well under the stored cap, which is the whole
    // reason the two-step path exists.
    assert.ok(MAX_INLINE_UPLOAD_BYTES < MAX_STORED_BYTES);
    assert.equal(MAX_STORED_BYTES, 15 * 1024 * 1024);
});

// ── Two secrets, two blast radii (Phase 3 gate, c) ─────────────────────────

test("each secret may only do its own job; cross-use is 403", async () => {
    const { authenticateIntake, INGEST_ALLOWED_SOURCES } = await loadAuth();
    const env = process.env as Record<string, string | undefined>;
    const before = { i: env.RECEIPT_INTAKE_SECRET, a: env.RECEIPT_ARCHIVE_SECRET };
    env.RECEIPT_INTAKE_SECRET = "ingest-key";
    env.RECEIPT_ARCHIVE_SECRET = "archive-key";
    const req = (secret: string) =>
        new Request("https://probuild.test/api/receipts/intake", {
            method: "POST",
            headers: { "x-receipt-intake-secret": secret },
        });

    try {
        // Right key, right job.
        const ingesting = await authenticateIntake(req("ingest-key"), "ingest");
        assert.ok(ingesting.ok);
        assert.equal(ingesting.via, "secret");
        if (ingesting.via !== "secret") throw new Error("unreachable");
        assert.equal(ingesting.capability, "ingest");
        assert.deepEqual([...ingesting.allowedSources].sort(), ["chat", "drive", "email"]);

        const archiving = await authenticateIntake(req("archive-key"), "archive");
        assert.ok(archiving.ok);
        if (archiving.via !== "secret") throw new Error("unreachable");
        assert.equal(archiving.capability, "archive");
        assert.equal(archiving.allowedSources.size, 0, "the mirror declares no sources at all");

        // Cross-use: authenticated, but holding the OTHER program's key. 403,
        // not 401 — saying so is what makes a mis-wired script obvious rather
        // than looking like a rotation problem.
        const forwarderReadingTheQueue = await authenticateIntake(req("ingest-key"), "archive");
        assert.equal(forwarderReadingTheQueue.ok, false);
        assert.equal((forwarderReadingTheQueue as { response: Response }).response.status, 403);

        const mirrorInjectingReceipts = await authenticateIntake(req("archive-key"), "ingest");
        assert.equal(mirrorInjectingReceipts.ok, false);
        assert.equal((mirrorInjectingReceipts as { response: Response }).response.status, 403);

        // An unknown secret is 401, not 403 — it is not authenticated at all.
        const stranger = await authenticateIntake(req("neither"), "ingest");
        assert.equal((stranger as { response: Response }).response.status, 401);

        assert.deepEqual([...INGEST_ALLOWED_SOURCES].sort(), ["chat", "drive", "email"]);
    } finally {
        env.RECEIPT_INTAKE_SECRET = before.i;
        env.RECEIPT_ARCHIVE_SECRET = before.a;
    }
});

test("configuring ONE value for both variables is refused, not silently merged", async () => {
    // Otherwise the split is undone by a copy-paste and nobody finds out.
    const { authenticateIntake } = await loadAuth();
    const env = process.env as Record<string, string | undefined>;
    const before = { i: env.RECEIPT_INTAKE_SECRET, a: env.RECEIPT_ARCHIVE_SECRET };
    env.RECEIPT_INTAKE_SECRET = "same";
    env.RECEIPT_ARCHIVE_SECRET = "same";
    try {
        const res = await authenticateIntake(
            new Request("https://probuild.test/api/receipts/intake", {
                method: "POST",
                headers: { "x-receipt-intake-secret": "same" },
            }),
            "ingest",
        );
        assert.equal(res.ok, false);
        assert.equal((res as { response: Response }).response.status, 401);
    } finally {
        env.RECEIPT_INTAKE_SECRET = before.i;
        env.RECEIPT_ARCHIVE_SECRET = before.a;
    }
});

test("an unset secret refuses that capability — never fails open", async () => {
    const { authenticateIntake } = await loadAuth();
    const env = process.env as Record<string, string | undefined>;
    const before = { i: env.RECEIPT_INTAKE_SECRET, a: env.RECEIPT_ARCHIVE_SECRET };
    delete env.RECEIPT_INTAKE_SECRET;
    delete env.RECEIPT_ARCHIVE_SECRET;
    try {
        for (const need of ["ingest", "archive"] as const) {
            const res = await authenticateIntake(
                new Request("https://probuild.test/api/receipts/intake", {
                    method: "POST",
                    headers: { "x-receipt-intake-secret": "anything" },
                }),
                need,
            );
            assert.equal(res.ok, false, need);
            assert.equal((res as { response: Response }).response.status, 401, need);
        }
    } finally {
        env.RECEIPT_INTAKE_SECRET = before.i;
        env.RECEIPT_ARCHIVE_SECRET = before.a;
    }
});

test("a secret may only declare the sources ITS key owns", async () => {
    const { decideSource } = await import("../src/lib/receipt-intake/intake-core");
    const ingest = {
        ok: true, via: "secret", user: null, userVia: null,
        capability: "ingest", allowedSources: new Set(["drive", "email", "chat"]),
    } as any;
    const archive = {
        ok: true, via: "secret", user: null, userVia: null,
        capability: "archive", allowedSources: new Set(),
    } as any;

    assert.ok(decideSource(ingest, { source: "drive", sourceRef: "drive:F1" }).ok);
    // The archive key owns no sources, so it can never mint an intake row even
    // if it somehow reached this code.
    assert.deepEqual(decideSource(archive, { source: "drive", sourceRef: "drive:F1" }),
        { ok: false, reason: "invalid-source" });
});

// ── The worker cron gate (Phase 2 gate, a) ─────────────────────────────────

test("the intake worker cron route uses the shared fail-closed gate", async () => {
    // Source assertion, because the hole was a BRANCH rather than a wrong
    // comparison: `!VERCEL && NODE_ENV !== "production" && !CRON_SECRET` is
    // satisfied by an UNSET environment, so any container or drifted preview
    // served this route — which books real money into QuickBooks — to anyone.
    const { readFileSync } = await import("node:fs");
    const raw = readFileSync(
        new URL("../src/app/api/cron/receipt-intake-worker/route.ts", import.meta.url),
        "utf8",
    );
    // Comments stripped: the route DESCRIBES the hole it closed, and a naive
    // scan reads that description as the hole itself.
    const route = raw
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .split("\n")
        .map(line => line.replace(/\/\/.*/, ""))
        .join("\n");

    assert.match(route, /isCronAuthorized\(request\)/, "uses the shared gate");
    assert.ok(!/isLocalDev/.test(route), "the fail-open branch is gone");
    assert.ok(!/authHeader === `Bearer/.test(route), "no plain string compare on a secret");
    assert.ok(!/process\.env\.VERCEL\b/.test(route), "no environment escape hatch");
    assert.ok(!/process\.env\.CRON_SECRET/.test(route), "the secret is read only by the shared helper");
});

test("isCronAuthorized fails closed on an unset secret and is constant-time", async () => {
    const { isCronAuthorized, bearerMatches } = await import("../src/lib/cron-auth");
    const env = process.env as Record<string, string | undefined>;
    const before = { s: env.CRON_SECRET, n: env.NODE_ENV };
    const req = (auth?: string) =>
        new Request("https://probuild.test/api/cron/receipt-intake-worker", {
            headers: auth ? { authorization: auth } : {},
        });
    try {
        env.NODE_ENV = "production";

        // No secret configured: refuse, rather than treat "unconfigured" as open.
        delete env.CRON_SECRET;
        assert.equal(isCronAuthorized(req("Bearer anything")), false);
        assert.equal(isCronAuthorized(req()), false);

        env.CRON_SECRET = "s3cret";
        assert.equal(isCronAuthorized(req("Bearer s3cret")), true);
        assert.equal(isCronAuthorized(req("Bearer wrong")), false);
        assert.equal(isCronAuthorized(req("s3cret")), false, "the scheme is part of the match");
        assert.equal(isCronAuthorized(req()), false);

        // Length is compared before the bytes, so a wrong-length header cannot
        // throw out of timingSafeEqual.
        assert.equal(bearerMatches("Bearer s3cre", "s3cret"), false);
        assert.equal(bearerMatches("Bearer s3cretttt", "s3cret"), false);
        assert.equal(bearerMatches(null, "s3cret"), false);
        assert.equal(bearerMatches("Bearer s3cret", undefined), false);
    } finally {
        env.CRON_SECRET = before.s;
        env.NODE_ENV = before.n;
    }
});

test("machine endpoints refuse a Server Action dispatch; portal actions still work", async () => {
    // The matcher's FIRST entry already routes every next-action request here
    // regardless of path, so these were reaching the proxy — the bypass was
    // waving them through before any action check ran.
    const { default: proxy } = await loadProxy();
    const { NextRequest } = await import("next/server");
    const event = { waitUntil() {} } as any;
    const env = process.env as Record<string, string | undefined>;
    const prod = env.NODE_ENV;
    env.NODE_ENV = "production";

    const dispatch = (p: string) =>
        proxy(new NextRequest(`https://probuild.test${p}`, {
            method: "POST",
            headers: { "next-action": "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" },
        }), event);

    try {
        for (const path of [
            "/api/cron/receipt-intake-worker",
            "/api/health/pipeline",
            "/api/integrations/qbo-receipts/create",
            "/api/webhook/stripe",
            "/api/twilio/sms",
        ]) {
            const res = await dispatch(path);
            assert.ok(res, path);
            assert.equal(res.status, 403, `${path} must refuse an action dispatch`);
            assert.equal(res.headers.get("x-middleware-next"), null, path);
        }

        // Routes that GENUINELY serve anonymous Server Actions are untouched —
        // 403ing them would break the client portal.
        for (const path of ["/api/portal/verify", "/api/payments/deposit-ingest", "/api/selections/item-comments"]) {
            const res = await dispatch(path);
            assert.equal(res!.headers.get("x-middleware-next"), "1", `${path} must still pass`);
        }

        // And an ordinary cron call is unaffected.
        const normal = await proxy(
            new NextRequest("https://probuild.test/api/cron/receipt-intake-worker", { method: "GET" }),
            event,
        );
        assert.equal(normal!.headers.get("x-middleware-next"), "1");
    } finally {
        env.NODE_ENV = prod;
    }
});
