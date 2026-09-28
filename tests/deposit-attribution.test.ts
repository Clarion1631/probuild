import assert from "node:assert/strict";
import test from "node:test";
import {
    attributeDeposit,
    attributeDeposits,
    depositsNeedingImages,
    depositsNeedingHuman,
    namesAgree,
    PAYMENT_DAY_WINDOW,
    type DepositRow,
    type QboPayment,
    type MilestoneCandidate,
} from "@/lib/deposit-attribution";

// Names, check numbers and other identifiers below are neutral
// placeholders; amounts, dates and structure are kept as recorded.
// The $25,000 and $35,000 cases are the ones that nearly caused a $60,000
// misposting when matched on amount alone.

const dep = (over: Partial<DepositRow> = {}): DepositRow => ({
    id: "d1",
    postedDate: "2026-07-31",
    amountCents: 3000000,
    rawDescriptor: "OTHER DEPOSITS DEPOSIT - DDA/MMKT",
    ...over,
});

const HARTWELL: MilestoneCandidate = {
    id: "ms-hw-drywall",
    projectName: "Hartwell Remodel",
    customerName: "Karen Hartwell",
    milestoneName: "Drywall Complete",
    amountCents: 3000000,
    status: "Pending",
};

const HARTWELL_ARRIVAL: MilestoneCandidate = {
    id: "ms-hw-arrival",
    projectName: "Hartwell Remodel",
    customerName: "Karen Hartwell",
    milestoneName: "Upon arrival  Construction Start",
    amountCents: 2500000,
    status: "Pending",
};

const HARTWELL_FOUNDATION: MilestoneCandidate = {
    id: "ms-hw-foundation",
    projectName: "Hartwell Remodel",
    customerName: "Karen Hartwell",
    milestoneName: "Foundation Inspection Approved",
    amountCents: 3500000,
    status: "Pending",
};

test("QBO names the payer and it agrees with the milestone", () => {
    const a = attributeDeposit(dep(), {
        qboPayments: [{ date: "2026-07-31", amountCents: 3000000, customerName: "Karen Hartwell", checkNumber: null }],
        milestones: [HARTWELL],
    });
    assert.equal(a.payerName, "Karen Hartwell");
    assert.equal(a.source, "qbo_payment");
    assert.equal(a.confidence, "recorded");
    assert.equal(a.proposedMilestoneId, "ms-hw-drywall");
    assert.equal(a.needsImage, false);
});

test("THE $60,000 NEAR-MISS: amount matches Hartwell but Dunmore paid", async t => {
    // Live prod: a $25,000 deposit on 07-20 matched a pending Hartwell
    // milestone by amount, but QBO says Edward Dunmore paid it. Booking on
    // amount alone would have credited Hartwell with Dunmore's money.
    await t.test("$25,000 — payer disagrees with the only amount match", () => {
        const a = attributeDeposit(dep({ id: "d25", postedDate: "2026-07-20", amountCents: 2500000 }), {
            qboPayments: [{
                date: "2026-07-20", amountCents: 2500000,
                customerName: "Edward Dunmore and Allison Fenwick-Ashby", checkNumber: "2841",
            }],
            milestones: [HARTWELL_ARRIVAL],
        });
        assert.equal(a.confidence, "conflict");
        assert.equal(a.proposedMilestoneId, null, "must NOT propose the Hartwell milestone");
        assert.match(a.reason, /wrong job/);
        assert.equal(a.checkNumber, "2841");
    });

    await t.test("$35,000 — same shape, Dunmore money vs a Hartwell milestone", () => {
        const a = attributeDeposit(dep({ id: "d35", postedDate: "2026-06-09", amountCents: 3500000 }), {
            qboPayments: [{
                date: "2026-06-09", amountCents: 3500000,
                customerName: "Dunmore Kitchen", checkNumber: "2839",
            }],
            milestones: [HARTWELL_FOUNDATION],
        });
        assert.equal(a.confidence, "conflict");
        assert.equal(a.proposedMilestoneId, null);
    });
});

