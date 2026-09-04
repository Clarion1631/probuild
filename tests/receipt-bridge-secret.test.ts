import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

process.env.NEXTAUTH_SECRET ??= "test-secret";
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";

/**
 * THREE secrets, three capability lists, and cross-use is a 403.
 *
 * The bridge runs inside Beverly's Apps Script project. Handing it the intake
 * key would give a program we do not own the power to book a Purchase — the
 * same argument that split ingest from archive in Phase 1, a third time.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const INGEST = "ingest-secret-value";
const ARCHIVE = "archive-secret-value";
const BRIDGE = "bridge-secret-value";

function setSecrets(over: { ingest?: string; archive?: string; bridge?: string } = {}) {
    process.env.RECEIPT_INTAKE_SECRET = over.ingest ?? INGEST;
    process.env.RECEIPT_ARCHIVE_SECRET = over.archive ?? ARCHIVE;
    process.env.RECEIPT_BRIDGE_SECRET = over.bridge ?? BRIDGE;
}

const req = (secret: string | null) => new Request("https://probuild.test/api/automation/receipt-requests/threads", {
    headers: secret === null ? {} : { "x-receipt-intake-secret": secret },
});

test("the bridge key opens a bridge endpoint; the other two get a 403", async () => {
    const { authenticateBridge } = await import("../src/lib/receipt-intake/intake-auth");
    setSecrets();

    const good = authenticateBridge(req(BRIDGE));
    assert.equal(good.ok, true);

    for (const [label, secret, have] of [
        ["the forwarders' key", INGEST, "ingest"],
        ["the archive mirror's key", ARCHIVE, "archive"],
    ] as const) {
        const verdict = authenticateBridge(req(secret));
        assert.equal(verdict.ok, false, label);
        if (verdict.ok) return;
        assert.equal(verdict.response.status, 403, `${label} is authenticated, just not for this`);
        assert.deepEqual(await verdict.response.json(), { ok: false, reason: "forbidden", have, need: "bridge" });
    }
});

test("an unknown key, and a missing header, are 401 — never 403", async () => {
    const { authenticateBridge } = await import("../src/lib/receipt-intake/intake-auth");
    setSecrets();
    for (const secret of ["nonsense", "", null]) {
        const verdict = authenticateBridge(req(secret));
        assert.equal(verdict.ok, false, String(secret));
        if (verdict.ok) return;
        assert.equal(verdict.response.status, 401);
    }
});

test("an UNSET secret refuses that capability outright", async () => {
    const { authenticateBridge } = await import("../src/lib/receipt-intake/intake-auth");
    setSecrets();
    delete process.env.RECEIPT_BRIDGE_SECRET;
    // Never "allow because unset" — and an empty header must not match an
    // absent variable either.
    for (const secret of [BRIDGE, ""]) {
        const verdict = authenticateBridge(req(secret));
        assert.equal(verdict.ok, false, secret || "(empty)");
        if (verdict.ok) return;
        assert.equal(verdict.response.status, 401);
    }
    setSecrets();
});

test("two secrets sharing a value are refused, not resolved in some order", async () => {
    const { authenticateBridge } = await import("../src/lib/receipt-intake/intake-auth");
    // Silently re-merging capabilities that exist to be separate is the whole
    // failure this rule prevents.
    setSecrets({ bridge: INGEST });
    const verdict = authenticateBridge(req(INGEST));
    assert.equal(verdict.ok, false);
    if (verdict.ok) return;
    assert.equal(verdict.response.status, 401);
    setSecrets();
});

test("the bridge key cannot reach an INTAKE capability either", async () => {
    // The refusal is symmetric: Beverly's key must not create, read or archive
    // a ReceiptIntake row.
    const { authenticateIntake } = await import("../src/lib/receipt-intake/intake-auth");
    setSecrets();
    for (const need of ["ingest", "archive"] as const) {
        const verdict = await authenticateIntake(req(BRIDGE), need);
        assert.equal(verdict.ok, false, need);
        if (verdict.ok) return;
        assert.equal(verdict.response.status, 403);
        assert.deepEqual(await verdict.response.json(), { ok: false, reason: "forbidden", have: "bridge", need });
    }
});

test("both bridge routes go through authenticateBridge, with no session fallback", () => {
    for (const file of [
        "src/app/api/automation/receipt-requests/threads/route.ts",
        "src/app/api/automation/receipt-requests/answers/route.ts",
    ]) {
        const source = readFileSync(join(repoRoot, file), "utf8");
        assert.match(source, /const auth = authenticateBridge\(request\);/, file);
        assert.match(source, /if \(!auth\.ok\) return auth\.response;/, file);
        // The old shape compared against the INTAKE secret by hand.
        assert.doesNotMatch(source, /process\.env\.RECEIPT_INTAKE_SECRET/, file);
        assert.doesNotMatch(source, /authenticateMobileOrSession|getServerSession/, file);
    }
});

test("each secret's capability list is documented where a human will look", () => {
    const auth = readFileSync(join(repoRoot, "src/lib/receipt-intake/intake-auth.ts"), "utf8");
    const env = readFileSync(join(repoRoot, ".env.example"), "utf8");
    const spec = readFileSync(join(repoRoot, "docs/plans/PHASE-2-QUEUE-AND-MEMOS-SPEC.md"), "utf8");
    for (const name of ["RECEIPT_INTAKE_SECRET", "RECEIPT_ARCHIVE_SECRET", "RECEIPT_BRIDGE_SECRET"]) {
        assert.match(auth, new RegExp(name), `intake-auth.ts documents ${name}`);
        assert.match(env, new RegExp(`^${name}=`, "m"), `.env.example carries ${name}`);
    }
    assert.match(auth, /MAY NOT:/, "the lists say what each key cannot do, not just what it can");
    assert.match(spec, /RECEIPT_BRIDGE_SECRET/);
    assert.doesNotMatch(spec, /`RECEIPT_INTAKE_SECRET` \(Phase 1's, reused\) gates both bridge endpoints/);
});
