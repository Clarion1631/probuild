import assert from "node:assert/strict";
import test from "node:test";
import {
    OWNER_ORDER,
    RECEIPT_GROUPS,
    RECEIPT_GROUP_LABELS,
    groupIsVisible,
    intakeMatchesFilters,
    missingReceiptMatchesFilters,
    ownerRank,
    parseReceiptFilters,
} from "../src/app/automation/receipts-filters";

test("parseReceiptFilters never trusts the query string", async t => {
    await t.test("nothing set → every group, no narrowing", () => {
        assert.deepEqual(parseReceiptFilters({}), { group: null, projectId: null, owner: null });
    });
    await t.test("a known group and owner are kept", () => {
        assert.deepEqual(parseReceiptFilters({ group: "booking", owner: "CJ", projectId: "p1" }),
            { group: "booking", projectId: "p1", owner: "CJ" });
    });
    await t.test("an unknown group falls back to 'all', never throws", () => {
        assert.equal(parseReceiptFilters({ group: "../../etc/passwd" }).group, null);
        assert.equal(parseReceiptFilters({ group: "" }).group, null);
    });
    await t.test("an unknown owner falls back to 'everyone'", () => {
        assert.equal(parseReceiptFilters({ owner: "Mallory" }).owner, null);
    });
    await t.test("a repeated param takes the first value", () => {
        assert.equal(parseReceiptFilters({ group: ["booking", "duplicates"] }).group, "booking");
        assert.equal(parseReceiptFilters({ group: [] }).group, null);
    });
});

test("every group has a label, and the six are the spec's six", () => {
    assert.deepEqual([...RECEIPT_GROUPS], ["needs-job", "needs-review", "booking", "booked-today", "missing-receipts", "duplicates"]);
    assert.deepEqual(RECEIPT_GROUPS.map(g => RECEIPT_GROUP_LABELS[g]),
        ["Needs job", "Needs review", "Booking", "Booked today", "Missing receipts", "Duplicates"]);
});

test("groupIsVisible: no filter shows all, a filter shows exactly one", () => {
    const all = { group: null, projectId: null, owner: null };
    for (const group of RECEIPT_GROUPS) assert.equal(groupIsVisible(group, all), true);

    const only = { group: "booking" as const, projectId: null, owner: null };
    assert.equal(groupIsVisible("booking", only), true);
    assert.equal(groupIsVisible("duplicates", only), false);
});

test("the project predicate never hides jobless rows unless a project is chosen", () => {
    const none = { group: null, projectId: null, owner: null };
    assert.equal(intakeMatchesFilters({ projectId: null }, none), true, "'Needs job' IS the jobless rows");
    assert.equal(intakeMatchesFilters({ projectId: "p1" }, none), true);

    const scoped = { group: null, projectId: "p1", owner: null };
    assert.equal(intakeMatchesFilters({ projectId: "p1" }, scoped), true);
    assert.equal(intakeMatchesFilters({ projectId: "p2" }, scoped), false);
    assert.equal(intakeMatchesFilters({ projectId: null }, scoped), false);
});

test("the owner predicate narrows missing-receipt rows only", () => {
    const cj = { group: null, projectId: "p1", owner: "CJ" };
    assert.equal(missingReceiptMatchesFilters({ owner: "CJ" }, cj), true);
    assert.equal(missingReceiptMatchesFilters({ owner: "Richard" }, cj), false);
    // A bank line has no job, so a project filter must not silently empty the group.
    assert.equal(missingReceiptMatchesFilters({ owner: "CJ" }, { group: null, projectId: "p9", owner: null }), true);
});

test("owner ordering puts the people who get asked first, and never drops an unknown", () => {
    assert.deepEqual(OWNER_ORDER, ["CJ", "Richard", "office", "Justin", "unassigned"]);
    assert.ok(ownerRank("CJ") < ownerRank("Richard"));
    assert.ok(ownerRank("Richard") < ownerRank("office"));
    assert.ok(ownerRank("office") < ownerRank("Justin"));
    assert.ok(ownerRank("Justin") < ownerRank("unassigned"));
    assert.equal(ownerRank("Someone New"), OWNER_ORDER.length, "an unrecognized owner sorts last, it does not vanish");
});
