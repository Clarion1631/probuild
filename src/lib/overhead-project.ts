// The single definition of "which project is the overhead bucket".
//
// "Shop" is not a job — it is where no-customer purchases land (see the QBO
// expense sync's `overheadProjectId` triage). It has no client, no bid, and no
// meaningful budget, so job-level profitability questions do not apply to it.
//
// This was previously duplicated as an inline constant in
// src/lib/company-financials-charts.ts while two API routes read the env var
// directly. Extracted here so the financial charts, the QBO sync, and the job
// variance report can never disagree about which project to exclude.
//
// Override with QBO_EXPENSE_OVERHEAD_PROJECT_ID. The fallback is the prod
// "Shop" project id, which CLAUDE.md also documents as the sanctioned
// click-through project.

export const OVERHEAD_PROJECT_ID =
    process.env.QBO_EXPENSE_OVERHEAD_PROJECT_ID || "cmpd6xca1009x1iizdf4suln3";

/**
 * True when this project is the company overhead bucket rather than a real job.
 *
 * Job-costing surfaces (variance, per-job profitability) should exclude it:
 * measured on prod 2026-08-19 it carried $71,991 of actuals against a $12,511
 * nominal budget at 0% phase attribution — the largest and least actionable row
 * on the variance report, and pure noise next to real jobs.
 */
export function isOverheadProject(projectId: string): boolean {
    return projectId === OVERHEAD_PROJECT_ID;
}
