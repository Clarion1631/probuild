// Hermetic checks for the clock-in suggestion matcher (src/lib/time-suggestion.ts)
// and the Chat webhook URL guard (src/lib/chat-webhook.ts). Pure-function only —
// no DB, no AI. The ranking/DB layer is covered by e2e/time-suggestion.spec.ts.
//
//   npx tsx scripts/verify-time-suggestion.ts
import assert from "node:assert/strict";
import {
    tokenizeForMatch,
    keywordMatchTasks,
    type KeywordCandidate,
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
verifyDuplicateTokensDontStack();
verifyWebhookUrlGuard();
console.log("\nverify-time-suggestion: all checks passed");
