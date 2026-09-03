// Hermetic checks for the clock-in suggestion matcher (src/lib/time-suggestion.ts)
// and the Chat webhook URL guard (src/lib/chat-webhook.ts). Pure-function only —
// no DB, no AI. The ranking/DB layer is covered by e2e/time-suggestion.spec.ts.
//
//   npx tsx scripts/verify-time-suggestion.ts
import assert from "node:assert/strict";
import {
    tokenizeForMatch,
    keywordMatchTasks,
    pickDispatchWinner,
    resolveEstimateChargeableItems,
    type KeywordCandidate,
    type ChargeableEstimateInput,
} from "../src/lib/time-suggestion";
import { isValidChatWebhookUrl } from "../src/lib/chat-webhook";

const CANDIDATES: KeywordCandidate[] = [
    { taskId: "t-demo", taskName: "Demo hall bath", costCodeCode: "01-DEMO", costCodeName: "Demolition" },
    { taskId: "t-dryw", taskName: "Hang drywall in hall bath", costCodeCode: "05-DRYW", costCodeName: "Drywall" },
    { taskId: "t-conc", taskName: "Pour footing", costCodeCode: "29-CONCRETE", costCodeName: "Concrete" },
];

function verifyTokenize(): void {
    // Lowercased, punctuation stripped, stopwords + short + numeric tokens dropped.
    assert.deepEqual(tokenizeForMatch("Start hanging DRYWALL, in the hall-bath!"), ["hanging", "drywall", "hall", "bath"]);
    assert.deepEqual(tokenizeForMatch(""), []);
    assert.deepEqual(tokenizeForMatch(null), []);
    assert.deepEqual(tokenizeForMatch("a an 12 99"), []);
    console.log("PASS tokenize: normalization, stopwords, short/numeric drop");
}

function verifyNextStepsOutranksWorkPerformed(): void {
    // workPerformed points at demo, nextSteps points at drywall — drywall must win
    // (nextSteps tokens count double).
    const match = keywordMatchTasks(
        { workPerformed: "Demo complete in hall bath", nextSteps: "drywall delivery, start hanging drywall" },
        CANDIDATES,
    );
    assert.ok(match);
    assert.equal(match.taskId, "t-dryw");
    console.log("PASS ranking: nextSteps outranks workPerformed");
}

function verifyPhotoCaptionsCount(): void {
    const match = keywordMatchTasks(
        { workPerformed: "long day on site", photoCaptions: ["concrete truck at footing", "pour finished"] },
        CANDIDATES,
    );
    assert.ok(match);
    assert.equal(match.taskId, "t-conc");
    console.log("PASS ranking: photo captions participate in matching");
}

function verifyNoMatchAndTieReturnNull(): void {
    assert.equal(keywordMatchTasks({ workPerformed: "picked up permits downtown" }, CANDIDATES), null);
    assert.equal(keywordMatchTasks({ workPerformed: "" }, CANDIDATES), null);
    // "hall bath" hits t-demo and t-dryw equally — a tie must NOT guess.
    const tie = keywordMatchTasks({ workPerformed: "hall bath" }, [
        { taskId: "a", taskName: "Demo hall bath", costCodeCode: null, costCodeName: null },
        { taskId: "b", taskName: "Paint hall bath", costCodeCode: null, costCodeName: null },
    ]);
    assert.equal(tie, null);
    console.log("PASS ranking: no-signal and tied-top both return null");
}

function verifyCostCodeTokensMatch(): void {
    // The log naming the trade by its cost-code name alone should still match.
    const match = keywordMatchTasks({ nextSteps: "demolition wrap-up" }, CANDIDATES);
    assert.ok(match);
    assert.equal(match.taskId, "t-demo");
    console.log("PASS ranking: cost-code name tokens participate");
}

