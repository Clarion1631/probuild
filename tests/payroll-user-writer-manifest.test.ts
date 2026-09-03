/**
 * EVERY User writer in src/ is accounted for, the same way every TimeEntry
 * writer is (tests/payroll-writer-manifest.test.ts).
 *
 * WHY A SECOND MANIFEST. The pay-rate writers took the shared payroll advisory
 * lock; ACTIVATION did not. The Gusto roster is
 *
 *     (status = ACTIVATED AND payType = HOURLY)  OR  punched inside the period
 *
 * so flipping somebody PENDING -> ACTIVATED ADDS a row to a pay period's file.
 * lockPayrollPeriod reads that roster, hashes the CSVs and commits — and an
 * activation could commit in between, freezing a reviewed hash that already
 * disagreed with what the export would produce a second later. The export
 * cannot defend itself here: the row it would need to hold is one its own
 * roster query did not return, and SELECT ... FOR SHARE can only lock rows a
 * predicate matched. Only an advisory lock serialises against a PREDICATE.
 *
 * So every writer that names an export-affecting column goes through
 * withPayrollUserWrite (src/lib/payroll-period.ts), and this file is the
 * inversion that keeps it true: it enumerates the call sites that EXIST and
 * fails when the set changes. A new writer has to be classified here, as
 * guarded or as a documented exemption — it cannot be added silently.
 *
 * KEYED BY FILE + LINE + METHOD, for the reason spelled out at length in the
 * TimeEntry manifest: a file+method key collapses several call sites into one
 * entry whose "guarded" claim then has to be true of all of them, which is
 * exactly how an unguarded branch hid behind a guarded sibling. Line numbers
 * make that collapse impossible, at the cost of churn on unrelated edits.
 *
 * What this proves: no User write escapes review. What it does NOT prove: that
 * a "wrapped" entry holds the lock at runtime — that is
 * tests/payroll-activation-lock-db.test.ts, on two real connections.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { EXPORT_AFFECTING_USER_FIELDS, touchesExportUserState } from "../src/lib/payroll-period";

const SRC = path.join(__dirname, "..", "src");

/** `file:line::matched-call` for every User mutation in src/. */
function findWriters(): string[] {
    const found: string[] = [];
    // ANY receiver — a wrapped writer reads
    // `(tx as unknown as typeof prisma).user.delete`, so a receiver-anchored
    // pattern would go quiet on exactly the call sites that had just been
    // guarded.
    const pattern = /\.user\.(create|createMany|update|updateMany|delete|deleteMany|upsert)\b/g;

    const walk = (dir: string) => {
        for (const name of readdirSync(dir)) {
            const full = path.join(dir, name);
            if (statSync(full).isDirectory()) {
                walk(full);
                continue;
            }
            if (!/\.(ts|tsx)$/.test(name)) continue;
            const source = readFileSync(full, "utf8");
            const rel = path.relative(SRC, full).split(path.sep).join("/");
            for (const match of source.matchAll(pattern)) {
                const line = source.slice(0, match.index).split("\n").length;
                found.push(`${rel}:${line}::${match[1]}`);
            }
        }
    };
    walk(SRC);
    return found.sort();
}

/**
 * Every writer, and why it is safe.
 *
 * "wrapped" — inside withPayrollUserWrite, which takes the shared payroll
 *             advisory lock (tier 1) before the row is touched.
 * "guarded" — takes the same lock by another documented route.
 * "exempt"  — cannot change what the Gusto export contains, with the reason
 *             stated. Each exemption is an argument, not a shrug.
 */