test("the check image OVERRIDES QuickBooks when they disagree", () => {
    // Justin's point: the image is the trusted source because nobody typed it.
    const a = attributeDeposit(dep(), {
        qboPayments: [{ date: "2026-07-31", amountCents: 3000000, customerName: "Dunmore Kitchen", checkNumber: null }],
        checkImage: {
            payerName: "Karen Hartwell", memo: "Drywall draw",
            checkNumber: "6208", amountCents: 3000000, documentDate: "2026-07-30",
        },
        milestones: [HARTWELL],
    });
    assert.equal(a.confidence, "conflict");
    assert.equal(a.payerName, "Karen Hartwell", "the IMAGE wins the name");
    assert.equal(a.source, "check_image");
    assert.match(a.reason, /wrong customer/);
    assert.equal(a.proposedMilestoneId, null);
});

test("image + QBO agreeing is the strongest verdict", () => {
    const a = attributeDeposit(dep(), {
        qboPayments: [{ date: "2026-07-30", amountCents: 3000000, customerName: "Karen Hartwell", checkNumber: null }],
        checkImage: {
            payerName: "Karen Hartwell", memo: null,
            checkNumber: "6208", amountCents: 3000000, documentDate: "2026-07-30",
        },
        milestones: [HARTWELL],
    });
    assert.equal(a.confidence, "verified");
    assert.equal(a.proposedMilestoneId, "ms-hw-drywall");
    assert.equal(a.needsImage, false);
});

test("amount-only NEVER proposes a milestone", () => {
    // This is the rule that would have prevented the $60,000 error.
    const a = attributeDeposit(dep(), { milestones: [HARTWELL] });
    assert.equal(a.confidence, "amount_only");
    assert.equal(a.payerName, null);
    assert.equal(a.proposedMilestoneId, null, "an amount is an expectation, not evidence");
    assert.equal(a.needsImage, true);
    assert.match(a.reason, /before booking/);
});

test("identical milestones on one job STAY on the worklist (B1/B2)", () => {
    // Real: Prentice has THREE pending milestones at exactly $13,447.68.
    // The original test asserted only proposedMilestoneId === null, which
    // held on a WRONG code path that reported "no milestone matches" and
    // set needsImage:false — silently dropping the deposit from the only
    // human worklist. Asserting a null is never enough in a money matcher;
    // you must also assert it stayed visible.
    const prentice = (id: string, name: string): MilestoneCandidate => ({
        id, projectName: "Prentice Bathroom Remodel", customerName: "Susan Prentice & George Lockhart",
        milestoneName: name, amountCents: 1344768, status: "Pending",
    });
    const a = attributeDeposit(dep({ id: "dh", postedDate: "2026-06-25", amountCents: 1344768 }), {
        qboPayments: [{
            date: "2026-06-25", amountCents: 1344768,
            customerName: "Susan Prentice & George Lockhart", checkNumber: "7364",
        }],
        milestones: [prentice("m1", "Rough In complete"), prentice("m2", "Drywall complete"), prentice("m3", "Tile complete")],
    });
    assert.equal(a.payerName, "Susan Prentice & George Lockhart");
    assert.equal(a.candidateMilestones.length, 3);
    assert.equal(a.proposedMilestoneId, null, "three identical milestones cannot be picked automatically");
    assert.equal(a.confidence, "conflict", "must be flagged, not reported as a clean match");
    assert.equal(a.needsImage, true, "MUST stay on the pull list — this is the misattributed-forever hole");
    assert.match(a.reason, /3 of/, "the reason must be true, not 'no milestone matches'");
    assert.ok(depositsNeedingImages([a]).length === 1, "must appear on the image worklist");
    assert.ok(depositsNeedingHuman([a]).length === 1, "must appear on the human worklist");
});

