import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { canAccessProject, getCurrentUserWithPermissions, hasPermission } from "@/lib/permissions";
import {
    QboManagedExpenseError,
    assertExpenseMutableOutsideQbo,
} from "@/lib/qbo-expense-guard";
import { resolveExpenseProjectId } from "@/lib/expense-attribution";
import { lockExpense } from "@/lib/expense-lock";
import { resolveCostCode } from "@/lib/cost-coding";
import { prismaCostCodingDataSource } from "@/lib/cost-coding-db";
import { isCostCodeAllowedForProject } from "@/lib/project-phases";
import { prismaPhaseDataSource } from "@/lib/project-phases-db";
import { dateOnlyInTimeZone, resolveCompanyTimeZone } from "@/lib/company-timezone";

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
        // Same gate as PUT. Deleting somebody's expense is at least as
        // consequential as editing it, and this checked only that SOMEBODY was
        // signed in — so any authenticated user with an id could destroy any
        // non-QBO expense on any job.
        const user = await getCurrentUserWithPermissions();
        if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        if (!hasPermission(user, "timeClock")) {
            return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }

        const id = (await params).id;
        if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

        const expense = await prisma.expense.findUnique({
            where: { id },
            select: {
                qbPurchaseId: true,
                projectId: true,
                estimate: { select: { projectId: true } },
            },
        });
        assertExpenseMutableOutsideQbo(expense);
        if (!expense) return NextResponse.json({ error: "Expense not found" }, { status: 404 });

        // Fail CLOSED: with no resolvable project there is no scope to
        // authorize against, so nobody may delete it here.
        const projectId = resolveExpenseProjectId(expense);
        if (!projectId || !canAccessProject(user, projectId)) {
            return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }

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
        // AUTHORIZATION, not merely authentication. This route checked only
        // that SOMEBODY was signed in, so any authenticated user who knew an
        // expense id could rewrite it — and once it started accepting
        // `installedAtCustomer` and `taxDeductibleBase`, that meant editing the
        // numbers on a state excise return. The POST on this resource has
        // always resolved the project and checked access; the PUT now does the
        // same, plus the `timeClock` permission that /projects/[id]/time-expenses
        // and deleteExpenses already require to touch an expense at all.
        const user = await getCurrentUserWithPermissions();
        if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        if (!hasPermission(user, "timeClock")) {
            return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }

        const id = (await params).id;
        if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

        const expense = await prisma.expense.findUnique({
            where: { id },
            select: {
                qbPurchaseId: true,
                amount: true,
                taxAmount: true,
                taxDeductibleBase: true,
                estimateId: true,
                projectId: true,
                estimate: { select: { projectId: true } },
            },
        });
        assertExpenseMutableOutsideQbo(expense);
        if (!expense) return NextResponse.json({ error: "Expense not found" }, { status: 404 });

        // Fail CLOSED on an unattributable row: with no project there is no
        // scope to authorize against, so nobody may edit it here.
        const resolvedProjectId = resolveExpenseProjectId(expense);
        if (!resolvedProjectId || !canAccessProject(user, resolvedProjectId)) {
            return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }

        const body = await req.json();

        // An item link must belong to THIS expense's RESOLVED job. Checking
        // only that the id exists let an edit point the expense at a line item
        // on another project, which then feeds the item->costCode fallback and
        // silently books the phase of a different job.
        //
        // The `estimateId` escape hatch is gone: for a RE-ATTRIBUTED expense
        // the estimate belongs to the job it left, so that branch admitted
        // exactly the cross-job link the check exists to stop. The resolved
        // project is the only authority.
        if (body.itemId) {
            const itemExists = await prisma.estimateItem.findFirst({
                where: {
                    id: body.itemId,
                    estimate: { projectId: resolvedProjectId },
                },
                select: { id: true },
            });
            if (!itemExists) {
                return NextResponse.json({ error: "That line item isn't on this project's estimates. Save the Estimate on the web first, or pick a line item from this job." }, { status: 400 });
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

        // STRICT ALLOWLIST. Every tax-return field is refused here BY NAME —
        // PATCH is their single writer, because this handler's QBO-mutability
        // guard excludes exactly the pipeline rows the tax report is made of.
        //
        // Refused rather than ignored: a silent drop looks like a successful
        // correction, and the caller would believe a deduction was recorded
        // that never was. `needsTaxReview` is in the list too — it is a
        // lifecycle flag the server owns, and no client may clear it without
        // supplying the answer that justifies clearing it.
        const TAX_FIELDS_OWNED_BY_PATCH = [
            "taxAmount",
            "taxAtSource",
            "needsTaxReview",
            "installedAtCustomer",
            "taxDeductibleBase",
        ];
        for (const field of TAX_FIELDS_OWNED_BY_PATCH) {
            if (Object.prototype.hasOwnProperty.call(body, field)) {
                return NextResponse.json(
                    {
                        error: `${field} can't be edited here. Use PATCH on this expense.`,
                        field,
                    },
                    { status: 400 },
                );
            }
        }

        // ...but this route CAN change `amount`, and the deduction invariant is
        // about the RESULTING ROW rather than about the fields this request
        // names. A PUT that merely LOWERS the amount can strand an existing
        // base above the new pre-tax total — the same impossible state reached
        // through the other door.
        const resultingAmount =
            body.amount !== undefined && body.amount !== null
                ? Number(body.amount)
                : Number(expense.amount);
        const existingBase =
            expense.taxDeductibleBase === null ? null : Number(expense.taxDeductibleBase);
        if (existingBase !== null) {
            const ceiling =
                Math.round((resultingAmount - Number(expense.taxAmount ?? 0)) * 100) / 100;
            if (!Number.isFinite(ceiling) || existingBase > ceiling) {
                return NextResponse.json(
                    {
                        error: `This amount would leave a deduction base of ${existingBase.toFixed(2)} above the pre-tax total (${ceiling.toFixed(2)}). Clear or lower the deduction base first.`,
                    },
                    { status: 400 },
                );
            }
        }


        // PARTIAL UPDATE. This used to write `body.vendor || null` and friends
        // unconditionally, so any request that did not resend every field wiped
        // the ones it left out — a tax-only edit erased the vendor, the date
        // and the description. `undefined` tells Prisma "leave it alone";
        // an explicitly-sent null still clears the field.
        const has = (key: string) => Object.prototype.hasOwnProperty.call(body, key);
        const updatedExpense = await prisma.expense.update({
            where: { id },
            data: {
                amount: body.amount ? parseFloat(body.amount) : undefined,
                vendor: has("vendor") ? (body.vendor || null) : undefined,
                // Same company-calendar-day rule as the POST — see there.
                date: has("date") ? (body.date ? await expenseDate(body.date) : null) : undefined,
                description: has("description") ? (body.description || null) : undefined,
                itemId: has("itemId") ? (body.itemId || null) : undefined,
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

/**
 * The TAX-CORRECTION path (Codex round 4, item 3).
 *
 * Split out from PUT because PUT cannot serve it. PUT is guarded by
 * `assertExpenseMutableOutsideQbo`, and every expense the receipt pipeline
 * creates carries a `qbPurchaseId` — which is precisely the population the tax
 * report reads. The correction path therefore could not reach a single row it
 * was built for.
 *
 * The guard is right for PUT and wrong here, and the reason is what these
 * columns ARE: `installedAtCustomer`, `taxDeductibleBase`, `taxAmount`,
 * `taxAtSource` and `costCodeId` are ProBuild-only bookkeeping. Nothing syncs
 * them to QuickBooks and nothing in QuickBooks overwrites them, so editing them
 * cannot desynchronise a Purchase. `amount`, `vendor` and `date` would, which is
 * why they are not accepted here at ANY status.
 *
 * `taxAmount`/`taxAtSource` are here because booking now persists ONLY the tax
 * `buildGroups` accepted — a check, or a nonsense `tax >= total`, lands with no
 * tax at all. That is the right default (an unvalidated OCR read must not reach
 * a filing), but it is only half an answer unless a human can supply the real
 * figure afterwards. This is that path.
 */
/**
 * `Expense.date` is a COMPANY CALENDAR DAY. A bare YYYY-MM-DD goes through the
 * shared parser so it lands at local noon; anything else is already an instant.
 */
async function expenseDate(value: unknown): Promise<Date> {
    if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return dateOnlyInTimeZone(value, await resolveCompanyTimeZone());
    }
    return new Date(value as string);
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
        const user = await getCurrentUserWithPermissions();
        if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        const id = (await params).id;
        if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

        const expense = await prisma.expense.findUnique({
            where: { id },
            select: {
                amount: true,
                taxAmount: true,
                taxAtSource: true,
                taxDeductibleBase: true,
                estimateId: true,
                projectId: true,
                updatedAt: true,
                estimate: { select: { projectId: true } },
            },
        });
        if (!expense) return NextResponse.json({ error: "Expense not found" }, { status: 404 });

        const projectId = resolveExpenseProjectId(expense);
        if (!projectId || !canAccessProject(user, projectId)) {
            return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }

        const body = await req.json();
        const has = (key: string) => Object.prototype.hasOwnProperty.call(body, key);

        // Nothing outside the three ProBuild-only columns. A caller that sends
        // `amount` here is either confused or probing; either way it must be
        // told, not silently ignored.
        const allowed = new Set([
            "installedAtCustomer", "taxDeductibleBase", "taxAmount", "taxAtSource", "costCodeId",
        ]);
        const rejected = Object.keys(body).filter(key => !allowed.has(key));
        if (rejected.length) {
            return NextResponse.json(
                { error: `This endpoint only edits ${[...allowed].join(", ")}. Rejected: ${rejected.join(", ")}.` },
                { status: 400 },
            );
        }
        if (!rejected.length && Object.keys(body).length === 0) {
            return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
        }

        const editsInstalled = has("installedAtCustomer");
        const editsBase = has("taxDeductibleBase");
        const editsTaxAmount = has("taxAmount");
        const editsTaxAtSource = has("taxAtSource");
        const editsCostCode = has("costCodeId");

        // The money permission governs anything that lands on a tax return.
        if ((editsInstalled || editsBase || editsTaxAmount || editsTaxAtSource)
            && !hasPermission(user, "financialReports")) {
            return NextResponse.json(
                { error: "Editing tax-deduction fields requires the Financial Reports permission." },
                { status: 403 },
            );
        }
        if (editsCostCode && !hasPermission(user, "timeClock")) {
            return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }

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

        // A CORRECTED TAX FIGURE, bounded by plausibility. WA's combined rate
        // tops out around 10.6%; 12% is deliberately loose so a legitimate
        // receipt is never refused, while a transposed OCR read (a $207 receipt
        // "with" $207 of tax) still cannot reach a filing. Zero is allowed —
        // "this receipt had no tax" is an answer a human is entitled to give.
        const MAX_TAX_RATE = 0.12;
        let nextTaxAmount: number | null = null;
        if (editsTaxAmount && body.taxAmount !== null) {
            const parsed = Number(body.taxAmount);
            if (!Number.isFinite(parsed) || parsed < 0) {
                return NextResponse.json(
                    { error: "taxAmount must be a number >= 0, or null." },
                    { status: 400 },
                );
            }
            const ceiling = Math.round(Number(expense.amount) * MAX_TAX_RATE * 100) / 100;
            if (parsed > ceiling) {
                return NextResponse.json(
                    { error: `That tax is implausible for a ${Number(expense.amount).toFixed(2)} receipt (max ${ceiling.toFixed(2)}, 12%).` },
                    { status: 400 },
                );
            }
            nextTaxAmount = parsed;
        }

        let nextTaxAtSource: boolean | null = null;
        if (editsTaxAtSource) {
            if (typeof body.taxAtSource !== "boolean") {
                return NextResponse.json(
                    { error: "taxAtSource must be true or false." },
                    { status: 400 },
                );
            }
            nextTaxAtSource = body.taxAtSource;
        }

        let nextBase: number | null = null;
        if (editsBase && body.taxDeductibleBase !== null) {
            const parsed = Number(body.taxDeductibleBase);
            if (!Number.isFinite(parsed) || parsed < 0) {
                return NextResponse.json(
                    { error: "taxDeductibleBase must be a number ≥ 0, or null." },
                    { status: 400 },
                );
            }
            nextBase = parsed;
        }

        // The invariant is about the ROW THIS REQUEST LEAVES BEHIND — which
        // now includes a tax figure this same request may be changing. Raising
        // the tax lowers the ceiling, so an untouched base can be invalidated
        // by a tax-only edit.
        const resultingBase = editsBase
            ? nextBase
            : (expense.taxDeductibleBase === null ? null : Number(expense.taxDeductibleBase));
        const resultingTax = editsTaxAmount
            ? (nextTaxAmount ?? 0)
            : Number(expense.taxAmount ?? 0);
        if (resultingBase !== null) {
            const ceiling = Math.round((Number(expense.amount) - resultingTax) * 100) / 100;
            if (!Number.isFinite(ceiling) || resultingBase > ceiling) {
                return NextResponse.json(
                    { error: `The deduction base can't exceed the pre-tax receipt total (${ceiling.toFixed(2)}).` },
                    { status: 400 },
                );
            }
        }

        // `taxAtSource` asserts "tax was charged on this receipt"; with no tax
        // figure behind it, it is a claim about nothing and the report filters
        // it out anyway. Refuse the incoherent pair rather than storing it.
        const resultingAtSource = editsTaxAtSource
            ? (nextTaxAtSource as boolean)
            : Boolean(expense.taxAtSource);
        if (resultingAtSource && resultingTax <= 0) {
            return NextResponse.json(
                { error: "taxAtSource can't be true with no tax amount on the receipt." },
                { status: 400 },
            );
        }

        let nextCostCodeId: string | null = null;
        if (editsCostCode) {
            nextCostCodeId =
                typeof body.costCodeId === "string" && body.costCodeId.trim()
                    ? body.costCodeId.trim()
                    : null;
            if (nextCostCodeId) {
                const resolved = await resolveCostCode(prismaCostCodingDataSource, {
                    costCodeId: nextCostCodeId,
                });
                if (!resolved.ok) {
                    return NextResponse.json(
                        { error: resolved.error, code: resolved.code },
                        { status: resolved.status },
                    );
                }
                const onProject = await isCostCodeAllowedForProject(
                    prismaPhaseDataSource,
                    projectId,
                    resolved.costCodeId,
                );
                if (!onProject) {
                    return NextResponse.json(
                        { error: "That cost code isn't one of this project's phases.", code: "PHASE_NOT_ON_PROJECT" },
                        { status: 400 },
                    );
                }
                nextCostCodeId = resolved.costCodeId;
            }
        }

        // COMPARE-AND-SET on the VALUES the decision rested on.
        //
        // Everything above was validated against the row as it was READ: the
        // ceiling for `taxDeductibleBase` is `amount - taxAmount`, and a QBO
        // re-sync can move either between that read and this write. Writing
        // anyway would store a figure that was legal a moment ago and is not
        // now — which the database CHECK then refuses (aborting the request) or
        // which slips through as an overstated deduction.
        //
        // The predicate names those inputs rather than a row version, so it
        // fails ONLY when something the answer depended on actually moved; an
        // unrelated edit does not force the bookkeeper to redo their work.
        //
        // Zero rows means it moved: 409, and the caller re-reads. No automatic
        // retry — a human decided against numbers that have since changed, so
        // the ANSWER may be wrong now, not just the write.
        const casWhere = {
            id,
            amount: expense.amount,
            taxAmount: expense.taxAmount,
            taxDeductibleBase: expense.taxDeductibleBase,
            // THE ATTRIBUTION THE AUTHORIZATION RESTED ON. Access to this row
            // was granted because of the project it was on; if it has since
            // been re-attributed, the permission check that let this request
            // through was answered about a different job. `updatedAt` catches
            // everything else that moved.
            projectId: expense.projectId,
            estimateId: expense.estimateId,
            updatedAt: expense.updatedAt,
        };
        const data = {
                ...(editsInstalled ? { installedAtCustomer: nextInstalled } : {}),
                ...(editsBase ? { taxDeductibleBase: nextBase } : {}),
                ...(editsTaxAmount ? { taxAmount: nextTaxAmount } : {}),
                ...(editsTaxAtSource ? { taxAtSource: nextTaxAtSource as boolean } : {}),
                // A human just answered, so the row is no longer awaiting one.
                // Cleared in the SAME write as the answer: two statements would
                // leave a window where the report sees an answered row it still
                // refuses to count.
                ...(editsInstalled || editsBase || editsTaxAmount || editsTaxAtSource
                    ? { needsTaxReview: false }
                    : {}),
                ...(editsCostCode
                    ? {
                        costCodeId: nextCostCodeId,
                        costCodeSource: nextCostCodeId ? "manual" : null,
                        costCodeConfidence: null,
                    }
                    : {}),
        };
        // The write runs under the shared per-expense lock, so this request is
        // ordered against the QBO sync and the booking fill rather than merely
        // racing them. The CAS stays inside it: the lock orders the writers
        // that TAKE it, the predicate is what still protects against one that
        // does not.
        const written = await prisma.$transaction(async tx => {
            await lockExpense(tx as unknown as { $queryRawUnsafe(q: string, ...v: unknown[]): Promise<unknown> }, id);
            return tx.expense.updateMany({ where: casWhere, data });
        });
        if (written.count === 0) {
            return NextResponse.json(
                {
                    error: "This expense changed while you were editing it. Reopen it and check the figures before saving.",
                    code: "STALE_EXPENSE",
                },
                { status: 409 },
            );
        }

        const updated = await prisma.expense.findUnique({ where: { id } });
        return NextResponse.json(updated);
    } catch (error) {
        console.error("Error correcting expense:", error);
        return NextResponse.json({ error: "Failed to update expense" }, { status: 500 });
    }
}
