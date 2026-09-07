/**
 * NO TIME-ENTRY ROUTE MAY HAND A RAW ROW TO A CLIENT.
 *
 * The projections shipped one route at a time — GET first (round 8), then POST,
 * the clock-out and both conflict bodies (round 9) — because each one had to be
 * FOUND. The list endpoint was fixed while the mutation responses beside it
 * still returned whole Prisma rows, and nothing failed.
 *
 * This is the inversion. It enumerates every `NextResponse.json(` in the
 * time-entry route family, drops the ones that provably carry no entry (an
 * object literal whose every key is a known-safe one), and requires each of the
 * rest to be classified here with HOW it is projected. A new response cannot be
 * added silently, and an existing one cannot quietly go back to returning a row.
 *
 * KEYED BY FILE + LINE, like the writer manifests, and with the same deliberate
 * cost: any edit above a response shifts the numbers below it. That churn is the
 * price of a key that cannot lie by collapsing two call sites into one.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const SRC = path.join(__dirname, "..", "src");
const ROOT = path.join(SRC, "app", "api", "time-entries");

/**
 * Keys that cannot hold a TimeEntry row.
 *
 * Anything else in a response body — a spread, a bare identifier, an unknown
 * key — is treated as entry-bearing and has to be classified. Erring that way
 * round is the point: a denylist of known-bad shapes would pass for every shape
 * nobody has thought of.
 */
const SAFE_KEYS = new Set([
    "error",
    "code",
    "ok",
    "blocking",
    "lockedPeriods",
    "periodStart",
    "periodEnd",
    "userIds",
    // A list of TimeEntry IDS in a refusal body, not entries — structurally
    // identical to `userIds` above (round 11, finding 2).
    "entryIds",
    "id",
    "mealSkipStatus",
    "mealSkipDecidedAt",
    "mealSkipDecidedById",
    "mealSkipReason",
    "alreadyRequested",
    "waiverOnFile",
]);

type Response = { key: string; arg: string };