const MANIFEST: Record<string, { kind: "wrapped" | "guarded" | "exempt"; why: string }> = {
    // ---- activation and profile edits: the round-34 hole --------------------
    "app/api/users/[id]/route.ts:189::update": {
        kind: "wrapped",
        why: "the Team Members editor writes name/role/status in one payload; status is half the roster predicate and name is printed in both CSVs",
    },
    "app/api/users/route.ts:248::update": {
        kind: "wrapped",
        why: "PATCH /api/users writes name/role/status — the same payload, for the same reason",
    },
    "app/api/manager/employees/[id]/route.ts:96::update": {
        kind: "wrapped",
        why: "the mobile manager screen can activate or disable somebody, which moves them on and off the roster",
    },
    "app/api/mobile/login/route.ts:40::update": {
        kind: "wrapped",
        why: "first PIN sign-in flips PENDING -> ACTIVATED, which adds an hourly member to the roster",
    },
    "app/api/mobile/google-login/route.ts:75::update": {
        kind: "wrapped",
        why: "first mobile Google sign-in performs the same activation",
    },
    "lib/auth.ts:78::update": {
        kind: "wrapped",
        why: "the NextAuth signIn callback performs the same activation on first web sign-in",
    },

    // ---- already-guarded payroll writers ------------------------------------
    "lib/pay-rate-write.ts:201::update": {
        kind: "guarded",
        why: "THE rate/payType writer — takes acquirePayrollWriteLock and then the owner row lock, in the global order",
    },
    "lib/actions.ts:15560::updateMany": {
        kind: "guarded",
        why: "applyGustoRateImport, inside a transaction that takes acquirePayrollWriteLock before any row lock",
    },
    "lib/actions.ts:15647::updateMany": {
        kind: "guarded",
        why: "setUserPayType, taking the same lock in the same order",
    },
    "app/api/users/[id]/route.ts:337::delete": {
        kind: "guarded",
        why: "runs through deleteParentWithTimeEntries, which takes acquirePayrollWriteLock and refuses while any of the member's hours sit in a locked period",
    },

    // ---- exempt --------------------------------------------------------------
    "app/api/users/route.ts:99::create": {
        kind: "exempt",
        why: "creates the row with status PENDING hard-coded and with no punches, so the roster predicate ((ACTIVATED and HOURLY) or punched) cannot match it; the payType that follows is written by applyRateChangeInTx, which does take the lock",
    },
    "app/api/clients/[id]/invite/route.ts:51::create": {
        kind: "exempt",
        why: "a CLIENT-role portal account: no payType, and User.status defaults to PENDING, so it cannot be on an hourly roster and it has no punches",
    },
    "app/api/users/[id]/route.ts:255::update": {
        kind: "exempt",
        why: "connect/disconnect on assignedProjects only — dispatch crew assignment reaches no column the export reads",
    },
    "lib/crew-auto-assign-sync.ts:129::update": {
        kind: "exempt",
        why: "connects In-Progress projects to a just-activated member; it touches assignedProjects and nothing else",
    },
    "lib/actions.ts:7809::update": {
        kind: "exempt",
        why: "markFieldUpdatesSeen writes fieldUpdatesSeenAt, a per-user UI timestamp that reaches no export",
    },
    "lib/actions.ts:15228::update": {
        kind: "exempt",
        why: "the WA meal-waiver signature stamp — it changes what settlement owes, which is a TimeEntry write, not a roster or CSV column",
    },
};

test("every User writer in src/ is classified — a new one cannot appear silently", () => {
    const found = findWriters();
    // The control: a scanner that found nothing would make every assertion
    // below vacuously true.
    assert.ok(found.length >= 15, `expected the User writers to be found, got ${found.length}`);
    assert.deepEqual(
        found,
        Object.keys(MANIFEST).sort(),
        "a User writer appeared, moved or vanished — classify it (wrapped in withPayrollUserWrite, or exempt with a reason)"
    );
});

