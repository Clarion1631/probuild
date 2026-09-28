import test from "node:test";
import assert from "node:assert/strict";
import {
    cleanFolderName,
    intakeFolderOf,
    normalizeJobName,
    suggestJobsForFolder,
    isFolderCandidate,
    folderFact,
    FOLDER_COPY,
} from "../src/lib/receipt-intake/folder";
import { AMOUNT_NOT_READ_TEXT, UNREAD_TOTAL_SENTENCE } from "../src/lib/receipt-intake/reason-text";

// ---- cleanFolderName ----------------------------------------------------

test("cleanFolderName collapses whitespace/control runs into one space", () => {
    assert.equal(cleanFolderName("  Oak   Street  "), "Oak Street");
    assert.equal(cleanFolderName("Oak\tStreet"), "Oak Street");
    assert.equal(cleanFolderName("Oak\nStreet"), "Oak Street");
    assert.equal(cleanFolderName("Oak\u0000Street"), "Oak Street");
});

test("cleanFolderName removes invisible format characters without inserting a space", () => {
    assert.equal(cleanFolderName("Oak​Street"), "OakStreet");
    assert.equal(cleanFolderName("‮Oak Street"), "Oak Street");
});

test("cleanFolderName keeps a string of exactly 200 code points, emoji and all, untouched", () => {
    const kept = "x".repeat(199) + "\u{1F600}"; // 200 code points, last one a surrogate-pair emoji
    const result = cleanFolderName(kept)!;
    assert.equal(Array.from(result).length, 200);
    assert.equal(result, kept);
});

test("cleanFolderName cuts at 200 code points without splitting an emoji straddling the boundary", () => {
    // The emoji IS the 200th code point; a naive UTF-16-unit slice would cut
    // it in half and leave a lone (unpaired) surrogate behind.
    const straddling = "x".repeat(199) + "\u{1F600}" + "y".repeat(5); // 205 code points
    const result = cleanFolderName(straddling)!;
    assert.equal(Array.from(result).length, 200);
    assert.equal(result, "x".repeat(199) + "\u{1F600}", "the emoji is kept whole, not split");
});

test("cleanFolderName gives null for anything with nothing left, or a non-string", () => {
    assert.equal(cleanFolderName(""), null);
    assert.equal(cleanFolderName("   "), null);
    assert.equal(cleanFolderName("​"), null);
    assert.equal(cleanFolderName(42), null);
    assert.equal(cleanFolderName(null), null);
});

// ---- intakeFolderOf -------------------------------------------------------

test("intakeFolderOf trusts only the secret-authenticated drive source", () => {
    assert.equal(intakeFolderOf("secret", "drive", " Oak "), "Oak");
    assert.equal(intakeFolderOf("session", "drive", " Oak "), null);
    assert.equal(intakeFolderOf("secret", "chat", " Oak "), null);
    assert.equal(intakeFolderOf("secret", "email", " Oak "), null);
});

// ---- normalizeJobName ------------------------------------------------------

test("normalizeJobName folds case, spacing, punctuation, & and apostrophes", () => {
    assert.equal(normalizeJobName("Oak Street"), normalizeJobName("OAK STREET"));
    assert.equal(normalizeJobName("Oak   Street"), normalizeJobName("Oak Street"));
    assert.equal(normalizeJobName("Oak-Street"), normalizeJobName("Oak Street"));
    assert.equal(normalizeJobName("Oak, Street"), normalizeJobName("Oak Street"));
    assert.equal(normalizeJobName("Oak. Street"), normalizeJobName("Oak Street"));
    assert.equal(normalizeJobName("Oak #5 Street"), normalizeJobName("Oak 5 Street"));
    assert.equal(normalizeJobName("Oak/Street"), normalizeJobName("Oak Street"));
    assert.equal(normalizeJobName("Oak & Street"), normalizeJobName("Oak and Street"));
    assert.equal(normalizeJobName("Birch Lane's Deck"), normalizeJobName("Birch Lanes Deck"));
    assert.equal(normalizeJobName("Birch Lane’s Deck"), normalizeJobName("Birch Lanes Deck"));
    assert.equal(normalizeJobName("José Kitchen"), normalizeJobName("Jose Kitchen"));
    // Full-width Latin letters fold to ASCII via NFKD.
    assert.equal(normalizeJobName("Ｏａｋ"), normalizeJobName("Oak"));
});

