export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authenticateMobileOrSession, userCanAccessProject } from "@/lib/mobile-auth";
import { resolveCostCode } from "@/lib/cost-coding";
import { prismaCostCodingDataSource } from "@/lib/cost-coding-db";
import { isCostCodeAllowedForProject } from "@/lib/project-phases";
import { assertPhaseOfProjectTx, lockAttributionParents } from "@/lib/phase-invariant";
import {
    COST_CODE_ID_INVALID_MESSAGE,
    itemBelongsToEstimateTx,
    lockEstimateAttribution,
    parseCostCodeIdEdit,
} from "@/lib/expense-attribution";
import { prismaPhaseDataSource } from "@/lib/project-phases-db";
import { CALENDAR_DATE_NOT_REAL, classifyCalendarDate, dateOnlyInTimeZone, resolveCompanyTimeZone } from "@/lib/company-timezone";

// Hybrid auth (web + mobile). Accepts EITHER `estimateId` (web flow — caller already
// chose the estimate) OR `projectId` (mobile flow — server picks the project's first
// estimate). At least one must be present.
export async function POST(req: NextRequest) {
    try {
        const auth = await authenticateMobileOrSession(req);
        if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
        const { user } = auth;

        const body = await req.json();
        const { itemId, amount, vendor, date, description, receiptUrl } = body;
        let { estimateId, projectId } = body;
        // Phase 3 (spec §3.4): the crew app may now send a phase. Optional on
        // purpose — this route also serves legacy mobile builds and the
        // no-photo path, and rejecting an uncoded expense here would just stop
        // the spend being recorded at all. `costCodeSource` is NEVER read off
        // the body: provenance is something the server observes, not something
        // a client asserts.
        // THE SHARED PARSER (round 40, item 3). This used to read a non-string
        // as if the key had never been sent, so a crew app posting
        // `{ costCodeId: { id: "cc-1" } }` recorded the spend UNCODED and
        // reported success — the phase the person picked on the phone simply
        // vanished, and nothing in the response said so. Malformed is a 400
        // now; a genuinely absent key is still optional, which is the whole
        // reason this route tolerates one.
        const costCodeEdit = parseCostCodeIdEdit(body);
        if (costCodeEdit.kind === "invalid") {
            return NextResponse.json(
                { error: COST_CODE_ID_INVALID_MESSAGE, field: "costCodeId" },
                { status: 400 },
            );
        }
        const requestedCostCodeId: string | null =
            costCodeEdit.kind === "set" ? costCodeEdit.costCodeId : null;
        // AN EXPLICIT "NO PHASE" ON CREATE IS A DECISION TOO (round 42, item 3).
        //
        // The parser keeps `clear` and `untouched` apart precisely because they
        // are different facts, and this route threw the distinction away: both
        // became a null code with a null source, which is the state every
        // automated pass reads as "no human has spoken, a machine may write".
        // So a crew member who deliberately picked NO phase on the phone had
        // the QBO suggester put its regex guess on the row minutes later —
        // the same clear-then-overwrite failure round 36 fixed for the edit
        // path, on the create path.
        //
        // An OMITTED key stays unclassified: this route serves legacy mobile
        // builds and the no-photo path, where silence means "nobody was asked",
        // not "somebody said none".
        const clearsCostCode = costCodeEdit.kind === "clear";

        if (!estimateId && !projectId) {
            return NextResponse.json(
                { error: "estimateId or projectId is required" },
                { status: 400 }
            );
        }

        // Mobile path: derive estimateId from projectId. Use the most recently created
        // estimate so a project that has been re-estimated still attaches to the active one.
        // If no estimate exists yet, fail with a clear message rather than a Prisma FK error.
        if (!estimateId && projectId) {
            const allowed = await userCanAccessProject(user, projectId);
            if (!allowed) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

            const est = await prisma.estimate.findFirst({
                where: { projectId },
                orderBy: { createdAt: "desc" },
                select: { id: true },
            });
            if (!est) {
                return NextResponse.json(
                    {
                        error:
                            "This project has no estimate yet. Build an estimate on the web before logging expenses.",
                    },
                    { status: 400 }
                );
            }
            estimateId = est.id;
        } else if (estimateId) {
            // Web path: verify the caller has access to the project that owns this estimate.
            const est = await prisma.estimate.findUnique({
                where: { id: estimateId },
                select: { projectId: true },
            });
            if (!est) return NextResponse.json({ error: "Estimate not found" }, { status: 404 });
            if (!est.projectId) {
                return NextResponse.json({ error: "Estimate has no project" }, { status: 400 });
            }
            const allowed = await userCanAccessProject(user, est.projectId);
            if (!allowed) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
            projectId = est.projectId;
        }

        if (itemId) {
            // Scope itemId to the chosen estimate. Without this scope, a caller with
            // access to estimate A could attach an expense to a line item from estimate B.
            const itemExists = await prisma.estimateItem.findFirst({
                where: { id: itemId, estimateId },
                select: { id: true },
            });
            if (!itemExists) {
                return NextResponse.json(
                    {
                        error:
                            "Selected line item does not belong to this estimate (or is unsaved). Save the Estimate on the web first.",
                    },
                    { status: 400 }
                );
            }
        }

        const numericAmount = typeof amount === "number" ? amount : Number(amount);
        if (!Number.isFinite(numericAmount) || numericAmount < 0) {
            return NextResponse.json(
                { error: "amount must be a finite number ≥ 0" },
                { status: 400 }
            );
        }

        // `Expense.date` is a COMPANY CALENDAR DAY. `new Date("2026-07-01")`
        // parses as UTC midnight, which reads as 30 June in Pacific — the tax
        // report would then file the receipt in the wrong month, and at a
        // quarter edge in the wrong return. A bare YYYY-MM-DD goes through the
        // shared parser; a full timestamp is kept as the instant it already is.
        //
        // ONE definition of "is this a calendar day", shared with the PUT, the
        // receipt ingest and the AI parse (round 47, item 2): the shape AND a
        // Date.UTC round trip, so `2026-02-31` is refused here rather than
        // throwing inside the parser.
        let parsedDate: Date | null = null;
        if (date) {
            const verdict = classifyCalendarDate(date);
            if (verdict.kind === "valid") {
                parsedDate = dateOnlyInTimeZone(verdict.date, await resolveCompanyTimeZone());
            } else if (verdict.kind === "invalid" && verdict.reason === CALENDAR_DATE_NOT_REAL) {
                // A YYYY-MM-DD that names no real day. NOT retried as an
                // instant: `new Date("2026-02-31")` rolls forward to 3 March
                // rather than failing, which would store a date nobody typed.
                return NextResponse.json({ error: "Invalid date", date: verdict.value }, { status: 400 });
            } else {
                const d = new Date(date);
                if (Number.isNaN(d.getTime())) {
                    return NextResponse.json(
                        { error: "Invalid date", date: verdict.kind === "invalid" ? verdict.value : String(date) },
                        { status: 400 },
                    );
                }
                parsedDate = d;
            }
        }

        // BOTH checks, per the SCOPE note on resolveCostCode: "the cost code
        // exists and is active" is attribution, "this code belongs to this job"
        // is permission, and neither implies the other.
        let costCodeId: string | null = null;
        let costTypeId: string | null = null;
        if (requestedCostCodeId) {
            const resolved = await resolveCostCode(prismaCostCodingDataSource, {
                costCodeId: requestedCostCodeId,
            });
            if (!resolved.ok) {
                return NextResponse.json(
                    { error: resolved.error, code: resolved.code },
                    { status: resolved.status },
                );
            }
            const allowed = await isCostCodeAllowedForProject(
                prismaPhaseDataSource,
                projectId,
                resolved.costCodeId,
            );
            if (!allowed) {
                return NextResponse.json(
                    {
                        error: "That cost code isn't one of this project's phases.",
                        code: "PHASE_NOT_ON_PROJECT",
                    },
                    { status: 400 },
                );
            }
            costCodeId = resolved.costCodeId;
            costTypeId = resolved.costTypeId;
        }

        // THE PHASE ANSWER THAT COUNTS, taken with the write (round 18, item 4).
        //
        // The check above ran on the global client and holds nothing: an
        // estimate archived or reassigned, or the code deactivated, between it
        // and the insert would still be stamped onto a brand new row — as
        // "capture", which no automated pass may then correct.
        const created = await prisma.$transaction(async tx => {
            const raw = tx as unknown as { $queryRawUnsafe(q: string, ...v: unknown[]): Promise<unknown> };
            // THE WHOLE LOCK SET, IN THE CANONICAL ORDER, FIRST (round 37,
            // item 3): Project -> Estimate -> EstimateItem -> CostCode.
            //
            // The three helpers below each take a SLICE of that set, and left
            // to themselves they take it in the wrong order —
            // `lockEstimateAttribution` share-locks the Estimate and only then
            // does `assertPhaseOfProjectTx` reach for the Project. Against a
            // job editor holding its Project row FOR UPDATE that is a cycle,
            // and Postgres resolves a cycle by killing somebody (40P01).
            // Acquiring the whole set here makes each of them a free
            // re-acquisition of a lock this transaction already owns.
            await lockAttributionParents(raw, {
                projectId,
                estimateId,
                itemId: itemId || null,
                costCodeId,
            });
            // THE PAIR, RE-READ UNDER LOCK (round 20, item 3). Everything above
            // resolved the estimate's project and then did other work; an
            // estimate moved in that window would be inserted alongside the OLD
            // project, putting one expense on two jobs at once.
            const pair = await lockEstimateAttribution(raw, estimateId);
            if (!pair) return { expense: null, phaseRejected: null, conflict: "no-project" } as const;
            if (pair.projectId !== projectId) {
                // The access check above was answered about a different job.
                return { expense: null, phaseRejected: null, conflict: "moved" } as const;
            }
            if (itemId && !(await itemBelongsToEstimateTx(raw, itemId, estimateId))) {
                return { expense: null, phaseRejected: null, conflict: "item" } as const;
            }
            if (costCodeId) {
                const verdict = await assertPhaseOfProjectTx(
                    tx as unknown as { $queryRawUnsafe(q: string, ...v: unknown[]): Promise<unknown> },
                    projectId,
                    costCodeId,
                );
                if (!verdict.ok) {
                    return { expense: null, phaseRejected: verdict.reason, conflict: null } as const;
                }
            }
            const expense = await tx.expense.create({
                data: {
                // ONE PAIR, from one locked read: the estimate and the job it
                // belongs to, as they are at THIS moment.
                estimateId: pair.estimateId,
                projectId: pair.projectId,
                itemId: itemId || null,
                costCodeId,
                costTypeId,
                // A person picked this on a phone or in a form, so it is
                // "capture" and no automated pass may ever overwrite it — and
                // an explicit `costCodeId: null` is the same person saying
                // there is NO phase, recorded as "manual-none" so nothing
                // overwrites that either (round 42, item 3). An omitted key is
                // neither: it stays unclassified and machine-writable.
                costCodeSource: costCodeId ? "capture" : clearsCostCode ? "manual-none" : null,
                amount: numericAmount,
                vendor: vendor || null,
                date: parsedDate,
                description: description || null,
                receiptUrl: receiptUrl || null,
                status: "Pending",
                },
            });
            return { expense, phaseRejected: null, conflict: null } as const;
        });
        if (created.conflict) {
            return NextResponse.json(
                {
                    error: created.conflict === "item"
                        ? "That line item is no longer on this estimate."
                        : "This estimate moved to another job. Reopen the page and try again.",
                    code: created.conflict === "item" ? "ITEM_NOT_ON_ESTIMATE" : "ESTIMATE_REATTRIBUTED",
                },
                { status: 409 },
            );
        }
        if (created.phaseRejected) {
            return NextResponse.json(
                {
                    error: "That cost code stopped being one of this project's phases.",
                    code: "PHASE_NOT_ON_PROJECT",
                    reason: created.phaseRejected,
                },
                { status: 400 },
            );
        }

        return NextResponse.json(created.expense);
    } catch (error: any) {
        console.error("Error creating expense:", error);
        return NextResponse.json(
            { error: "Failed to create expense", details: error?.message || String(error) },
            { status: 500 }
        );
    }
}