/** Every `NextResponse.json(` in the family, with its first argument. */
function findResponses(): Response[] {
    const found: Response[] = [];
    const walk = (dir: string) => {
        for (const name of readdirSync(dir)) {
            const full = path.join(dir, name);
            if (statSync(full).isDirectory()) {
                walk(full);
                continue;
            }
            if (!/\.ts$/.test(name)) continue;
            const source = readFileSync(full, "utf8");
            const rel = path.relative(SRC, full).split(path.sep).join("/");
            for (const match of source.matchAll(/NextResponse\.json\(/g)) {
                const line = source.slice(0, match.index).split("\n").length;
                // Balanced scan to the closing paren, so a nested object or call
                // cannot truncate the argument.
                let depth = 1;
                let i = (match.index as number) + match[0].length;
                let arg = "";
                for (; i < source.length && depth > 0; i += 1) {
                    const char = source[i];
                    if (char === "(" || char === "{" || char === "[") depth += 1;
                    else if (char === ")" || char === "}" || char === "]") {
                        depth -= 1;
                        if (depth === 0) break;
                    }
                    arg += char;
                }
                found.push({ key: `${rel}:${line}`, arg: arg.replace(/\s+/g, " ").trim() });
            }
        }
    };
    walk(ROOT);
    return found.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * Split a source-level expression list on TOP-LEVEL commas, respecting brackets
 * and string literals.
 *
 * Both things matter. Ignoring brackets merges the response init into the body;
 * ignoring quotes finds a "key" in every comma of an error message, which is how
 * the first version of this flagged a dozen plain `{ error: "..." }` bodies as
 * entry-bearing.
 */
function splitTopLevel(text: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let quote = "";
    let current = "";
    for (let i = 0; i < text.length; i += 1) {
        const char = text[i];
        if (quote) {
            if (char === "\\") {
                current += char + (text[i + 1] ?? "");
                i += 1;
                continue;
            }
            if (char === quote) quote = "";
            current += char;
            continue;
        }
        if (char === '"' || char === "'" || char === "`") {
            quote = char;
            current += char;
            continue;
        }
        if ("({[".includes(char)) depth += 1;
        else if (")}]".includes(char)) depth -= 1;
        if (char === "," && depth === 0) {
            parts.push(current);
            current = "";
            continue;
        }
        current += char;
    }
    parts.push(current);
    return parts;
}

/**
 * Does this response provably carry no entry?
 *
 * True only when the FIRST argument is an object literal whose every top-level
 * key is a known-safe one. The second argument (`{ status: 409 }`) is dropped
 * first: it is the response init and can never hold a row, but leaving it in
 * made `status` read as a body key and flagged every error response.
 */
function isProvablySafe(arg: string): boolean {
    // Line comments go first: one of these bodies carries a `// Coded so the
    // client can react` note whose words would otherwise read as keys.
    const first = (splitTopLevel(arg.replace(/\/\/[^\n]*/g, ""))[0] ?? "").trim();
    if (!first.startsWith("{")) return false;
    const body = first.slice(1, first.lastIndexOf("}"));
    if (body.includes("...")) return false; // a spread can carry anything
    for (const part of splitTopLevel(body)) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        const key = trimmed.split(":")[0].trim();
        if (!SAFE_KEYS.has(key)) return false;
    }
    return true;
}

/**
 * Every entry-bearing response, and how it is projected.
 *
 * "serializer" — goes through serializeTimeEntryJson at the response boundary.
 * "select"     — the variable was read with an explicit projected `select`, so
 *                the row never had the extra columns to leak. The named symbol
 *                must appear in the same file.
 */
const MANIFEST: Record<string, { kind: "serializer" | "select" | "no-entry"; via: string; why: string }> = {
    "app/api/time-entries/route.ts:143": {
        kind: "serializer", via: "serializeTimeEntryJson",
        why: "POST: retained request replay uses the same audience projection as a created entry",
    },
    "app/api/time-entries/route.ts:365": {
        kind: "serializer", via: "serializeTimeEntryJson",
        why: "POST: existing-open conflict embeds only a projected entry",
    },
    "app/api/time-entries/route.ts:896": {
        kind: "no-entry",
        via: "error.message",
        why: "a ClockOutInputError body; the spread only folds in `code`, which is why it needs saying rather than being obvious to the scanner",
    },
    "app/api/time-entries/route.ts:93": {
        kind: "select",
        via: "timeEntrySelect(canSeePay)",
        why: "GET: the list query itself is projected per audience",
    },
    "app/api/time-entries/route.ts:377": {
        kind: "serializer",
        via: "serializeTimeEntryJson",
        why: "POST: the created row, projected at the boundary",
    },
    "app/api/time-entries/route.ts:600": {
        kind: "serializer",
        via: "serializeTimeEntryJson",
        why: "PUT: the up-front ALREADY_CLOCKED_OUT body embeds the entry",
    },
    "app/api/time-entries/route.ts:919": {
        kind: "serializer",
        via: "serializeTimeEntryJson",
        why: "PUT: the raced ALREADY_CLOCKED_OUT body embeds the entry",
    },
    "app/api/time-entries/route.ts:937": {
        kind: "serializer",
        via: "serializeTimeEntryJson",
        why: "PUT: the settled row after a successful clock-out",
    },
    "app/api/time-entries/[id]/route.ts:197": {
        kind: "select",
        via: "responseSelect",
        why: "PATCH telemetry branch: re-read with the audience projection",
    },
    "app/api/time-entries/[id]/route.ts:650": {
        kind: "select",
        via: "responseSelect",
        why: "PATCH edit branch: re-read with the audience projection",
    },
    "app/api/time-entries/[id]/logistics/route.ts:181": {
        kind: "select",
        via: "resultSelect",
        why: "already-applied body, read with a narrow explicit select",
    },
    "app/api/time-entries/[id]/logistics/route.ts:184": {
        kind: "select",
        via: "resultSelect",
        why: "routed entry, read with the same narrow select",
    },
    "app/api/time-entries/[id]/meal-skip/route.ts:184": {
        kind: "select",
        via: "mealSkipStatus: true",
        why: "five skip-decision columns, never a row",
    },
};

test("the scanner finds the responses — the control", () => {
    const all = findResponses();
    // Without this every assertion below is vacuously true.
    assert.ok(all.length >= 60, `expected the time-entry responses to be found, got ${all.length}`);
    // Named by its CLASSIFICATION, not by a line number. Pinning the line here
    // meant every unrelated edit above it broke this control and taught the
    // next person that the number is noise — which is the opposite of what a
    // line-keyed manifest needs. The manifest is still line-keyed on purpose
    // (that is the tripwire); this control just does not need to duplicate it.
    const clockOut = Object.entries(MANIFEST).find(
        ([, entry]) => entry.why === "PUT: the settled row after a successful clock-out"
    );
    assert.ok(clockOut, "the clock-out success response must still be classified");
    assert.ok(
        all.some((response) => response.key === clockOut![0]),
        "the clock-out success response must be among the ones the scanner finds"
    );
});

test("the safe-shape filter distinguishes — it is not just passing everything", () => {
    // Both halves asserted, so a filter that answered one way for everything
    // could not hide behind the manifest below.
    assert.equal(isProvablySafe('{ error: "nope" }'), true);
    assert.equal(isProvablySafe('{ error: "nope", code: "X" }'), true);
    assert.equal(isProvablySafe("{ ...current, alreadyApplied: true }"), false, "a spread can carry anything");
    assert.equal(isProvablySafe("entry"), false, "a bare identifier is not an object literal");
    assert.equal(isProvablySafe('{ error: "x", entry: row }'), false, "`entry` is not a safe key");
    assert.equal(isProvablySafe("{ laborCost: 1 }"), false);
    // A comma inside an error message is not a key boundary...
    assert.equal(isProvablySafe('{ error: "moved, reload", code: "X" }'), true);
    // ...and neither is one inside a comment.
    assert.equal(isProvablySafe(`{ error: "x", // one, two
 code: "X" }`), true);
});

test("every entry-bearing time-entry response is classified and projected", () => {
    const entryBearing = findResponses().filter((response) => !isProvablySafe(response.arg));
    assert.deepEqual(
        entryBearing.map((response) => response.key).sort(),
        Object.keys(MANIFEST).sort(),
        "a time-entry response appeared, moved or vanished — classify it, or it is returning a raw row"
    );

    // ...and each one really does use the mechanism it claims.
    for (const response of entryBearing) {
        const entry = MANIFEST[response.key];
        const file = response.key.slice(0, response.key.lastIndexOf(":"));
        const source = readFileSync(path.join(SRC, file), "utf8");
        assert.ok(source.includes(entry.via), `${response.key} claims ${entry.via}, which is not in ${file}`);
        if (entry.kind === "no-entry") {
            // Only a spread should ever need this classification — a bare
            // identifier or an unknown key is a row until proven otherwise.
            assert.match(response.arg, /\.\.\./, `${response.key} is classified no-entry but is not a spread`);
            continue;
        }
        if (entry.kind === "serializer") {
            assert.match(
                response.arg,
                /serializeTimeEntryJson\(/,
                `${response.key} must project AT the response, not merely somewhere in the file`
            );
        }
    }
});

test("no time-entry response hands over a bare prisma result", () => {
    // The specific regression: `NextResponse.json(JSON.parse(JSON.stringify(x)))`
    // where x came straight off the model. Every surviving round trip has to be
    // over a variable that a projected select produced.
    const raw = findResponses().filter(
        (response) => /JSON\.parse\(JSON\.stringify\(/.test(response.arg) && !/serializeTimeEntryJson/.test(response.arg)
    );
    for (const response of raw) {
        const entry = MANIFEST[response.key];
        assert.ok(entry, `${response.key} round-trips a value with no classification`);
        assert.equal(
            entry.kind,
            "select",
            `${response.key} round-trips a raw value and does not go through the serializer`
        );
    }
    // The control: there ARE such responses, so the loop is not empty.
    assert.ok(raw.length >= 3, `expected the select-projected round trips, got ${raw.length}`);
});