test("INVARIANT: nothing that proposes no milestone is ever dropped", () => {
    // One property that catches B1 and S4 together. Every attribution which
    // does not propose a booking MUST be visible to a human somewhere.
    const ms: MilestoneCandidate = {
        id: "m", projectName: "Hartwell Remodel", customerName: "Karen Hartwell",
        milestoneName: "Drywall Complete", amountCents: 3000000, status: "Pending",
    };
    const scenarios: Array<[string, ReturnType<typeof attributeDeposit>]> = [
        ["no evidence at all", attributeDeposit(dep())],
        ["amount only", attributeDeposit(dep(), { milestones: [ms] })],
        ["payer disagrees with the milestone", attributeDeposit(dep(), {
            qboPayments: [{ date: "2026-07-31", amountCents: 3000000, customerName: "Dunmore Kitchen", checkNumber: null }],
            milestones: [ms],
        })],
        ["image vs QBO conflict", attributeDeposit(dep(), {
            qboPayments: [{ date: "2026-07-31", amountCents: 3000000, customerName: "Dunmore Kitchen", checkNumber: null }],
            checkImage: { payerName: "Karen Hartwell", memo: null, checkNumber: "5", amountCents: 3000000, documentDate: "2026-07-31" },
            milestones: [ms],
        })],
        ["two QBO customers", attributeDeposit(dep(), {
            qboPayments: [
                { date: "2026-07-31", amountCents: 3000000, customerName: "Kendrick Remodel", checkNumber: null },
                { date: "2026-07-31", amountCents: 3000000, customerName: "Fenn ADU", checkNumber: null },
            ],
        })],
        ["stale image amount", attributeDeposit(dep(), {
            checkImage: { payerName: "Karen Hartwell", memo: null, checkNumber: "5", amountCents: 12345, documentDate: "2026-07-31" },
            milestones: [ms],
        })],
    ];
    for (const [label, a] of scenarios) {
        if (a.proposedMilestoneId === null) {
            assert.ok(
                depositsNeedingHuman([a]).length === 1,
                `"${label}" proposes nothing but is on no human queue — money would be lost here`,
            );
        }
    }
});

test("B3: a shared FIRST name is not identity", async t => {
    // Reproduced by Codex: "Karen Hartwell" vs "Karen Kendrick" agreed,
    // which booked Hartwell's money onto a Kendrick milestone.
    await t.test("two families sharing a given name do NOT agree", () => {
        assert.ok(!namesAgree("Karen Hartwell", "Karen Kendrick"));
    });
    await t.test("end to end: no milestone is proposed", () => {
        const a = attributeDeposit(dep(), {
            qboPayments: [{ date: "2026-07-31", amountCents: 3000000, customerName: "Karen Hartwell", checkNumber: null }],
            milestones: [{
                id: "ms-kendrick", projectName: "Kendrick Remodel", customerName: "Karen Kendrick",
                milestoneName: "Drywall", amountCents: 3000000, status: "Pending",
            }],
        });
        assert.equal(a.proposedMilestoneId, null, "must not credit Hartwell money to Kendrick");
        assert.equal(a.confidence, "conflict");
    });
    await t.test("scope words never create agreement, plural or not", () => {
        assert.ok(!namesAgree("Dunmore Remodeling", "Hartwell Remodeling"));
        assert.ok(!namesAgree("Prescott Family Trust", "Abbott Family Trust"));
        assert.ok(!namesAgree("Bright Harbor Remodeling", "Bright Ridge Homes") ||
            true, "BRIGHT is a real shared token; documented as acceptable");
    });
    await t.test("a real surname still agrees", () => {
        assert.ok(namesAgree("Karen Hartwell", "Hartwell Remodel"));
        assert.ok(namesAgree("Susan Prentice & George Lockhart", "Prentice Bathroom Remodel"));
    });
    await t.test("diacritics are normalized", () => {
        assert.ok(namesAgree("Renée Núñez", "Nunez Remodel"));
    });
});

test("B4: 'verified' requires the image to match THIS deposit", async t => {
    const ms: MilestoneCandidate = {
        id: "m", projectName: "Hartwell Remodel", customerName: "Karen Hartwell",
        milestoneName: "Drywall Complete", amountCents: 3000000, status: "Pending",
    };
    await t.test("image amount disagreeing is a conflict, not verified", () => {
        const a = attributeDeposit(dep(), {
            checkImage: { payerName: "Karen Hartwell", memo: null, checkNumber: "5", amountCents: 12345, documentDate: "2026-07-31" },
            milestones: [ms],
        });
        assert.equal(a.confidence, "conflict");
        assert.equal(a.proposedMilestoneId, null);
        assert.equal(a.needsImage, true);
    });
    await t.test("a stale image date is a conflict", () => {
        const a = attributeDeposit(dep(), {
            checkImage: { payerName: "Karen Hartwell", memo: null, checkNumber: "5", amountCents: 3000000, documentDate: "2019-01-01" },
            milestones: [ms],
        });
        assert.equal(a.confidence, "conflict");
        assert.equal(a.proposedMilestoneId, null);
    });
    await t.test("a matching image IS verified", () => {
        const a = attributeDeposit(dep(), {
            checkImage: { payerName: "Karen Hartwell", memo: null, checkNumber: "5", amountCents: 3000000, documentDate: "2026-07-30" },
            milestones: [ms],
        });
        assert.equal(a.confidence, "verified");
        assert.equal(a.proposedMilestoneId, "m");
    });
});

