import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
/** EOL-normalised: this repo is checked out CRLF on Windows and LF in CI. */
const read = (rel: string) => readFileSync(join(repoRoot, rel), "utf8").replace(/\r\n/g, "\n");

/**
 * The snapshot's `bankPull` object, as source text.
 *
 * A structural read rather than a regex per field: what is being asserted is
 * that the probe's values REACH `evaluatePipelineHealth`, and the only thing
 * standing between them is this literal.
 */
function snapshotBankPullBlock(): string {
    const health = read("src/lib/pipeline-health.ts");
    const at = health.indexOf("        bankPull: {\n            status: bankPull.status,");
    assert.ok(at > 0, "the snapshot assembly must still build a bankPull object");
    const end = health.indexOf("\n        },", at);
    assert.ok(end > at);
    return health.slice(at, end);
}

// ═══ AC14 — the snapshot carries what the probe read ═══════════════════════

test("the quarantine count the probe reads reaches the verdict", () => {
    /**
     * PRE-EXISTING, AND SILENT. `readBankPullState` has computed
     * `quarantinedCount` since round 48 — including the `-1` unreadable
     * sentinel — but the snapshot never copied it, so `evaluatePipelineHealth`
     * read `undefined` every time and neither `bank-quarantine:<n>` nor
     * `bank-quarantine-unreadable` could ever fire. The reason existed; the
     * wire did not.
     */
    assert.match(snapshotBankPullBlock(), /quarantinedCount: bankPull\.value\.quarantinedCount/);
});
