/**
 * The create-marker grammar, and the apply script's target proof.
 *
 * Codex round 48, findings 5 and 6.
 *
 * A marker is the only durable record that a QuickBooks document may exist for
 * a record. Everything downstream — adopt, replay, `confirmed-none` — decides
 * from what this grammar parses out of it, so a marker that parses as SOMETHING
 * ELSE is worse than one that fails to parse at all: a lookup for the wrong
 * document number finds nothing, and an operator is then offered "confirm none
 * exists", which clears the claim for a real, collectible invoice.
 *
 * The rule is therefore: every recognised field parses completely, or the whole
 * identity is null.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
    composeCreateMarker,
    parseCreateMarker,
    isComposableDocNumber,
    MARKER_DOC_NUMBER_MAX_LEN,
    AMBIGUOUS_CREATE_MARKER,
    CREATE_IN_FLIGHT_MARKER,
    type CreateIdentity,
} from "../src/lib/qbo-create-markers";
import { QB_DOC_NUMBER_MAX_LEN } from "../src/lib/quickbooks";
import { readFileSync } from "node:fs";

const AT = new Date(1_730_000_000_000);

const FULL: CreateIdentity = {
    docNumber: "EST-00237",
    privateNote: "ProBuild EST-00237 - Mesplay Kitchen",
    issuanceHash: "4f1c2ab90de7331a",
    expectedTotal: 1089.5,
    expectedTax: 89.5,
    realmId: "9130354",
    customerId: "58",
    qbId: "1042",
    txnDate: "2026-09-03",
    itemId: "7",
};

test("round 48: every field survives compose -> parse unchanged", () => {
    const parsed = parseCreateMarker(composeCreateMarker(AMBIGUOUS_CREATE_MARKER, FULL, AT));
    assert.equal(parsed?.kind, AMBIGUOUS_CREATE_MARKER);
    assert.equal(parsed?.atMs, AT.getTime());
    assert.deepEqual(parsed?.identity, FULL);
});

test("round 48: each optional field can be absent, and is then OMITTED not undefined", () => {
    // A deep-equality check against a smaller identity has to keep reading as
    // equal for a marker that predates the newer fields.
    const optional = ["issuanceHash", "expectedTotal", "expectedTax", "realmId", "customerId", "qbId", "txnDate", "itemId"] as const;
    for (const field of optional) {
        const identity: any = { ...FULL };
        delete identity[field];
        const parsed = parseCreateMarker(composeCreateMarker(CREATE_IN_FLIGHT_MARKER, identity, AT));
        assert.deepEqual(parsed?.identity, identity, `dropping ${field}`);
        assert.equal(field in (parsed?.identity ?? {}), false, `${field} must be omitted, not undefined`);
    }
});

test("round 48: a malformed field makes the WHOLE identity null", () => {
    // The reported shape: `&|...` is a recognised prefix followed by an empty
    // field. It used to fall through unstripped, and the payload's first
    // separator then came immediately — so the marker parsed as document number
    // "&" while KEEPING a valid realm, customer and hash. That is a marker that
    // resolves against the wrong document, which `confirmed-none` can clear.
    const corruptions = [
        "ambiguous-create:&|EST-00237|note",
        "ambiguous-create:@|EST-00237|note",
        "ambiguous-create:#|EST-00237|note",
        "ambiguous-create:$|EST-00237|note",
        "ambiguous-create:^|EST-00237|note",
        "ambiguous-create:~|EST-00237|note",
        "ambiguous-create:%|EST-00237|note",
        "ambiguous-create:!|EST-00237|note",
        "ambiguous-create:+|EST-00237|note",
        // Present but unparseable values.
        "ambiguous-create:@notanumber|EST-00237|note",
        "ambiguous-create:#NOTHEX|EST-00237|note",
        "ambiguous-create:$notmoney|EST-00237|note",
        "ambiguous-create:^notmoney|EST-00237|note",
        "ambiguous-create:+notadate|EST-00237|note",
        // A prefix with no terminator at all.
        "ambiguous-create:&7",
        "ambiguous-create:~9130354",
    ];
    for (const marker of corruptions) {
        const parsed = parseCreateMarker(marker);
        assert.equal(parsed?.kind, AMBIGUOUS_CREATE_MARKER, marker);
        assert.equal(parsed?.identity, null, `must be unresolvable: ${marker}`);
    }
});

test("round 48: a DocNumber that composition could not have written is refused", () => {
    // Belt and braces on top of the field parsing: whatever ends up in the
    // docNumber position has to satisfy the same invariants `composeCreateMarker`
    // enforces, or it did not come from this rail.
    assert.equal(isComposableDocNumber("EST-00237"), true);
    assert.equal(isComposableDocNumber(""), false);
    assert.equal(isComposableDocNumber("a|b"), false);
    assert.equal(isComposableDocNumber("x".repeat(MARKER_DOC_NUMBER_MAX_LEN + 1)), false);
    for (const prefix of ["@", "#", "$", "^", "~", "%", "!", "+", "&"]) {
        assert.equal(isComposableDocNumber(`${prefix}EST-1`), false, prefix);
    }

    const parsed = parseCreateMarker(`ambiguous-create:${"x".repeat(MARKER_DOC_NUMBER_MAX_LEN + 1)}|note`);
    assert.equal(parsed?.identity, null, "an over-long document number is not ours");
});

test("round 48: the mirrored DocNumber cap matches the canonical one", () => {
    // The marker module cannot import quickbooks.ts (it is loaded by a client
    // component), so the cap is duplicated. This is what stops it drifting.
    assert.equal(MARKER_DOC_NUMBER_MAX_LEN, QB_DOC_NUMBER_MAX_LEN);
});

test("round 48: a corruption OUTSIDE the document number can never change it", () => {
    // What a self-describing grammar can and cannot promise.
    //
    // CAN: no corruption elsewhere in the marker moves a field boundary such
    // that some other field's value becomes the document number. That is the
    // reported hazard — the `&|` shape parsed as document number `&` while
    // keeping a valid realm, customer and hash, which is the one combination
    // `resolveAmbiguousInvoiceCreateCore` acts on: it looks the number up, finds
    // nothing, and offers `confirmed-none`, clearing the claim for a real
    // invoice filed under the number the claim was actually made with.
    //
    // CANNOT: detect a byte flipped INSIDE the document number itself. That
    // marker is well-formed and simply names another document; nothing short of
    // a checksum would catch it, and a checksum is not what this grammar is.
    // Those indices are excluded deliberately rather than quietly passing.
    const marker = composeCreateMarker(AMBIGUOUS_CREATE_MARKER, FULL, AT);
    const docAt = marker.lastIndexOf(`|${FULL.docNumber}|`) + 1;
    assert.ok(docAt > 0, "the fixture must contain its own document number");
    const docEnd = docAt + FULL.docNumber.length;

    const alphabet = ["|", "@", "#", "$", "^", "~", "%", "!", "+", "&", "x", "0", ""];
    let nulls = 0;
    const check = (parsed: ReturnType<typeof parseCreateMarker>, what: string) => {
        if (!parsed) return;
        if (parsed.identity === null) { nulls++; return; }
        assert.equal(
            parsed.identity.docNumber,
            FULL.docNumber,
            `corruption produced document number ${parsed.identity.docNumber}: ${what}`,
        );
    };
    for (let i = 0; i < marker.length; i++) {
        if (i >= docAt && i < docEnd) continue;
        for (const ch of alphabet) {
            const mutated = marker.slice(0, i) + ch + marker.slice(i + 1);
            check(parseCreateMarker(mutated), mutated);
        }
        check(parseCreateMarker(marker.slice(0, i)), `truncation at ${i}`);
    }
    assert.ok(nulls > 50, `the fuzzer must be producing corrupt markers, got ${nulls}`);
});

test("round 48: a byte flipped inside the document number stays actionable, by design", () => {
    // The residual above, stated as a fact rather than left implicit. It is not
    // the reported bug: the marker is well-formed, and an operator resolving it
    // is shown the number it names.
    const marker = composeCreateMarker(AMBIGUOUS_CREATE_MARKER, FULL, AT);
    const parsed = parseCreateMarker(marker.replace(`|${FULL.docNumber}|`, "|xST-00237|"));
    assert.equal(parsed?.identity?.docNumber, "xST-00237");
});
test("round 48: the exact reported shape keeps its realm and customer, and is refused", () => {
    // Before the strict grammar this parsed as document number "&" WITH a valid
    // realm, customer and hash — the one combination the resolver acts on.
    const parsed = parseCreateMarker(
        "ambiguous-create:@1730000000000|#4f1c2ab90de7331a|~9130354|%58|&|EST-00237|note",
    );
    assert.equal(parsed?.identity, null);
});

// --- Round 48 item 6: the apply script proves which database it is about ---

/**
 * An apply script is the one thing in this repo that runs DDL against
 * production by hand. It read `DATABASE_URL` from whatever the environment
 * happened to hold — `.env.production.local`, then `.env.local`, then `.env`,
 * none of them overriding an ambient value — so a shell left over from a test
 * run silently decided which database got altered, and nothing was printed
 * before the first statement to say which one it had picked.
 */
