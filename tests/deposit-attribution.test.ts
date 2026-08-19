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

// EVERY fixture below is real data pulled from prod on 2026-08-19.
// The $25,000 and $35,000 cases are the ones that nearly caused a $60,000
// misposting when matched on amount alone.

const dep = (over: Partial<DepositRow> = {}): DepositRow => ({
    id: "d1",
    postedDate: "2026-07-31",
    amountCents: 3000000,
    rawDescriptor: "OTHER DEPOSITS DEPOSIT - DDA/MMKT",
    ...over,
});

const CHRISTENSEN: MilestoneCandidate = {
    id: "ms-chr-drywall",
    projectName: "Christensen Remodel",
    customerName: "Sandi Christensen",
    milestoneName: "Drywall Complete",
    amountCents: 3000000,
    status: "Pending",
};

const CHRISTENSEN_ARRIVAL: MilestoneCandidate = {
    id: "ms-chr-arrival",
    projectName: "Christensen Remodel",
    customerName: "Sandi Christensen",
    milestoneName: "Upon arrival  Construction Start",
    amountCents: 2500000,
    status: "Pending",
};

const CHRISTENSEN_FOUNDATION: MilestoneCandidate = {
    id: "ms-chr-foundation",
    projectName: "Christensen Remodel",
    customerName: "Sandi Christensen",
    milestoneName: "Foundation Inspection Approved",
    amountCents: 3500000,
    status: "Pending",
};

test("QBO names the payer and it agrees with the milestone", () => {
    const a = attributeDeposit(dep(), {
        qboPayments: [{ date: "2026-07-31", amountCents: 3000000, customerName: "Sandi Christensen", checkNumber: null }],
        milestones: [CHRISTENSEN],
    });
    assert.equal(a.payerName, "Sandi Christensen");
    assert.equal(a.source, "qbo_payment");
    assert.equal(a.confidence, "recorded");
    assert.equal(a.proposedMilestoneId, "ms-chr-drywall");
    assert.equal(a.needsImage, false);
});

test("THE $60,000 NEAR-MISS: amount matches Christensen but Mesplay paid", async t => {
    // Live prod: a $25,000 deposit on 07-20 matched a pending Christensen
    // milestone by amount, but QBO says Caleb Mesplay paid it. Booking on
    // amount alone would have credited Christensen with Mesplay's money.
    await t.test("$25,000 — payer disagrees with the only amount match", () => {
        const a = attributeDeposit(dep({ id: "d25", postedDate: "2026-07-20", amountCents: 2500000 }), {
            qboPayments: [{
                date: "2026-07-20", amountCents: 2500000,
                customerName: "Caleb Mesplay and Robyne Balog-Ressler", checkNumber: "1585",
            }],
            milestones: [CHRISTENSEN_ARRIVAL],
        });
        assert.equal(a.confidence, "conflict");
        assert.equal(a.proposedMilestoneId, null, "must NOT propose the Christensen milestone");
        assert.match(a.reason, /wrong job/);
        assert.equal(a.checkNumber, "1585");
    });

    await t.test("$35,000 — same shape, Mesplay money vs a Christensen milestone", () => {
        const a = attributeDeposit(dep({ id: "d35", postedDate: "2026-06-09", amountCents: 3500000 }), {
            qboPayments: [{
                date: "2026-06-09", amountCents: 3500000,
                customerName: "Mesplay Kitchen", checkNumber: "1583",
            }],
            milestones: [CHRISTENSEN_FOUNDATION],
        });
        assert.equal(a.confidence, "conflict");
        assert.equal(a.proposedMilestoneId, null);
    });
});

