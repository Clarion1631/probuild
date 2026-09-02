import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import {
    QboManagedExpenseError,
    assertExpenseMutableOutsideQbo,
} from "@/lib/qbo-expense-guard";
import { resolveExpenseProjectId } from "@/lib/expense-attribution";
import { resolveCostCode } from "@/lib/cost-coding";
import { prismaCostCodingDataSource } from "@/lib/cost-coding-db";
import { isCostCodeAllowedForProject } from "@/lib/project-phases";
import { prismaPhaseDataSource } from "@/lib/project-phases-db";

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        const id = (await params).id;
        if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

        const expense = await prisma.expense.findUnique({
            where: { id },
            select: { qbPurchaseId: true },
        });
        assertExpenseMutableOutsideQbo(expense);
        await prisma.expense.deleteMany({ where: { id, qbPurchaseId: null } });

        return NextResponse.json({ success: true });
    } catch (error) {
        if (error instanceof QboManagedExpenseError) {
            return NextResponse.json({ error: error.message }, { status: 409 });
        }
        console.error("Error deleting expense:", error);
        return NextResponse.json({ error: "Failed to delete expense" }, { status: 500 });
    }
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        const id = (await params).id;
        if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

        const expense = await prisma.expense.findUnique({
            where: { id },
            select: {
                qbPurchaseId: true,
                amount: true,
                taxAmount: true,
                projectId: true,
                estimate: { select: { projectId: true } },
            },
        });
        assertExpenseMutableOutsideQbo(expense);
        if (!expense) return NextResponse.json({ error: "Expense not found" }, { status: 404 });
        const body = await req.json();

        if (body.itemId) {
            const itemExists = await prisma.estimateItem.findUnique({ where: { id: body.itemId }, select: { id: true } });
            if (!itemExists) {
                return NextResponse.json({ error: "This cost code is unsaved. Please click 'Save' on the Estimate first before moving an expense to it." }, { status: 400 });
            }
        }

        // Phase 3 (spec §3.7): an edit here is a HUMAN re-coding the expense,
        // so it takes the highest precedence and no automated pass may touch it
        // again. `costCodeSource` is never read off the body — a client cannot
        // assert its own provenance — it is derived from the fact that a person
        // used this endpoint. The key is only acted on when it is present, so
        // existing callers that send {amount, vendor, date, ...} are unchanged.
        const editsCostCode = Object.prototype.hasOwnProperty.call(body, "costCodeId");
        const nextCostCodeId: string | null =
            typeof body.costCodeId === "string" && body.costCodeId.trim() ? body.costCodeId.trim() : null;
        const resolvedProjectId = resolveExpenseProjectId(expense);
        if (editsCostCode && nextCostCodeId) {
            // BOTH checks, per the SCOPE note on resolveCostCode: existence and
            // active-ness are ATTRIBUTION, "this code belongs to this job" is
            // PERMISSION, and neither implies the other. Validating only the
            // former let a human move an expense onto a phase from an entirely
            // different job.
            const resolved = await resolveCostCode(prismaCostCodingDataSource, {
                costCodeId: nextCostCodeId,
            });
            if (!resolved.ok) {
                return NextResponse.json(
                    { error: resolved.error, code: resolved.code },
                    { status: resolved.status },
                );
            }
            if (!resolvedProjectId) {
                return NextResponse.json(
                    {
                        error: "This expense isn't attached to a project, so a phase can't be validated against one.",
                        code: "PHASE_NOT_ON_PROJECT",
                    },
                    { status: 400 },
                );
            }
            const allowed = await isCostCodeAllowedForProject(
                prismaPhaseDataSource,
                resolvedProjectId,
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
        }

        // ── the tax-deduction correction path (Phase 3, §7) ─────────────────
        //
        // Nothing defaults `installedAtCustomer` any more, so this route is how
        // an unreviewed receipt becomes a claimable one. It is the ONLY place a
        // human answer can be recorded after capture, which is why it validates
        // rather than trusts: a deduction base larger than the pre-tax total is
        // a filing error, and it must be refused at the write rather than
        // clamped later where nobody would see it.
        const editsInstalled = Object.prototype.hasOwnProperty.call(body, "installedAtCustomer");
        let nextInstalled: boolean | null = null;
        if (editsInstalled) {
            const raw = body.installedAtCustomer;
            if (raw !== null && typeof raw !== "boolean") {
                return NextResponse.json(
                    { error: "installedAtCustomer must be true, false, or null." },
                    { status: 400 },
                );
            }
            nextInstalled = raw;
        }

        const editsBase = Object.prototype.hasOwnProperty.call(body, "taxDeductibleBase");
        let nextBase: number | null = null;
        if (editsBase && body.taxDeductibleBase !== null) {
            const parsed = Number(body.taxDeductibleBase);
            if (!Number.isFinite(parsed) || parsed < 0) {
                return NextResponse.json(
                    { error: "taxDeductibleBase must be a number ≥ 0, or null." },
                    { status: 400 },
                );
            }
            // Validated against the amount this request LEAVES on the row, not
            // the one it started with — a PUT that lowers the amount and sets a
            // base in the same call must not be able to slip past by being
            // checked against the old, larger figure.
            const nextAmount =
                body.amount !== undefined && body.amount !== null
                    ? Number(body.amount)
                    : Number(expense.amount);
            const tax = Number(expense.taxAmount ?? 0);
            const ceiling = Math.round((nextAmount - tax) * 100) / 100;
            if (!Number.isFinite(ceiling) || parsed > ceiling) {
                return NextResponse.json(
                    {
                        error: `The deduction base can't exceed the pre-tax receipt total (${ceiling.toFixed(2)}).`,
                    },
                    { status: 400 },
                );
            }
            nextBase = parsed;
        }

        const updatedExpense = await prisma.expense.update({
            where: { id },
            data: {
                amount: body.amount ? parseFloat(body.amount) : undefined,
                vendor: body.vendor || null,
                date: body.date ? new Date(body.date) : null,
                description: body.description || null,
                itemId: body.itemId || null,
                ...(editsCostCode
                    ? {
                        costCodeId: nextCostCodeId,
                        // Clearing the code clears the provenance with it —
                        // leaving "manual" on a null code would guard a row
                        // that has nothing to guard.
                        costCodeSource: nextCostCodeId ? "manual" : null,
                        costCodeConfidence: null,
                    }
                    : {}),
                ...(editsInstalled ? { installedAtCustomer: nextInstalled } : {}),
                ...(editsBase ? { taxDeductibleBase: nextBase } : {}),
            },
        });

        return NextResponse.json(updatedExpense);
    } catch (error) {
        if (error instanceof QboManagedExpenseError) {
            return NextResponse.json({ error: error.message }, { status: 409 });
        }
        console.error("Error updating expense:", error);
        return NextResponse.json({ error: "Failed to update expense" }, { status: 500 });
    }
}