test("every writer that can move the export is wrapped in withPayrollUserWrite", () => {
    for (const [key, entry] of Object.entries(MANIFEST)) {
        if (entry.kind !== "wrapped") continue;
        const location = key.slice(0, key.indexOf("::"));
        const file = location.slice(0, location.lastIndexOf(":"));
        const line = Number(location.slice(location.lastIndexOf(":") + 1));
        const lines = readFileSync(path.join(SRC, file), "utf8").split("\n");
        // The wrapper opens at most a few lines above the write it wraps.
        const window = lines.slice(Math.max(0, line - 13), line).join("\n");
        assert.match(
            window,
            /withPayrollUserWrite\(/,
            `${key} is classified as wrapped, but no withPayrollUserWrite call opens above it`
        );
    }
});

test("the classification actually distinguishes — it is neither all-guarded nor all-exempt", () => {
    const kinds = Object.values(MANIFEST).map((entry) => entry.kind);
    assert.ok(kinds.filter((kind) => kind === "wrapped").length >= 6, "all six activation/profile writers");
    assert.ok(kinds.filter((kind) => kind === "exempt").length >= 5, "and the writes that genuinely cannot move the export");
    for (const [key, entry] of Object.entries(MANIFEST)) {
        assert.ok(entry.why.length > 30, `${key} needs a real reason, not a shrug`);
    }
});

test("EXPORT_AFFECTING_USER_FIELDS matches what the export actually reads", () => {
    const source = readFileSync(path.join(SRC, "lib", "gusto-export-db.ts"), "utf8");
    // The roster SELECT. Every column named there reaches buildGustoExport and
    // therefore the hashed bytes, so every one of them has to be in the list.
    assert.match(source, /select: \{ id: true, name: true, email: true, payType: true, role: true \}/);
    for (const field of ["name", "email", "payType"]) {
        assert.ok(
            (EXPORT_AFFECTING_USER_FIELDS as readonly string[]).includes(field),
            `${field} is selected into the export but is not treated as export-affecting`
        );
    }
    // The roster PREDICATE, which is where status comes in.
    assert.match(source, /\{ status: "ACTIVATED", payType: "HOURLY" \}/);
    assert.ok((EXPORT_AFFECTING_USER_FIELDS as readonly string[]).includes("status"));

    // ...and `role`, since round 8. It prints in neither CSV, so it is not
    // about the BYTES — it decides ROSTER MEMBERSHIP. The roster is
    // `payrollEligibleUserWhere()` AND the predicate above, so moving an
    // account into or out of the staff set adds or removes a row, exactly like
    // activating somebody does.
    assert.match(source, /payrollEligibleUserWhere\(\)/, "the roster is gated on the staff predicate");
    assert.ok(
        (EXPORT_AFFECTING_USER_FIELDS as readonly string[]).includes("role"),
        "a role change moves somebody on or off the payroll roster"
    );

    // THE predicate lives in one place and is an ALLOWLIST. `role != "CLIENT"`
    // would be correct only until the next non-staff role exists.
    const config = readFileSync(path.join(SRC, "lib", "payroll-config.ts"), "utf8");
    assert.match(config, /export const PAYROLL_STAFF_ROLES = \["ADMIN", "MANAGER", "FIELD_CREW", "FINANCE"\]/);
    assert.match(config, /export function payrollEligibleUserWhere\(\)/);
    assert.ok(!/role: \{ not: "CLIENT" \}/.test(config), "a denylist is one new role away from being wrong");

    // Every payroll surface composes THAT predicate rather than its own copy.
    for (const [file, why] of [
        ["app/api/payroll/roster/route.ts", "the rates panel"],
        ["lib/gusto-export-db.ts", "the export roster"],
        ["lib/pay-rate-write.ts", "the one rate writer"],
        ["lib/actions.ts", "the CSV importer and setUserPayType"],
    ] as const) {
        const text = readFileSync(path.join(SRC, file), "utf8");
        assert.match(
            text,
            /payrollEligibleUserWhere\(\)|isPayrollEligibleRole\(/,
            `${why} must decide "is this an employee" with the shared predicate`
        );
    }
});

test("touchesExportUserState reads the payload by KEY, not by value", () => {
    assert.equal(touchesExportUserState({ status: "ACTIVATED" }), true);
    assert.equal(touchesExportUserState({ name: null }), true, "a null name is still a name change");
    assert.equal(touchesExportUserState({ payType: undefined }), true, "the key being present is what matters");
    // `role` counts since round 8 — it decides roster membership.
    assert.equal(touchesExportUserState({ role: "ADMIN" }), true);
    assert.equal(touchesExportUserState({ showOnDispatch: true }), false);
    assert.equal(touchesExportUserState({}), false);
    assert.equal(touchesExportUserState(null), false);
    assert.equal(touchesExportUserState(undefined), false);
});