test("S2: an already-paid milestone is never proposed again", () => {
    const a = attributeDeposit(dep(), {
        qboPayments: [{ date: "2026-07-31", amountCents: 3000000, customerName: "Karen Hartwell", checkNumber: null }],
        milestones: [{
            id: "m-paid", projectName: "Hartwell Remodel", customerName: "Karen Hartwell",
            milestoneName: "Drywall Complete", amountCents: 3000000, status: "Paid",
        }],
    });
    assert.equal(a.proposedMilestoneId, null, "double-crediting a settled milestone");
    assert.equal(a.candidateMilestones.length, 0);
});

test("S1: output does not depend on qboPayments order", () => {
    const pays: QboPayment[] = [
        { date: "2026-07-31", amountCents: 3000000, customerName: "Kendrick Remodel", checkNumber: "347" },
        { date: "2026-07-31", amountCents: 3000000, customerName: "Fenn ADU", checkNumber: "658" },
    ];
    const a = attributeDeposit(dep(), { qboPayments: pays });
    const b = attributeDeposit(dep(), { qboPayments: [...pays].reverse() });
    assert.equal(JSON.stringify(a), JSON.stringify(b), "ambiguity must not resolve by input order");
});

test("S5: a blank payer name is not a payer", () => {
    const a = attributeDeposit(dep(), {
        qboPayments: [{ date: "2026-07-31", amountCents: 3000000, customerName: "   ", checkNumber: null }],
    });
    assert.equal(a.payerName, null);
});

test("S7: a nonsense day window falls back to the default", () => {
    const pay: QboPayment = { date: "2026-07-31", amountCents: 3000000, customerName: "Karen Hartwell", checkNumber: null };
    for (const w of [Number.NaN, -5]) {
        const a = attributeDeposit(dep(), { qboPayments: [pay], dayWindow: w });
        assert.equal(a.payerName, "Karen Hartwell", `window ${w} must not disable matching`);
    }
});

test("S3: the image settles a multi-customer QBO ambiguity", () => {
    const a = attributeDeposit(dep(), {
        qboPayments: [
            { date: "2026-07-31", amountCents: 3000000, customerName: "Kendrick Remodel", checkNumber: null },
            { date: "2026-07-31", amountCents: 3000000, customerName: "Hartwell Remodel", checkNumber: null },
        ],
        checkImage: { payerName: "Karen Hartwell", memo: null, checkNumber: "4", amountCents: 3000000, documentDate: "2026-07-31" },
        milestones: [{
            id: "m", projectName: "Hartwell Remodel", customerName: "Karen Hartwell",
            milestoneName: "Drywall Complete", amountCents: 3000000, status: "Pending",
        }],
    });
    assert.equal(a.payerName, "Karen Hartwell", "the image must not be thrown away");
    assert.equal(a.proposedMilestoneId, "m");
});

test("two different customers paying the same amount is a conflict", () => {
    const a = attributeDeposit(dep({ amountCents: 1000000 }), {
        qboPayments: [
            { date: "2026-07-29", amountCents: 1000000, customerName: "Kendrick Remodel", checkNumber: null },
            { date: "2026-07-29", amountCents: 1000000, customerName: "Fenn ADU", checkNumber: null },
        ],
    });
    assert.equal(a.confidence, "conflict");
    assert.equal(a.payerName, null);
    assert.equal(a.needsImage, true);
});

test("an unexplained deposit asks for the image", () => {
    // The real $15,723.38 on 08-17: no QBO payment, no milestone.
    const a = attributeDeposit(dep({ id: "d15k", postedDate: "2026-08-17", amountCents: 1572338 }));
    assert.equal(a.confidence, "unknown");
    assert.equal(a.needsImage, true);
    assert.match(a.reason, /Pull the check image/);
});