test("normalizeJobName gives '' for a non-string", () => {
    assert.equal(normalizeJobName(42 as unknown), "");
});

// ---- suggestJobsForFolder --------------------------------------------------

const jobs = (names: string[]) => names.map((name, i) => ({ id: `job-${i}`, name }));

test("the live shape: a folder that is a whole-word prefix of one open job", () => {
    const result = suggestJobsForFolder(
        "Oak Street Kitchen",
        jobs(["Oak Street Kitchen Remodel", "Pine Avenue Bath"]),
        200,
    );
    assert.deepEqual(result, { kind: "prefix", jobs: [{ id: "job-0", name: "Oak Street Kitchen Remodel" }] });
});

test("exact match under case and spacing beats prefix", () => {
    const result = suggestJobsForFolder(
        " oak  street kitchen ",
        jobs(["Oak Street Kitchen", "Oak Street Kitchen Remodel"]),
        200,
    );
    assert.deepEqual(result, { kind: "exact", jobs: [{ id: "job-0", name: "Oak Street Kitchen" }] });
});

test("overhead: a Shop folder never offers Shop Annex, and Shop Annex is its own exact match", () => {
    assert.deepEqual(suggestJobsForFolder("Shop", jobs(["Shop Annex"]), 200), { kind: "none" });
    assert.deepEqual(
        suggestJobsForFolder("Shop", jobs(["Shop", "Shop Annex"]), 200),
        { kind: "exact", jobs: [{ id: "job-0", name: "Shop" }] },
    );
    assert.deepEqual(suggestJobsForFolder("shop.", jobs(["Shop Annex"]), 200), { kind: "none" });
    assert.deepEqual(
        suggestJobsForFolder("Shop Annex", jobs(["Shop", "Shop Annex"]), 200),
        { kind: "exact", jobs: [{ id: "job-1", name: "Shop Annex" }] },
    );
});

test("overhead guard runs BEFORE exact matching, both directions (Codex round 2, finding 1)", () => {
    // The overhead folder ("Shop", literally) never suggests a customer
    // project whose name merely NORMALIZES the same way -- e.g. "Shop." --
    // even when that project is the only open job and would otherwise be a
    // unique normalized-exact match.
    assert.deepEqual(suggestJobsForFolder("Shop", jobs(["Shop."]), 200), { kind: "none" });
    // A project folder that is NOT literally "Shop" (the bot classifies
    // "Shop." as a project folder, punctuation and all) never suggests the
    // overhead job "Shop", even though the two normalize identically.
    assert.deepEqual(suggestJobsForFolder("Shop.", jobs(["Shop"]), 200), { kind: "none" });
    // A folder that NORMALIZES to the overhead name but is not literally
    // "Shop" never offers a customer job either, even one spelled exactly
    // the same way ("Shop." folder vs a "Shop." job) — the whole point of
    // the guard is that nothing customer-facing is ever suggested once a
    // folder reads as the overhead name (checker, PR #555 round 2).
    assert.deepEqual(suggestJobsForFolder("Shop.", jobs(["Shop.", "Shop"]), 200), { kind: "none" });
    assert.deepEqual(suggestJobsForFolder("Shop-", jobs(["Shop -"]), 200), { kind: "none" });
    assert.deepEqual(suggestJobsForFolder("shop!", jobs(["SHOP?"]), 200), { kind: "none" });
});

test("Codex's cleaning case: a tab inside a folder name never merges two different jobs", () => {
    const result = suggestJobsForFolder(
        cleanFolderName("Oak\tStreet"),
        jobs(["Oak Street", "OakStreet"]),
        200,
    );
    assert.deepEqual(result, { kind: "exact", jobs: [{ id: "job-0", name: "Oak Street" }] });
});

test("cleaning and matching treat an invisible character in a JOB name the same way they treat one in a folder (Codex round 2, finding 2)", () => {
    // The job's name is never run through cleanFolderName -- it comes
    // straight from the database -- so this proves normalizeJobName alone
    // reaches the same identity `cleanFolderName` already reached for the
    // folder that was typed with the same invisible character.
    const folder = cleanFolderName("Oak​Street"); // -> "OakStreet"
    const result = suggestJobsForFolder(folder, jobs(["Oak​Street"]), 200);
    assert.deepEqual(result, { kind: "exact", jobs: [{ id: "job-0", name: "Oak​Street" }] });
});

