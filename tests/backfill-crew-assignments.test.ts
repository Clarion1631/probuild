import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { shouldAutoAssignUser, type AutoAssignUser } from "../src/lib/crew-auto-assign";

// scripts/backfill-crew-assignments.mjs runs under bare node (no TS transform,
// no "@/..." alias), so it re-states the eligibility rule in plain JS. These
// tests keep that copy honest: the script's source is read, its rule functions
// are extracted and evaluated, and their verdicts are compared against the
// authoritative TS implementation over a matrix of users. If someone changes
// one side without the other, this fails.

const SCRIPT_PATH = path.join(process.cwd(), "scripts", "backfill-crew-assignments.mjs");
const source = fs.readFileSync(SCRIPT_PATH, "utf8");

/** Pull the rule half of the script (constants + pure predicates) and evaluate it. */
function loadScriptRule(alwaysEnv?: string): (u: AutoAssignUser) => boolean {
    const start = source.indexOf("const TARGET_STATUS");
    const end = source.indexOf("async function main()");
    assert.ok(start > -1 && end > start, "could not locate the rule block in the backfill script");
    const body = source.slice(start, end);
    // The block reads process.env.CREW_AUTO_ASSIGN_ALWAYS; give it a controlled one.
    const factory = new Function(
        "process",
        `${body}\nreturn { shouldAutoAssignUser, TARGET_STATUS, ELIGIBLE_ROLE, ELIGIBLE_USER_STATUS };`,
    );
    const mod = factory({ env: alwaysEnv === undefined ? {} : { CREW_AUTO_ASSIGN_ALWAYS: alwaysEnv } });
    return mod.shouldAutoAssignUser;
}

const MATRIX: AutoAssignUser[] = [
    { id: "1", name: "Alex Crew", email: "alex@x.com", role: "FIELD_CREW", status: "ACTIVATED" },
    { id: "2", name: "Gone Crew", email: "gone@x.com", role: "FIELD_CREW", status: "DISABLED" },
    { id: "3", name: "New Crew", email: "new@x.com", role: "FIELD_CREW", status: "PENDING" },
    { id: "4", name: "CJ", email: "cj@x.com", role: "MANAGER", status: "ACTIVATED" },
    { id: "5", name: "C.J. Adkins", email: "cja@x.com", role: "ADMIN", status: "ACTIVATED" },
    { id: "6", name: "CJ", email: "cj@x.com", role: "MANAGER", status: "DISABLED" },
    { id: "7", name: "Other Manager", email: "om@x.com", role: "MANAGER", status: "ACTIVATED" },
    { id: "8", name: "Justin Admin", email: "ja@x.com", role: "ADMIN", status: "ACTIVATED" },
    { id: "9", name: "Fin Ance", email: "fa@x.com", role: "FINANCE", status: "ACTIVATED" },
    { id: "10", name: "Cjay Miller", email: "cjay@x.com", role: "MANAGER", status: "ACTIVATED" },
    { id: "11", name: null, email: null, role: "FIELD_CREW", status: "ACTIVATED" },
];

test("the backfill script's rule agrees with src/lib/crew-auto-assign.ts (default keys)", () => {
    const scriptRule = loadScriptRule();
    for (const u of MATRIX) {
        assert.equal(
            scriptRule(u),
            shouldAutoAssignUser(u),
            `disagreement on ${u.name ?? "(no name)"} / ${u.role} / ${u.status}`,
        );
    }
});

test("the backfill script's rule agrees when CREW_AUTO_ASSIGN_ALWAYS is overridden", () => {
    const scriptRule = loadScriptRule("cj@x.com");
    for (const u of MATRIX) {
        assert.equal(
            scriptRule(u),
            shouldAutoAssignUser(u, { alwaysAssignKeys: ["cj@x.com"] }),
            `disagreement on ${u.name ?? "(no name)"} / ${u.role} / ${u.status}`,
        );
    }
});

test("the backfill script targets In Progress, FIELD_CREW, ACTIVATED", () => {
    assert.match(source, /const TARGET_STATUS = "In Progress"/);
    assert.match(source, /const ELIGIBLE_ROLE = "FIELD_CREW"/);
    assert.match(source, /const ELIGIBLE_USER_STATUS = "ACTIVATED"/);
});

test("the backfill script is additive only — it never disconnects or deletes", () => {
    // Match code, not prose: `disconnect:` is the Prisma relation op (the
    // header comment says the word, and prisma.$disconnect() is just cleanup).
    assert.ok(!/\bdisconnect\s*:/.test(source), "backfill must never disconnect crew");
    assert.ok(!/prisma\.\w+\.delete(Many)?\(/.test(source), "backfill must never delete rows");
    assert.ok(/connect:/.test(source), "backfill should use connect semantics");
});

test("the backfill script does not touch ProjectAccess", () => {
    assert.ok(!/prisma\.projectAccess/.test(source), "backfill must not write ProjectAccess");
});

test("the backfill script supports --dry-run", () => {
    assert.ok(source.includes("--dry-run"), "backfill should offer a --dry-run mode");
});