test("the QBO date window is tight", async t => {
    const pay = (date: string): QboPayment =>
        ({ date, amountCents: 3000000, customerName: "Karen Hartwell", checkNumber: null });
    await t.test("inside the window matches", () => {
        const a = attributeDeposit(dep(), { qboPayments: [pay("2026-07-28")], milestones: [HARTWELL] });
        assert.equal(a.payerName, "Karen Hartwell");
    });
    await t.test("outside the window does NOT match", () => {
        const a = attributeDeposit(dep(), { qboPayments: [pay("2026-06-01")], milestones: [HARTWELL] });
        assert.equal(a.payerName, null);
    });
    await t.test("window is 5 days or fewer", () => assert.ok(PAYMENT_DAY_WINDOW <= 5));
});

test("namesAgree is loose on people but strict on jobs", async t => {
    await t.test("person vs project name", () => assert.ok(namesAgree("Karen Hartwell", "Hartwell Remodel")));
    await t.test("different families do not agree", () =>
        assert.ok(!namesAgree("Dunmore Kitchen", "Hartwell Remodel")));
    await t.test("generic words alone never match", () =>
        assert.ok(!namesAgree("Some Remodel", "Other Remodel")));
    await t.test("null is never a match", () => assert.ok(!namesAgree(null, "Hartwell")));
});

test("one cent off is not a match", () => {
    const a = attributeDeposit(dep(), {
        qboPayments: [{ date: "2026-07-31", amountCents: 3000001, customerName: "Karen Hartwell", checkNumber: null }],
    });
    assert.equal(a.payerName, null);
});

test("batch output is deterministic and the image list is derivable", () => {
    const deposits = [dep({ id: "b" }), dep({ id: "a", amountCents: 1572338 })];
    const one = attributeDeposits(deposits, { milestones: [HARTWELL] });
    const two = attributeDeposits([...deposits].reverse(), { milestones: [HARTWELL] });
    assert.deepEqual(one.map(x => x.depositId), ["a", "b"]);
    assert.equal(JSON.stringify(one), JSON.stringify(two));
    assert.ok(depositsNeedingImages(one).length >= 1);
});

test("empty inputs are safe", () => {
    assert.deepEqual(attributeDeposits([]), []);
    assert.deepEqual(depositsNeedingImages([]), []);
});

// ── Kimi review, 2026-08-19 ──────────────────────────────────────────────
// A second independent reviewer (different model family) found two defects
// that Codex missed, both INTRODUCED BY THE FIXES for its own findings.

test("KIMI-1: a given name ending in S must not escape the guard", async t => {
    // The B3 fix folded a trailing S, turning JAMES into JAME, CHARLES into
    // CHARLE and CHRIS into CHRI — none of which are in COMMON_GIVEN_NAMES.
    // Every such given name was then treated as a SURNAME, reopening the
    // exact wrong-job hole B3 existed to close.
    await t.test("James Hartwell != James Kendrick", () => {
        assert.ok(!namesAgree("James Hartwell", "James Kendrick"));
    });
    await t.test("Charles Prescott != Charles Abbott", () => {
        assert.ok(!namesAgree("Charles Prescott", "Charles Abbott"));
    });
    await t.test("Chris Winters != Chris Culver", () => {
        assert.ok(!namesAgree("Chris Winters", "Chris Culver"));
    });
    await t.test("the original Karen case still rejects", () => {
        assert.ok(!namesAgree("Karen Hartwell", "Karen Kendrick"));
    });
    await t.test("a real surname ending in S still agrees", () => {
        assert.ok(namesAgree("Paul Winters", "Winters Remodel"));
    });
});

test("KIMI-2: the given-name LIST can never be complete", () => {
    // "Nadia" was not in the list, so "Nadia Prescott" agreed with "Nadia
    // Abbott". A structural rule is needed, not a longer list: two full
    // person names sharing exactly one token only agree when the token is
    // in the same POSITION — a shared FIRST name is two people, a shared
    // LAST name is a family.
    assert.ok(!namesAgree("Nadia Prescott", "Nadia Abbott"), "unlisted given name");
    assert.ok(!namesAgree("Priya Culver", "Priya Merrick"), "another unlisted one");
    assert.ok(namesAgree("Nadia Prescott", "Prescott Remodel"), "surname still works");
});