test("whole words only: a folder must be a WORD prefix, not a substring", () => {
    assert.deepEqual(suggestJobsForFolder("Oak Str", jobs(["Oak Street Kitchen"]), 200), { kind: "none" });
    assert.deepEqual(suggestJobsForFolder("Oak", jobs(["Oakland Deck"]), 200), { kind: "none" });
});

test("a folder shorter than 3 characters never gives a prefix suggestion", () => {
    assert.deepEqual(suggestJobsForFolder("Ok", jobs(["Ok Street Kitchen"]), 200), { kind: "none" });
});

test("namesakes: two open jobs with the same normalized name give no button, not a guess", () => {
    assert.deepEqual(
        suggestJobsForFolder("Oak Street Kitchen", jobs(["Oak Street Kitchen", "oak street kitchen"]), 200),
        { kind: "same-name" },
    );
});

test("namesake suppression also covers prefix candidates (Codex round 2, finding 6)", () => {
    // Two open jobs, same normalized name, neither an exact match for the
    // folder -- both would draw an identical button label.
    assert.deepEqual(
        suggestJobsForFolder("Oak Street", jobs(["Oak Street Remodel", "Oak Street Remodel"]), 200),
        { kind: "same-name" },
    );
});

test("4 prefix hits draw buttons; 5 is too many to trust", () => {
    const four = jobs(["Oak Street A", "Oak Street B", "Oak Street C", "Oak Street D"]);
    const result4 = suggestJobsForFolder("Oak Street", four, 200);
    assert.equal(result4.kind, "prefix");
    assert.equal((result4 as { jobs: unknown[] }).jobs.length, 4);

    const five = jobs(["Oak Street A", "Oak Street B", "Oak Street C", "Oak Street D", "Oak Street E"]);
    assert.deepEqual(suggestJobsForFolder("Oak Street", five, 200), { kind: "too-many" });
});

test("a job list at or over the cap gives none, even with an exact match inside it", () => {
    const capped = jobs(Array.from({ length: 200 }, (_, i) => (i === 100 ? "Oak Street" : `Job ${i}`)));
    assert.deepEqual(suggestJobsForFolder("Oak Street", capped, 200), { kind: "none" });
});

test("candidate order is deterministic and the input array is never mutated", () => {
    const input = jobs(["Oak Street D", "Oak Street B", "Oak Street A", "Oak Street C"]);
    const before = JSON.parse(JSON.stringify(input));
    const result = suggestJobsForFolder("Oak Street", input, 200);
    assert.equal(result.kind, "prefix");
    assert.deepEqual((result as { jobs: Array<{ name: string }> }).jobs.map(j => j.name), [
        "Oak Street A", "Oak Street B", "Oak Street C", "Oak Street D",
    ]);
    assert.deepEqual(input, before);
});

test("an empty or emoji-only folder gives none", () => {
    assert.deepEqual(suggestJobsForFolder("", jobs(["Oak Street"]), 200), { kind: "none" });
    assert.deepEqual(suggestJobsForFolder("\u{1F600}", jobs(["Oak Street"]), 200), { kind: "none" });
    assert.deepEqual(suggestJobsForFolder(null, jobs(["Oak Street"]), 200), { kind: "none" });
    assert.deepEqual(suggestJobsForFolder(undefined, jobs(["Oak Street"]), 200), { kind: "none" });
});

// ---- isFolderCandidate (setReceiptIntakeJobFromSuggestion's write-time re-check) ----

test("isFolderCandidate: true when the job is still an exact or prefix candidate", () => {
    assert.equal(isFolderCandidate("Oak Street", jobs(["Oak Street"]), 200, "job-0"), true);
    assert.equal(
        isFolderCandidate("Oak Street", jobs(["Oak Street Remodel", "Pine Avenue"]), 200, "job-0"),
        true,
    );
});

