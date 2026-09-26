import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import path from "node:path";
import { computeFingerprint } from "../scripts/speed-to-lead-fingerprint.mjs";
import { currentFingerprint } from "../src/lib/speed-to-lead/fingerprint";

test("computeFingerprint is deterministic across two runs with no code change", () => {
    assert.equal(computeFingerprint(), computeFingerprint());
});

test("computeFingerprint changes when a covered file's content changes", async () => {
    const target = path.join(__dirname, "..", "src", "lib", "speed-to-lead", "constants.ts");
    const original = readFileSync(target, "utf8");
    const before = computeFingerprint();
    try {
        writeFileSync(target, `${original}\n// fingerprint-test-touch\n`);
        const after = computeFingerprint();
        assert.notEqual(before, after);
    } finally {
        writeFileSync(target, original);
    }
});

test("computeFingerprint is unaffected by files outside its covered paths", async () => {
    const scratch = path.join(__dirname, "..", "src", "lib", "speed-to-lead-fingerprint-scratch-file.ts");
    const before = computeFingerprint();
    try {
        writeFileSync(scratch, "// unrelated file, not under src/lib/speed-to-lead\n");
        const after = computeFingerprint();
        assert.equal(before, after);
    } finally {
        if (existsSync(scratch)) unlinkSync(scratch);
    }
});

test("currentFingerprint() reads SPEED_TO_LEAD_FINGERPRINT and trims it; unset is null", () => {
    assert.equal(currentFingerprint({ SPEED_TO_LEAD_FINGERPRINT: "  abc123  " } as unknown as NodeJS.ProcessEnv), "abc123");
    assert.equal(currentFingerprint({} as unknown as NodeJS.ProcessEnv), null);
    assert.equal(currentFingerprint({ SPEED_TO_LEAD_FINGERPRINT: "" } as unknown as NodeJS.ProcessEnv), null);
});