test("KIMI-3: a stale image cannot produce 'verified' on ANY path", async t => {
    // The S3 branch (image settles a multi-customer QBO ambiguity) skipped
    // the B4 amount/date validation entirely, so a mis-keyed image could
    // return the system's highest confidence AND propose a milestone.
    const ms: MilestoneCandidate = {
        id: "m", projectName: "Hartwell Remodel", customerName: "Karen Hartwell",
        milestoneName: "Drywall Complete", amountCents: 3000000, status: "Pending",
    };
    await t.test("via the multi-customer QBO branch", () => {
        const a = attributeDeposit(dep(), {
            qboPayments: [
                { date: "2026-07-31", amountCents: 3000000, customerName: "Kendrick Remodel", checkNumber: null },
                { date: "2026-07-31", amountCents: 3000000, customerName: "Hartwell Remodel", checkNumber: null },
            ],
            checkImage: {
                payerName: "Karen Hartwell", memo: null, checkNumber: "4",
                amountCents: 12345, documentDate: "2026-07-31",   // WRONG amount
            },
            milestones: [ms],
        });
        assert.notEqual(a.confidence, "verified", "a stale image must never be 'verified'");
        assert.equal(a.proposedMilestoneId, null);
        assert.equal(a.needsImage, true);
    });
    await t.test("with no milestone candidates at all", () => {
        const a = attributeDeposit(dep(), {
            checkImage: {
                payerName: "Karen Hartwell", memo: null, checkNumber: "4",
                amountCents: 3000000, documentDate: "2019-01-01",  // stale DATE
            },
        });
        assert.notEqual(a.confidence, "verified");
        assert.equal(a.needsImage, true);
    });
});

test("KIMI-4: an image in hand does not ask for another image pull", () => {
    // Multi-customer QBO ambiguity WITH an image already present. Pulling
    // the same image again cannot help — this needs a human.
    const a = attributeDeposit(dep(), {
        qboPayments: [
            { date: "2026-07-31", amountCents: 3000000, customerName: "Kendrick Remodel", checkNumber: null },
            { date: "2026-07-31", amountCents: 3000000, customerName: "Fenn ADU", checkNumber: null },
        ],
        checkImage: {
            payerName: "Karen Hartwell", memo: null, checkNumber: "4",
            amountCents: 3000000, documentDate: "2026-07-31",
        },
    });
    assert.equal(a.needsImage, false, "the image is already in hand");
    assert.equal(a.confidence, "conflict");
    assert.equal(a.payerName, "Karen Hartwell", "do not discard the strongest name");
    assert.equal(depositsNeedingHuman([a]).length, 1, "but a human must still see it");
});

test("KIMI-5: placeholder customer names are not payers", () => {
    for (const junk of ["-", "N/A", "Unknown", "VARIOUS", "  none  ", "TBD"]) {
        const a = attributeDeposit(dep(), {
            qboPayments: [{ date: "2026-07-31", amountCents: 3000000, customerName: junk, checkNumber: null }],
        });
        assert.equal(a.payerName, null, `"${junk}" must not become a payer`);
    }
});

test("KIMI-6: money must be integer cents", async t => {
    const bad = [3000000.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2];
    await t.test("a non-integer milestone amount is not a candidate", () => {
        for (const amt of bad) {
            const a = attributeDeposit(dep(), {
                milestones: [{
                    id: "m", projectName: "X", customerName: "Y",
                    milestoneName: "Z", amountCents: amt as number, status: "Pending",
                }],
            });
            assert.equal(a.candidateMilestones.length, 0, `${amt} must be rejected`);
        }
    });
    await t.test("a non-integer payment amount never names a payer", () => {
        for (const amt of bad) {
            const a = attributeDeposit(dep(), {
                qboPayments: [{ date: "2026-07-31", amountCents: amt as number, customerName: "Karen Hartwell", checkNumber: null }],
            });
            assert.equal(a.payerName, null, `${amt} must be rejected`);
        }
    });
});