function verifyDistinctTokenCount(): void {
    // One hot nextSteps word = 1 distinct matched token (callers demote that to
    // medium confidence); two agreeing words = 2.
    const single = keywordMatchTasks({ nextSteps: "concrete order confirmed" }, CANDIDATES);
    assert.ok(single);
    assert.equal(single.taskId, "t-conc");
    assert.equal(single.matchedTokens, 1);
    const double = keywordMatchTasks({ nextSteps: "pour the concrete pad" }, CANDIDATES);
    assert.ok(double);
    assert.equal(double.taskId, "t-conc");
    assert.equal(double.matchedTokens, 2);
    console.log("PASS ranking: matchedTokens counts distinct hits for confidence");
}

function verifyDuplicateTokensDontStack(): void {
    // Repeating a word in the log must not multiply its score: candidate token
    // sets are deduped, and each candidate token scores once.
    const spam = keywordMatchTasks(
        { workPerformed: "concrete concrete concrete", nextSteps: "hang drywall and tape drywall seams in hall bath" },
        CANDIDATES,
    );
    assert.ok(spam);
    assert.equal(spam.taskId, "t-dryw");
    console.log("PASS ranking: repeated tokens don't stack per-candidate");
}

function verifyDispatchWinnerMixedChargeableAndUncosted(): void {
    // A LEAD assignment on an uncosted task must beat an ordinary (non-lead)
    // chargeable assignment when both are active dispatched candidates today —
    // ranking pools ALL of the caller's dispatch together before checking
    // chargeability, rather than only considering uncosted tasks once the
    // chargeable subset comes up empty.
    const leadUncostedWinsOverOrdinaryChargeable = pickDispatchWinner([
        { taskName: "Ordinary chargeable task", assignmentRole: "assigned", startDate: new Date("2026-08-20"), chargeable: true },
        { taskName: "Lead uncosted task", assignmentRole: "lead", startDate: new Date("2026-08-25"), chargeable: false },
    ]);
    assert.equal(leadUncostedWinsOverOrdinaryChargeable.taskName, "Lead uncosted task");
    assert.equal(leadUncostedWinsOverOrdinaryChargeable.chargeable, false);

    // Without a lead role in play, the existing tie-break (earliest startDate,
    // then name) still governs regardless of chargeability.
    const earlierUncostedWinsOnDate = pickDispatchWinner([
        { taskName: "Later chargeable task", assignmentRole: "assigned", startDate: new Date("2026-08-25"), chargeable: true },
        { taskName: "Earlier uncosted task", assignmentRole: "assigned", startDate: new Date("2026-08-20"), chargeable: false },
    ]);
    assert.equal(earlierUncostedWinsOnDate.taskName, "Earlier uncosted task");
    assert.equal(earlierUncostedWinsOnDate.chargeable, false);

    console.log("PASS ranking: dispatch tie-break ranks chargeable and uncosted candidates together");
}

function verifyDispatchWinnerStableOnFullTie(): void {
    // Same role, same startDate, same name (two schedule rows can share a
    // name) — role/startDate/name all tie, so the comparator must not return
    // 0 and fall out to DB order. `order` breaks it first...
    const orderBreaksTie = pickDispatchWinner([
        { taskName: "Punch list", assignmentRole: "assigned", startDate: new Date("2026-08-20"), order: 5, taskId: "z-later-id" },
        { taskName: "Punch list", assignmentRole: "assigned", startDate: new Date("2026-08-20"), order: 2, taskId: "a-earlier-id" },
    ]);
    assert.equal(orderBreaksTie.taskId, "a-earlier-id");
    assert.equal(orderBreaksTie.order, 2);

    // ...and when order ALSO ties, task id is the final deterministic key —
    // repeated calls on the same input must always pick the same winner.
    const idBreaksTie = pickDispatchWinner([
        { taskName: "Punch list", assignmentRole: "assigned", startDate: new Date("2026-08-20"), order: 2, taskId: "z-id" },
        { taskName: "Punch list", assignmentRole: "assigned", startDate: new Date("2026-08-20"), order: 2, taskId: "a-id" },
    ]);
    assert.equal(idBreaksTie.taskId, "a-id");
    const idBreaksTieReversed = pickDispatchWinner([
        { taskName: "Punch list", assignmentRole: "assigned", startDate: new Date("2026-08-20"), order: 2, taskId: "a-id" },
        { taskName: "Punch list", assignmentRole: "assigned", startDate: new Date("2026-08-20"), order: 2, taskId: "z-id" },
    ]);
    assert.equal(idBreaksTieReversed.taskId, "a-id");

    console.log("PASS ranking: dispatch tie-break is fully deterministic (order, then task id, as final keys)");
}

