// Baseline-only entry point for the review-alert rollout gate (Unified Money
// Register plan §4 "Rollout"; Codex finding 1 — "the only entry points
// require REVIEW_ALERTS_ENABLED=true, so 'baseline before enable' is
// operationally impossible").
//
// Run this AFTER scripts/apply-review-alerts-schema.mjs and BEFORE ever
// setting REVIEW_ALERTS_ENABLED=true. It writes every currently-failing
// register row as a SUPPRESSED episode (visible on the dashboard, zero Chat
// cards), does one final catch-up pass for anything that started failing in
// the gap, and marks the RolloutGate row "complete". Idempotent — safe to
// re-run; a call after completion is a single cheap no-op read, and a call
// against a crashed/stale in-progress attempt reclaims and finishes it.
//
// Run with:
//   node --import tsx scripts/run-review-alerts-baseline.ts
//
// Does NOT require REVIEW_ALERTS_ENABLED — this is deliberately the one
// entry point that isn't gated behind it (see review-alert-evaluator.ts's
// `runReviewAlertsBaseline` and review-alert-rollout.ts's module header).

import { prisma } from "../src/lib/prisma";
import { runReviewAlertsBaseline } from "../src/lib/review-alert-evaluator";

async function main() {
    const result = await runReviewAlertsBaseline();
    console.log(
        `[run-review-alerts-baseline] state=${result.state} ranBaseline=${result.ranBaseline}` +
            (result.ranBaseline
                ? ` baselineCount=${result.baselineCount} catchUpCount=${result.catchUpCount}`
                : ""),
    );
    if (result.state !== "complete") {
        console.error(
            "[run-review-alerts-baseline] gate is not complete after this call — " +
                "another worker may be running it, or a crashed attempt isn't stale-reclaimable yet. Re-run shortly.",
        );
        process.exitCode = 1;
    }
}

main()
    .catch((e) => {
        console.error("[run-review-alerts-baseline] FAIL:", e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
