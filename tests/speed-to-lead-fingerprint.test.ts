import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, existsSync, unlinkSync, readdirSync } from "node:fs";
import path from "node:path";
import { computeFingerprint, FINGERPRINT_INPUTS } from "../scripts/speed-to-lead-fingerprint.mjs";
import { currentFingerprint } from "../src/lib/speed-to-lead/fingerprint";

// Every Speed-to-Lead table/model this feature owns (spec Data Model) — a
// FUTURE migration that adds a column to one of these without also being
// added to FINGERPRINT_INPUTS would change "the related Prisma models"
// without lapsing LIVE activation, silently defeating the fingerprint's
// whole purpose. This is a tripwire, not a fix for a migration that exists
// today: it only fails once someone adds that future migration.
const SPEED_TO_LEAD_TABLE_NAMES = [
    "LeadIntakeEvent", "ContactEndpoint", "OutreachMessage", "OutreachVersion",
    "OutreachAttempt", "OutreachTemplate", "OutreachEvent", "OutreachDailyCounter",
    "ReadinessRecord",
];

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

test("computeFingerprint changes when the Speed-to-Lead action-wrapper slice of actions.ts changes", async () => {
    const target = path.join(__dirname, "..", "src", "lib", "actions.ts");
    const original = readFileSync(target, "utf8");
    const marker = "// BEGIN Speed-to-Lead v1 (PB-leads-001).";
    const idx = original.indexOf(marker);
    assert.ok(idx !== -1, "the BEGIN Speed-to-Lead marker must exist in actions.ts");
    const before = computeFingerprint();
    try {
        const touched = `${original.slice(0, idx + marker.length)}\n// fingerprint-test-touch\n${original.slice(idx + marker.length)}`;
        writeFileSync(target, touched);
        const after = computeFingerprint();
        assert.notEqual(before, after);
    } finally {
        writeFileSync(target, original);
    }
});

test("computeFingerprint changes when the lead-close hook slice of actions.ts changes", async () => {
    const target = path.join(__dirname, "..", "src", "lib", "actions.ts");
    const original = readFileSync(target, "utf8");
    const marker = "// Speed-to-Lead v1 (PB-leads-001) — BEGIN lead-close cancellation hook.";
    const idx = original.indexOf(marker);
    assert.ok(idx !== -1, "the lead-close hook BEGIN marker must exist in actions.ts (updateLeadStage)");
    const before = computeFingerprint();
    try {
        const touched = `${original.slice(0, idx + marker.length)}\n// fingerprint-test-touch\n${original.slice(idx + marker.length)}`;
        writeFileSync(target, touched);
        const after = computeFingerprint();
        assert.notEqual(before, after);
    } finally {
        writeFileSync(target, original);
    }
});

test("computeFingerprint changes when a Speed-to-Lead-dependent Lead/CompanySettings field is renamed in schema.prisma", async () => {
    const target = path.join(__dirname, "..", "prisma", "schema.prisma");
    const original = readFileSync(target, "utf8");
    const before = computeFingerprint();
    try {
        // Rename a field Speed-to-Lead depends on but does not own the model
        // of — this must lapse LIVE the same way a change to the feature's
        // OWN tables does, without requiring the WHOLE Lead/CompanySettings
        // model (shared with the rest of ProBuild) to be hashed.
        writeFileSync(target, original.replace("bookedAt", "bookedAtRenamed"));
        assert.throws(() => computeFingerprint(), /no longer declares field "bookedAt"/);
    } finally {
        writeFileSync(target, original);
    }
    assert.equal(computeFingerprint(), before);
});

test("computeFingerprint is UNAFFECTED by a change to actions.ts outside the Speed-to-Lead BEGIN..END slice", async () => {
    const target = path.join(__dirname, "..", "src", "lib", "actions.ts");
    const original = readFileSync(target, "utf8");
    const before = computeFingerprint();
    try {
        // Appended at the very end of the file — well outside the marked slice.
        writeFileSync(target, `${original}\n// fingerprint-test-touch (outside the Speed-to-Lead slice)\n`);
        const after = computeFingerprint();
        assert.equal(before, after, "an unrelated action elsewhere in actions.ts must never lapse LIVE activation");
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

test("every migration touching a Speed-to-Lead table is a fingerprint input — tripwire for a future migration that forgets to be added", () => {
    const migrationsRoot = path.join(__dirname, "..", "prisma", "migrations");
    const coveredPaths = new Set(FINGERPRINT_INPUTS.map(p => p.split(path.sep).join("/")));
    const tableRefPattern = new RegExp(`"(?:${SPEED_TO_LEAD_TABLE_NAMES.join("|")})"`);
    for (const entry of readdirSync(migrationsRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const migrationRelPath = `prisma/migrations/${entry.name}/migration.sql`;
        const migrationAbsPath = path.join(migrationsRoot, entry.name, "migration.sql");
        if (!existsSync(migrationAbsPath)) continue;
        const sql = readFileSync(migrationAbsPath, "utf8");
        if (!tableRefPattern.test(sql)) continue;
        assert.ok(
            coveredPaths.has(migrationRelPath),
            `${migrationRelPath} touches a Speed-to-Lead table but is not in FINGERPRINT_INPUTS — add it, or LIVE activation will not lapse when this feature's schema changes`,
        );
    }
});

test("currentFingerprint() reads SPEED_TO_LEAD_FINGERPRINT and trims it; unset is null", () => {
    assert.equal(currentFingerprint({ SPEED_TO_LEAD_FINGERPRINT: "  abc123  " } as unknown as NodeJS.ProcessEnv), "abc123");
    assert.equal(currentFingerprint({} as unknown as NodeJS.ProcessEnv), null);
    assert.equal(currentFingerprint({ SPEED_TO_LEAD_FINGERPRINT: "" } as unknown as NodeJS.ProcessEnv), null);
});