function verifyResolveEstimateChargeableItems(): void {
    // Fixture graph: a coded parent with an uncoded leaf, on TWO separate
    // estimates (standing in for two different projects) — the batch
    // resolver (resolveChargeableItemsForProjects) calls this same pure
    // per-estimate function once per estimate and merges by projectId, so
    // proving it's correct per-estimate and side-effect-free per call is
    // exactly what guarantees the batch path can't cross-contaminate
    // projects or disagree with the single-project resolver.
    const estimateA: ChargeableEstimateInput = {
        id: "est-a",
        title: "Project A Estimate",
        items: [
            { id: "a-parent", name: "Framing", total: 1000, parentId: null, costCodeId: "cc-frame", costCode: { code: "02-FRAME", name: "Framing" } },
            { id: "a-leaf", name: "Rough frame walls", total: 1000, parentId: "a-parent", costCodeId: null, costCode: null },
        ],
    };
    const estimateB: ChargeableEstimateInput = {
        id: "est-b",
        title: "Project B Estimate",
        items: [
            { id: "b-parent", name: "Demo", total: 500, parentId: null, costCodeId: "cc-demo", costCode: { code: "01-DEMO", name: "Demolition" } },
            { id: "b-leaf", name: "Tear out cabinets", total: 500, parentId: "b-parent", costCodeId: null, costCode: null },
        ],
    };

    const resultA = resolveEstimateChargeableItems(estimateA);
    assert.equal(resultA.offered.length, 1);
    assert.equal(resultA.offered[0].id, "a-parent");
    assert.equal(resultA.targetByItemId.get("a-leaf")?.id, "a-parent");
    assert.equal(resultA.targetByItemId.get("a-parent")?.id, "a-parent");

    const resultB = resolveEstimateChargeableItems(estimateB);
    assert.equal(resultB.offered.length, 1);
    assert.equal(resultB.offered[0].id, "b-parent");
    assert.equal(resultB.targetByItemId.get("b-leaf")?.id, "b-parent");

    // Estimate A's resolution must not leak into estimate B's — proves the
    // per-estimate call is pure/stateless, which is what makes merging many
    // of these (one per project, in resolveChargeableItemsForProjects) safe.
    assert.equal(resultB.targetByItemId.has("a-leaf"), false);
    assert.equal(resultA.targetByItemId.has("b-leaf"), false);

    console.log("PASS resolver: leaf resolves to nearest coded ancestor, per-estimate results don't cross-contaminate");
}

function verifyWebhookUrlGuard(): void {
    assert.ok(isValidChatWebhookUrl("https://chat.googleapis.com/v1/spaces/AAQA123/messages?key=k&token=t"));
    assert.ok(!isValidChatWebhookUrl("http://chat.googleapis.com/v1/spaces/AAQA123/messages")); // not https
    assert.ok(!isValidChatWebhookUrl("https://evil.example.com/v1/spaces/AAQA123/messages")); // wrong host
    assert.ok(!isValidChatWebhookUrl("https://chat.googleapis.com/other/path")); // wrong path
    assert.ok(!isValidChatWebhookUrl("not a url"));
    console.log("PASS chat-webhook: URL guard restricts to Google Chat webhooks");
}

verifyTokenize();
verifyNextStepsOutranksWorkPerformed();
verifyPhotoCaptionsCount();
verifyNoMatchAndTieReturnNull();
verifyCostCodeTokensMatch();
verifyDistinctTokenCount();
verifyDuplicateTokensDontStack();
verifyDispatchWinnerMixedChargeableAndUncosted();
verifyDispatchWinnerStableOnFullTie();
verifyResolveEstimateChargeableItems();
verifyWebhookUrlGuard();
console.log("\nverify-time-suggestion: all checks passed");
