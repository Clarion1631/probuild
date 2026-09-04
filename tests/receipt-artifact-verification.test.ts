import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { isDriveFileId } from "../src/lib/google-drive";
import { configuredReceiptsSpace, parseChatDelivery } from "../src/lib/receipt-request-cards";

/**
 * Two "is this real?" checks that used to be syntactic and are now answered by
 * the systems that actually know: Drive for a signed memo's PDF, and the
 * configured space for a card's thread.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// ── The signed memo's artifact is VERIFIED (round-17 item 5) ───────────────

test("a Drive file id is long and opaque; a URL or a scrap is not one", () => {
    for (const good of ["1sEISJBJaGRYpivooQJBR", "0B-abc_DEF-123456789", "a".repeat(44)]) {
        assert.equal(isDriveFileId(good), true, good);
    }
    for (const bad of [
        "x",                                    // the gate's own example
        "short",
        "",
        "   ",
        "https://drive.google.com/file/d/1abc/view",
        "1abc/def",
        "1abc def",
        null,
        undefined,
        12345,
    ]) {
        assert.equal(isDriveFileId(bad), false, String(bad));
    }
});

test("the three Drive outcomes map to three different answers", () => {
    const route = readFileSync(join(repoRoot, "src/app/api/automation/receipt-requests/answers/route.ts"), "utf8");
    // A missing id, or one that is not a Drive id at all: 422, nothing written.
    assert.match(route, /if \(!isDriveFileId\(body\.pdf_id\)\) \{[\s\S]{0,400}status: 422/);
    // Google answered "not there": 422 as well — retrying will not change it.
    assert.match(route, /if \(probe\.kind === "missing"\) \{[\s\S]{0,300}status: 422/);
    // We could not ASK: 503 with retry. Never a recorded resolution — and a
    // MISSING CREDENTIAL is named separately, because it will not fix itself.
    assert.match(route, /if \(probe\.kind === "unreachable"\) \{[\s\S]{0,1200}retry: true[\s\S]{0,200}status: 503/);
    assert.match(route, /const unconfigured = probe\.reason === "no-drive-token";/);
    assert.match(route, /reason: unconfigured \? "drive-not-configured" : "artifact-unverifiable",/);
    // FOUND is not enough on its own — any Drive object at that id passes it.
    // Only a real PDF may be recorded as a signed memo.
    assert.match(route, /if \(probe\.mimeType !== "application\/pdf"\) \{[\s\S]{0,300}reason: "not-a-pdf"[\s\S]{0,200}status: 422/);
    // The probe runs BEFORE the write loop, and the id is persisted.
    const probeAt = route.indexOf("const probe = await probeDriveFile(pdfId);");
    const writeAt = route.indexOf("details.resolution = \"memo-signed\";");
    assert.ok(probeAt > 0 && writeAt > probeAt, "verify, THEN record");
    assert.match(route, /details\.pdfId = pdfId;/);
    // A URL is no longer proof on its own, and signature_id is gone.
    assert.doesNotMatch(route, /signature_id/);
    assert.doesNotMatch(route, /MAX_SIGNATURE_ID_LEN/);
});

test("the probe never falls back to mock data, and reads metadata only", () => {
    // The other Drive helpers degrade to mocks with no token — right for a UI,
    // catastrophic here: "we could not ask Google" would come back as "the file
    // is there" and a resolution would be recorded against nothing.
    const drive = readFileSync(join(repoRoot, "src/lib/google-drive.ts"), "utf8");
    const fn = drive.slice(drive.indexOf("export async function probeDriveFile("));
    const body = fn.slice(0, fn.indexOf("\n}"));
    // The STORED company credential counts too — an admin who completed the
    // connect flow was otherwise still told "no token" on every call.
    assert.match(body, /if \(!\(await ensureDriveAuth\(\)\)\.ok\) return \{ kind: "unreachable", reason: "no-drive-token" \};/);
    const client = readFileSync(join(repoRoot, "src/lib/gmail-client.ts"), "utf8");
    assert.match(client, /googleDriveRefreshToken: true/, "ensureDriveAuth reads the stored credential");
    assert.doesNotMatch(body, /getMock/, "no mock fallback on the verification path");
    // Metadata, bounded — never a download. mimeType is what lets the caller
    // tell a real PDF from any other Drive object at the same id.
    assert.match(body, /fields: "id, name, trashed, webViewLink, mimeType"/);
    assert.match(body, /\{ timeout: timeoutMs \}/);
    assert.doesNotMatch(body, /alt: "media"/);
    // A trashed file is not durable: it disappears on its own.
    assert.match(body, /if \(data\.trashed\) return \{ kind: "missing", reason: "trashed" \};/);
    // 404/410 are answers; everything else is us being unable to ask.
    assert.match(body, /if \(status === 404 \|\| status === 410\) return \{ kind: "missing"/);
});

// ── A card's thread must be in OUR space (round-17 item 6) ─────────────────

test("the space comes from configuration, explicit or derived from the webhook", () => {
    assert.equal(
        configuredReceiptsSpace({ RECEIPTS_CHAT_WEBHOOK: "https://chat.googleapis.com/v1/spaces/AAQAKhvMYtg/messages?key=k&token=t" }),
        "AAQAKhvMYtg",
    );
    // An explicit override wins, with or without the `spaces/` prefix.
    assert.equal(configuredReceiptsSpace({ RECEIPTS_CHAT_SPACE: "spaces/AAQAOther", RECEIPTS_CHAT_WEBHOOK: "https://chat.googleapis.com/v1/spaces/AAQAKhvMYtg/messages" }), "AAQAOther");
    assert.equal(configuredReceiptsSpace({ RECEIPTS_CHAT_SPACE: "AAQAOther" }), "AAQAOther");
    // Nothing configured, or a webhook that is not one: no space.
    assert.equal(configuredReceiptsSpace({}), null);
    assert.equal(configuredReceiptsSpace({ RECEIPTS_CHAT_WEBHOOK: "not a url" }), null);
    assert.equal(configuredReceiptsSpace({ RECEIPTS_CHAT_WEBHOOK: "https://chat.googleapis.com/v1/messages" }), null);
});

test("a well-formed pair from ANOTHER space is refused", () => {
    const env = { RECEIPTS_CHAT_WEBHOOK: "https://chat.googleapis.com/v1/spaces/AAQAKhvMYtg/messages?key=k" };
    const thread = "spaces/AAQAKhvMYtg/threads/xyz-123";
    const message = "spaces/AAQAKhvMYtg/messages/xyz-123.abc";
    assert.deepEqual(parseChatDelivery(thread, message, env), { threadName: thread, messageName: message });

    // THE DANGEROUS SHAPE: syntactically perfect, same space on both halves,
    // and pointing at a room the crew cannot see. It would mark the card
    // delivered and send the bridge looking for replies that can never arrive.
    assert.equal(
        parseChatDelivery("spaces/AAQAElse/threads/xyz-123", "spaces/AAQAElse/messages/xyz-123.abc", env),
        null,
    );
    // Unconfigured is REFUSED, not waved through — "we could not check" is not
    // "it checked out".
    assert.equal(parseChatDelivery(thread, message, {}), null);
    // And the two halves must still agree with each other.
    assert.equal(parseChatDelivery(thread, "spaces/AAQAElse/messages/xyz-123.abc", env), null);
});