test("round 48: the apply script refuses to run without an explicit --target prod", async () => {
    const { execFileSync } = await import("node:child_process");
    const run = (args: string[]) => {
        try {
            return {
                code: 0,
                out: execFileSync(process.execPath, ["scripts/apply-qb-sync-marker.mjs", ...args], {
                    encoding: "utf8",
                    stdio: ["ignore", "pipe", "pipe"],
                    // The trap: an ambient URL pointing somewhere that is NOT prod.
                    env: { ...process.env, DATABASE_URL: "postgresql://u:p@127.0.0.1:5432/probuild_local" },
                }),
            };
        } catch (e: any) {
            return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
        }
    };

    const bare = run([]);
    assert.equal(bare.code, 1, "no --target must be a refusal");
    assert.match(bare.out, /must be told which database/);
    assert.ok(!/ok: ALTER TABLE/.test(bare.out), "and it must refuse BEFORE any DDL");

    const wrong = run(["--target", "local"]);
    assert.equal(wrong.code, 1);
    assert.match(wrong.out, /must be told which database/);
});

test("round 48: the target line is printed and carries no password", async () => {
    const { redactTarget } = await import("../scripts/apply-qb-sync-marker.mjs" as string);
    const line = redactTarget("postgresql://postgres.abc:sup3rs3cret@aws-0-us-west-2.pooler.supabase.com:6543/postgres?pgbouncer=true");
    assert.ok(!line.includes("sup3rs3cret"), `the password must not appear: ${line}`);
    assert.match(line, /aws-0-us-west-2\.pooler\.supabase\.com:6543/, "but the host must, so a human can check it");
    assert.match(line, /\/postgres /, "and the database name");
    // The PROJECT REF, which is the only part of a Supabase connection string
    // that says WHICH database this is: the pooler host is shared across every
    // project in the region.
    assert.match(line, /\(project abc\)/, "and which project");
    assert.equal(redactTarget("not a url"), "(unparseable connection string)");
});

