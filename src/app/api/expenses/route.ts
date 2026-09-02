export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authenticateMobileOrSession, userCanAccessProject } from "@/lib/mobile-auth";
import { resolveCostCode } from "@/lib/cost-coding";
import { prismaCostCodingDataSource } from "@/lib/cost-coding-db";
import { isCostCodeAllowedForProject } from "@/lib/project-phases";
import { assertPhaseOfProjectTx } from "@/lib/phase-invariant";
import { itemBelongsToEstimateTx, lockEstimateAttribution } from "@/lib/expense-attribution";
import { prismaPhaseDataSource } from "@/lib/project-phases-db";
import { dateOnlyInTimeZone, resolveCompanyTimeZone } from "@/lib/company-timezone";

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
        const requestedCostCodeId: string | null =
            typeof body.costCodeId === "string" && body.costCodeId.trim() ? body.costCodeId.trim() : null;

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
        let parsedDate: Date | null = null;
        if (date) {
            if (typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
                try {
                    parsedDate = dateOnlyInTimeZone(date, await resolveCompanyTimeZone());
                } catch {
                    return NextResponse.json({ error: "Invalid date" }, { status: 400 });
                }
            } else {
                const d = new Date(date);
                if (Number.isNaN(d.getTime())) {
                    return NextResponse.json({ error: "Invalid date" }, { status: 400 });
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
                // "capture" and no automated pass may ever overwrite it.
                costCodeSource: costCodeId ? "capture" : null,
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
