export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authenticateMobileOrSession, userCanAccessProject } from "@/lib/mobile-auth";
import { resolveCostCode } from "@/lib/cost-coding";
import { prismaCostCodingDataSource } from "@/lib/cost-coding-db";
import { isCostCodeAllowedForProject } from "@/lib/project-phases";
import { prismaPhaseDataSource } from "@/lib/project-phases-db";

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

        let parsedDate: Date | null = null;
        if (date) {
            const d = new Date(date);
            if (Number.isNaN(d.getTime())) {
                return NextResponse.json({ error: "Invalid date" }, { status: 400 });
            }
            parsedDate = d;
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

        const newExpense = await prisma.expense.create({
            data: {
                estimateId,
                // Phase 3: born with its job. Resolved above in both branches
                // (derived from the estimate on the web path, checked against
                // the caller's access on the mobile path).
                projectId,
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

        return NextResponse.json(newExpense);
    } catch (error: any) {
        console.error("Error creating expense:", error);
        return NextResponse.json(
            { error: "Failed to create expense", details: error?.message || String(error) },
            { status: 500 }
        );
    }
}