test("round 48: the script verifies the database it actually reached", async () => {
    // Three facts, checked after connecting and before the first statement: a
    // connection string can be stale, rewritten, or pointed at a branch.
    const src = readFileSync("scripts/apply-qb-sync-marker.mjs", "utf8");
    assert.match(src, /SELECT current_database\(\)/);
    assert.match(src, /pooler\\.supabase\\.com\$/, "the pooler host is asserted");
    assert.match(src, /PROD_BASELINE_MIGRATION/, "and the production baseline migration");
    assert.match(src, /Refusing to run: this is not production/);
    // Only .env.production.local, and it OVERRIDES the ambient environment.
    assert.match(src, /config\(\{ path: envPath, override: true \}\)/);
    assert.ok(!/\.env\.local/.test(src), "no fallback env files to reason about");
    // Flags are parsed inside main(), so the module stays inert on import.
    assert.ok(src.indexOf("process.argv.slice(2)") > src.indexOf("async function main()"));
});

test("round 49: --target ci is a throwaway-database mode that can never reach production", async () => {
    // It exists so CI can run the script for real (scripts/ci-apply-qb-sync-marker-e2e.mjs),
    // because `main()` is the one part of that file no other test executes. The
    // safety property is that this mode REFUSES a Supabase host, so the
    // production guard cannot be satisfied through it even by accident.
    const { execFileSync } = await import("node:child_process");
    const run = (args: string[], env: Record<string, string>) => {
        try {
            return {
                code: 0,
                out: execFileSync(process.execPath, ["scripts/apply-qb-sync-marker.mjs", ...args], {
                    encoding: "utf8",
                    stdio: ["ignore", "pipe", "pipe"],
                    env: { ...process.env, ...env },
                }),
            };
        } catch (e: any) {
            return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
        }
    };

    const supabase = run(["--target", "ci"], {
        DATABASE_URL: "postgresql://postgres.abc:pw@aws-0-us-west-2.pooler.supabase.com:6543/postgres",
    });
    assert.equal(supabase.code, 1, "a Supabase URL must be refused in ci mode");
    assert.match(supabase.out, /REFUSING/);
    assert.ok(!/ok: ALTER TABLE/.test(supabase.out), "and refused before any DDL");

    const noUrl = run(["--target", "ci"], { DATABASE_URL: "" });
    assert.equal(noUrl.code, 1);
    assert.match(noUrl.out, /needs DATABASE_URL/);
});

test("round 49: the CI driver builds a pre-marker database and proves idempotency", () => {
    // The shape of the check, asserted from source: the driver has to move the
    // marker migration aside (or it proves nothing about the script), run the
    // script twice (or it proves nothing about re-running a half-finished
    // apply), and compare the result against the committed migration.
    const src = readFileSync("scripts/ci-apply-qb-sync-marker-e2e.mjs", "utf8");
    assert.match(src, /renameSync\(migration, parked\)/, "the migration is parked so the script does the work");
    assert.match(src, /migrate deploy/);
    const runs = [...src.matchAll(/run\("node", \[script, "--target", "ci"\], env\)/g)];
    assert.equal(runs.length, 2, "run once to apply, once more to prove idempotency");
    assert.match(src, /information_schema\.columns/, "and the resulting shape is asserted");
    assert.match(src, /REFUSING: APPLY_E2E_SERVER_URL looks like production/);
});
