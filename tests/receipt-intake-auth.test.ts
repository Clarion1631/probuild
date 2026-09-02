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

    // text/plain has no signature, so it is the only type taken on its word.
    assert.equal(sniffMime(Buffer.from("VENDOR: Lowes"), "text/plain; charset=utf-8"), "text/plain");
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