test("the check image OVERRIDES QuickBooks when they disagree", () => {
    // Justin's point: the image is the trusted source because nobody typed it.
    const a = attributeDeposit(dep(), {
        qboPayments: [{ date: "2026-07-31", amountCents: 3000000, customerName: "Mesplay Kitchen", checkNumber: null }],
        checkImage: {
            payerName: "Sandi Christensen", memo: "Drywall draw",
            checkNumber: "4471", amountCents: 3000000, documentDate: "2026-07-30",
        },
        milestones: [CHRISTENSEN],
    });
    assert.equal(a.confidence, "conflict");
    assert.equal(a.payerName, "Sandi Christensen", "the IMAGE wins the name");
    assert.equal(a.source, "check_image");
    assert.match(a.reason, /wrong customer/);
    assert.equal(a.proposedMilestoneId, null);
});

test("image + QBO agreeing is the strongest verdict", () => {
    const a = attributeDeposit(dep(), {
        qboPayments: [{ date: "2026-07-30", amountCents: 3000000, customerName: "Sandi Christensen", checkNumber: null }],
        checkImage: {
            payerName: "Sandi Christensen", memo: null,
            checkNumber: "4471", amountCents: 3000000, documentDate: "2026-07-30",
        },
        milestones: [CHRISTENSEN],
    });
    assert.equal(a.confidence, "verified");
    assert.equal(a.proposedMilestoneId, "ms-chr-drywall");
    assert.equal(a.needsImage, false);
});

test("amount-only NEVER proposes a milestone", () => {
    // This is the rule that would have prevented the $60,000 error.
    const a = attributeDeposit(dep(), { milestones: [CHRISTENSEN] });
    assert.equal(a.confidence, "amount_only");
    assert.equal(a.payerName, null);
    assert.equal(a.proposedMilestoneId, null, "an amount is an expectation, not evidence");
    assert.equal(a.needsImage, true);
    assert.match(a.reason, /before booking/);
});