test("isFolderCandidate: refuses a job that closed since the page loaded (no longer in the list)", () => {
    // fetchJobOptions is scoped to open projects, so a closed job simply is
    // not in `jobs` any more -- the tapped id can never appear as a candidate.
    assert.equal(isFolderCandidate("Oak Street", jobs(["Pine Avenue"]), 200, "job-0"), false);
    assert.equal(isFolderCandidate("Oak Street", jobs([]), 200, "some-other-job-id"), false);
});

test("isFolderCandidate: refuses a job that is no longer a candidate for this folder (renamed, or a namesake opened)", () => {
    // The job was renamed away from matching the folder since the page loaded.
    assert.equal(isFolderCandidate("Oak Street", jobs(["Birch Lane"]), 200, "job-0"), false);
    // A namesake opened, turning what was a unique exact match into same-name.
    assert.equal(
        isFolderCandidate("Oak Street", jobs(["Oak Street", "oak street"]), 200, "job-0"),
        false,
    );
    // The suggested project id itself is stale even though something still matches.
    assert.equal(
        isFolderCandidate("Oak Street", jobs(["Oak Street"]), 200, "not-the-real-job-id"),
        false,
    );
});

// ---- source scan of receipt-row-actions.tsx (pins: suggestion taps use the wrapper) ----

test("receipt-row-actions.tsx: Set job calls setReceiptIntakeJob directly, suggestion buttons call the wrapper", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(
        new URL("../src/app/automation/components/receipts/receipt-row-actions.tsx", import.meta.url),
        "utf8",
    );
    assert.match(
        source,
        /await setReceiptIntakeJob\(intakeId, projectId, expectedState, expectedUpdatedAt\)/,
        "the plain Set job button must keep calling setReceiptIntakeJob directly, unchanged",
    );
    const suggestionCalls = source.match(
        /onClick=\{\(\) => runSuggestion\(\(\) => setReceiptIntakeJobFromSuggestion\(intakeId, job\.id, expectedState, expectedUpdatedAt\)\)\}/g,
    );
    assert.ok(suggestionCalls, "suggestion buttons must call setReceiptIntakeJobFromSuggestion");
    // Both the "exact" and "prefix" suggestion button groups must use the wrapper.
    assert.equal(suggestionCalls!.length, 2);
});

// ---- folderFact + copy lint -------------------------------------------------

test("folderFact fills in the folder name", () => {
    assert.equal(folderFact("Oak Street"), "Folder: Oak Street");
});

test("copy lint: no dashes, no promises", () => {
    const BANNED: Array<[RegExp, string]> = [
        [/books? itself/i, "it may park again on the very next step"],
        [/will book/i, "same promise, different words"],
        [/\bclears\b/i, "nothing here can promise a row clears"],
        [/would fix|fixes it|fix it\b/i, "a fix is a prediction, not a fact about the row"],
        [/as soon as it has/i, "the job is one of several gates, not the last one"],
        [/tomorrow morning/i, "the crew chase lists are switched off, so nothing goes out tomorrow"],
        [/automatically/i, "say who or what acts, not that it is automatic"],
    ];
    const lines = [...Object.values(FOLDER_COPY), AMOUNT_NOT_READ_TEXT, UNREAD_TOTAL_SENTENCE];
    for (const line of lines) {
        assert.ok(!line.includes("—"), `em dash: ${line}`);
        assert.ok(!line.includes("–"), `en dash: ${line}`);
        assert.ok(!line.includes(" - "), `spaced hyphen: ${line}`);
        for (const [pattern, why] of BANNED) {
            assert.ok(!pattern.test(line), `"${line}" promises an outcome (${why})`);
        }
    }
});

// ---- source scan of route.ts (pins: no job lookup at intake) --------------

test("route.ts stores the folder but never looks up a job from it", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("../src/app/api/receipts/intake/route.ts", import.meta.url), "utf8");
    assert.match(source, /folderName: str\(json\.folderName\)/);
    assert.match(source, /folderName: str\(form\.get\("folderName"\)\)/);
    assert.match(source, /intakeFolderOf\(auth\.via, source, parsed\.folderName\)/);
    assert.match(source, /sourceFolder,/);
    assert.match(source, /projectId: parsed\.projectId,/);
    assert.doesNotMatch(source, /project\.findMany/);
    assert.doesNotMatch(source, /project\.findFirst/);
});