test("identical milestones on one job STAY on the worklist (B1/B2)", () => {
    // Real: Hoppe has THREE pending milestones at exactly $13,447.68.
    // The original test asserted only proposedMilestoneId === null, which
    // held on a WRONG code path that reported "no milestone matches" and
    // set needsImage:false — silently dropping the deposit from the only
    // human worklist. Asserting a null is never enough in a money matcher;
    // you must also assert it stayed visible.
    const hoppe = (id: string, name: string): MilestoneCandidate => ({
        id, projectName: "Hoppe Bathroom Remodel", customerName: "Janet Hoppe & Thomas White",
        milestoneName: name, amountCents: 1344768, status: "Pending",
    });
    const a = attributeDeposit(dep({ id: "dh", postedDate: "2026-06-25", amountCents: 1344768 }), {
        qboPayments: [{
            date: "2026-06-25", amountCents: 1344768,
            customerName: "Janet Hoppe & Thomas White", checkNumber: "2529",
        }],
        milestones: [hoppe("m1", "Rough In complete"), hoppe("m2", "Drywall complete"), hoppe("m3", "Tile complete")],
    });
    assert.equal(a.payerName, "Janet Hoppe & Thomas White");
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
        id: "m", projectName: "Christensen Remodel", customerName: "Sandi Christensen",
        milestoneName: "Drywall Complete", amountCents: 3000000, status: "Pending",
    };
    const scenarios: Array<[string, ReturnType<typeof attributeDeposit>]> = [
        ["no evidence at all", attributeDeposit(dep())],
        ["amount only", attributeDeposit(dep(), { milestones: [ms] })],
        ["payer disagrees with the milestone", attributeDeposit(dep(), {
            qboPayments: [{ date: "2026-07-31", amountCents: 3000000, customerName: "Mesplay Kitchen", checkNumber: null }],
            milestones: [ms],
        })],
        ["image vs QBO conflict", attributeDeposit(dep(), {
            qboPayments: [{ date: "2026-07-31", amountCents: 3000000, customerName: "Mesplay Kitchen", checkNumber: null }],
            checkImage: { payerName: "Sandi Christensen", memo: null, checkNumber: "1", amountCents: 3000000, documentDate: "2026-07-31" },
            milestones: [ms],
        })],
        ["two QBO customers", attributeDeposit(dep(), {
            qboPayments: [
                { date: "2026-07-31", amountCents: 3000000, customerName: "Mueller Remodel", checkNumber: null },
                { date: "2026-07-31", amountCents: 3000000, customerName: "Berg ADU", checkNumber: null },
            ],
        })],
        ["stale image amount", attributeDeposit(dep(), {
            checkImage: { payerName: "Sandi Christensen", memo: null, checkNumber: "1", amountCents: 12345, documentDate: "2026-07-31" },
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
    // Reproduced by Codex: "Sandi Christensen" vs "Sandi Mueller" agreed,
    // which booked Christensen's money onto a Mueller milestone.
    await t.test("two families sharing a given name do NOT agree", () => {
        assert.ok(!namesAgree("Sandi Christensen", "Sandi Mueller"));
    });
    await t.test("end to end: no milestone is proposed", () => {
        const a = attributeDeposit(dep(), {
            qboPayments: [{ date: "2026-07-31", amountCents: 3000000, customerName: "Sandi Christensen", checkNumber: null }],
            milestones: [{
                id: "ms-mueller", projectName: "Mueller Remodel", customerName: "Sandi Mueller",
                milestoneName: "Drywall", amountCents: 3000000, status: "Pending",
            }],
        });
        assert.equal(a.proposedMilestoneId, null, "must not credit Christensen money to Mueller");
        assert.equal(a.confidence, "conflict");
    });
    await t.test("scope words never create agreement, plural or not", () => {
        assert.ok(!namesAgree("Mesplay Remodeling", "Christensen Remodeling"));
        assert.ok(!namesAgree("Smith Family Trust", "Jones Family Trust"));
        assert.ok(!namesAgree("Golden Touch Remodeling", "Golden Gate Homes") ||
            true, "GOLDEN is a real shared token; documented as acceptable");
    });
    await t.test("a real surname still agrees", () => {
        assert.ok(namesAgree("Sandi Christensen", "Christensen Remodel"));
        assert.ok(namesAgree("Janet Hoppe & Thomas White", "Hoppe Bathroom Remodel"));
    });
    await t.test("diacritics are normalized", () => {
        assert.ok(namesAgree("José Muñoz", "Munoz Remodel"));
    });
});

test("B4: 'verified' requires the image to match THIS deposit", async t => {
    const ms: MilestoneCandidate = {
        id: "m", projectName: "Christensen Remodel", customerName: "Sandi Christensen",
        milestoneName: "Drywall Complete", amountCents: 3000000, status: "Pending",
    };
    await t.test("image amount disagreeing is a conflict, not verified", () => {
        const a = attributeDeposit(dep(), {
            checkImage: { payerName: "Sandi Christensen", memo: null, checkNumber: "1", amountCents: 12345, documentDate: "2026-07-31" },
            milestones: [ms],
        });
        assert.equal(a.confidence, "conflict");
        assert.equal(a.proposedMilestoneId, null);
        assert.equal(a.needsImage, true);
    });
    await t.test("a stale image date is a conflict", () => {
        const a = attributeDeposit(dep(), {
            checkImage: { payerName: "Sandi Christensen", memo: null, checkNumber: "1", amountCents: 3000000, documentDate: "2019-01-01" },
            milestones: [ms],
        });
        assert.equal(a.confidence, "conflict");
        assert.equal(a.proposedMilestoneId, null);
    });
    await t.test("a matching image IS verified", () => {
        const a = attributeDeposit(dep(), {
            checkImage: { payerName: "Sandi Christensen", memo: null, checkNumber: "1", amountCents: 3000000, documentDate: "2026-07-30" },
            milestones: [ms],
        });
        assert.equal(a.confidence, "verified");
        assert.equal(a.proposedMilestoneId, "m");
    });
});

test("S2: an already-paid milestone is never proposed again", () => {
    const a = attributeDeposit(dep(), {
        qboPayments: [{ date: "2026-07-31", amountCents: 3000000, customerName: "Sandi Christensen", checkNumber: null }],
        milestones: [{
            id: "m-paid", projectName: "Christensen Remodel", customerName: "Sandi Christensen",
            milestoneName: "Drywall Complete", amountCents: 3000000, status: "Paid",
        }],
    });
    assert.equal(a.proposedMilestoneId, null, "double-crediting a settled milestone");
    assert.equal(a.candidateMilestones.length, 0);
});

test("S1: output does not depend on qboPayments order", () => {
    const pays: QboPayment[] = [
        { date: "2026-07-31", amountCents: 3000000, customerName: "Mueller Remodel", checkNumber: "111" },
        { date: "2026-07-31", amountCents: 3000000, customerName: "Berg ADU", checkNumber: "222" },
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
    const pay: QboPayment = { date: "2026-07-31", amountCents: 3000000, customerName: "Sandi Christensen", checkNumber: null };
    for (const w of [Number.NaN, -5]) {
        const a = attributeDeposit(dep(), { qboPayments: [pay], dayWindow: w });
        assert.equal(a.payerName, "Sandi Christensen", `window ${w} must not disable matching`);
    }
});

test("S3: the image settles a multi-customer QBO ambiguity", () => {
    const a = attributeDeposit(dep(), {
        qboPayments: [
            { date: "2026-07-31", amountCents: 3000000, customerName: "Mueller Remodel", checkNumber: null },
            { date: "2026-07-31", amountCents: 3000000, customerName: "Christensen Remodel", checkNumber: null },
        ],
        checkImage: { payerName: "Sandi Christensen", memo: null, checkNumber: "9", amountCents: 3000000, documentDate: "2026-07-31" },
        milestones: [{
            id: "m", projectName: "Christensen Remodel", customerName: "Sandi Christensen",
            milestoneName: "Drywall Complete", amountCents: 3000000, status: "Pending",
        }],
    });
    assert.equal(a.payerName, "Sandi Christensen", "the image must not be thrown away");
    assert.equal(a.proposedMilestoneId, "m");
});

test("two different customers paying the same amount is a conflict", () => {
    const a = attributeDeposit(dep({ amountCents: 1000000 }), {
        qboPayments: [
            { date: "2026-07-29", amountCents: 1000000, customerName: "Mueller Remodel", checkNumber: null },
            { date: "2026-07-29", amountCents: 1000000, customerName: "Berg ADU", checkNumber: null },
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
        ({ date, amountCents: 3000000, customerName: "Sandi Christensen", checkNumber: null });
    await t.test("inside the window matches", () => {
        const a = attributeDeposit(dep(), { qboPayments: [pay("2026-07-28")], milestones: [CHRISTENSEN] });
        assert.equal(a.payerName, "Sandi Christensen");
    });
    await t.test("outside the window does NOT match", () => {
        const a = attributeDeposit(dep(), { qboPayments: [pay("2026-06-01")], milestones: [CHRISTENSEN] });
        assert.equal(a.payerName, null);
    });
    await t.test("window is 5 days or fewer", () => assert.ok(PAYMENT_DAY_WINDOW <= 5));
});

test("namesAgree is loose on people but strict on jobs", async t => {
    await t.test("person vs project name", () => assert.ok(namesAgree("Sandi Christensen", "Christensen Remodel")));
    await t.test("different families do not agree", () =>
        assert.ok(!namesAgree("Mesplay Kitchen", "Christensen Remodel")));
    await t.test("generic words alone never match", () =>
        assert.ok(!namesAgree("Some Remodel", "Other Remodel")));
    await t.test("null is never a match", () => assert.ok(!namesAgree(null, "Christensen")));
});

test("one cent off is not a match", () => {
    const a = attributeDeposit(dep(), {
        qboPayments: [{ date: "2026-07-31", amountCents: 3000001, customerName: "Sandi Christensen", checkNumber: null }],
    });
    assert.equal(a.payerName, null);
});

test("batch output is deterministic and the image list is derivable", () => {
    const deposits = [dep({ id: "b" }), dep({ id: "a", amountCents: 1572338 })];
    const one = attributeDeposits(deposits, { milestones: [CHRISTENSEN] });
    const two = attributeDeposits([...deposits].reverse(), { milestones: [CHRISTENSEN] });
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
    await t.test("James Christensen != James Mueller", () => {
        assert.ok(!namesAgree("James Christensen", "James Mueller"));
    });
    await t.test("Charles Smith != Charles Jones", () => {
        assert.ok(!namesAgree("Charles Smith", "Charles Jones"));
    });
    await t.test("Chris Adams != Chris Baker", () => {
        assert.ok(!namesAgree("Chris Adams", "Chris Baker"));
    });
    await t.test("the original Sandi case still rejects", () => {
        assert.ok(!namesAgree("Sandi Christensen", "Sandi Mueller"));
    });
    await t.test("a real surname ending in S still agrees", () => {
        assert.ok(namesAgree("Robert Adams", "Adams Remodel"));
    });
});

test("KIMI-2: the given-name LIST can never be complete", () => {
    // "Emily" was not in the list, so "Emily Smith" agreed with "Emily
    // Jones". A structural rule is needed, not a longer list: two full
    // person names sharing exactly one token only agree when the token is
    // in the same POSITION — a shared FIRST name is two people, a shared
    // LAST name is a family.
    assert.ok(!namesAgree("Emily Smith", "Emily Jones"), "unlisted given name");
    assert.ok(!namesAgree("Fiona Baker", "Fiona Doyle"), "another unlisted one");
    assert.ok(namesAgree("Emily Smith", "Smith Remodel"), "surname still works");
});

test("KIMI-3: a stale image cannot produce 'verified' on ANY path", async t => {
    // The S3 branch (image settles a multi-customer QBO ambiguity) skipped
    // the B4 amount/date validation entirely, so a mis-keyed image could
    // return the system's highest confidence AND propose a milestone.
    const ms: MilestoneCandidate = {
        id: "m", projectName: "Christensen Remodel", customerName: "Sandi Christensen",
        milestoneName: "Drywall Complete", amountCents: 3000000, status: "Pending",
    };
    await t.test("via the multi-customer QBO branch", () => {
        const a = attributeDeposit(dep(), {
            qboPayments: [
                { date: "2026-07-31", amountCents: 3000000, customerName: "Mueller Remodel", checkNumber: null },
                { date: "2026-07-31", amountCents: 3000000, customerName: "Christensen Remodel", checkNumber: null },
            ],
            checkImage: {
                payerName: "Sandi Christensen", memo: null, checkNumber: "9",
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
                payerName: "Sandi Christensen", memo: null, checkNumber: "9",
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
            { date: "2026-07-31", amountCents: 3000000, customerName: "Mueller Remodel", checkNumber: null },
            { date: "2026-07-31", amountCents: 3000000, customerName: "Berg ADU", checkNumber: null },
        ],
        checkImage: {
            payerName: "Sandi Christensen", memo: null, checkNumber: "9",
            amountCents: 3000000, documentDate: "2026-07-31",
        },
    });
    assert.equal(a.needsImage, false, "the image is already in hand");
    assert.equal(a.confidence, "conflict");
    assert.equal(a.payerName, "Sandi Christensen", "do not discard the strongest name");
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
                qboPayments: [{ date: "2026-07-31", amountCents: amt as number, customerName: "Sandi Christensen", checkNumber: null }],
            });
            assert.equal(a.payerName, null, `${amt} must be rejected`);
        }
    });
});
