import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { canAccessProject, getCurrentUserWithPermissions, hasPermission } from "@/lib/permissions";
import {
    QboManagedExpenseError,
    assertExpenseMutableOutsideQbo,
} from "@/lib/qbo-expense-guard";
import {
    expenseStillOnProjectWhere,
    isPlausibleReceiptTax,
    itemBelongsToProjectTx,
    maxPlausibleTaxAmount,
    resolveExpenseProjectId,
    resolveExpenseProjectUnderLock,
    taxIsAtSource,
} from "@/lib/expense-attribution";
import { lockExpense } from "@/lib/expense-lock";
import { resolveCostCode } from "@/lib/cost-coding";
import { prismaCostCodingDataSource } from "@/lib/cost-coding-db";
import { isCostCodeAllowedForProject } from "@/lib/project-phases";
import { assertPhaseOfProjectTx } from "@/lib/phase-invariant";
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
                estimateId: true,
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

        // AND AGAIN, UNDER LOCK, FOR A FALLBACK-ATTRIBUTED ROW (round 19, item 3).
        //
        // A row with no `projectId` answers through its estimate, and somebody
        // can move that estimate to another job between the check above and
        // this delete. The row would then be destroyed under a permission that
        // was granted for a job it is no longer on.
        const removed = await prisma.$transaction(async tx => {
            const locked = await resolveExpenseProjectUnderLock(
                tx as unknown as { $queryRawUnsafe(q: string, ...v: unknown[]): Promise<unknown> },
                expense,
            );
            if (!locked || !canAccessProject(user, locked)) return { count: 0, denied: true } as const;
            const result = await tx.expense.deleteMany({
                where: {
                    id,
                    qbPurchaseId: null,
                    // The predicate carries the answer, so a row that moved in
                    // the gap matches nothing rather than being deleted.
                    ...expenseStillOnProjectWhere(expense, locked),
                },
            });
            return { count: result.count, denied: false } as const;
        });
        if (removed.denied) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        if (removed.count === 0) {
            // The row moved (or a QBO id appeared) between the read and the
            // delete. Reporting success would tell the caller their row is gone
            // when it is not.
            return NextResponse.json(
                {
                    error: "This expense changed while you were deleting it. Reopen it and try again.",
                    code: "EXPENSE_REATTRIBUTED",
                },
                { status: 409 },
            );
        }

        return NextResponse.json({ success: true, deleted: removed.count });
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
        //
        // This one is the FAST FAIL, and it holds nothing: `resolvedProjectId`
        // is a pre-transaction read. The answer that counts is re-asked under
        // the same lock as the write (`itemBelongsToProjectTx`, below).
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
            // Provenance for the four above. Accepting it here would let a
            // caller stamp "manual" on a row nobody answered, which is the one
            // value booking treats as untouchable.
            "taxSource",
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
        // ONE PARSE, one value, used by BOTH the check below and the write.
        //
        // This used to validate `Number(body.amount)` and then persist
        // `parseFloat(body.amount)`, which are different functions: "10junk"
        // validates as NaN (silently passing every check that is not a
        // comparison) and PERSISTS as 10. And `body.amount ? ...` dropped a
        // legitimate 0 on the floor, so a receipt could never be zeroed.
        const hasAmount = Object.prototype.hasOwnProperty.call(body, "amount");
        let nextAmount: number | undefined;
        if (hasAmount && body.amount !== null && body.amount !== undefined && body.amount !== "") {
            const raw =
                typeof body.amount === "number"
                    ? body.amount
                    : Number(String(body.amount).trim());
            if (!Number.isFinite(raw) || raw < 0) {
                return NextResponse.json(
                    { error: "Amount must be a number of dollars, zero or more.", field: "amount" },
                    { status: 400 },
                );
            }
            nextAmount = raw;
        }
        const resultingAmount = nextAmount ?? Number(expense.amount);
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
        // THE PHASE ANSWER THAT COUNTS, taken with the write (round 18, item 4).
        // Same reason as the POST and the PATCH: the check above holds nothing,
        // and this route stamps "manual", which no automated pass may correct.
        const legacyWrite = await prisma.$transaction(async tx => {
            // The same locked re-resolve as the DELETE: this route stamps
            // "manual" and rewrites the amount, and a fallback-attributed row
            // can change jobs between the authorization above and this write.
            const lockedProjectId = await resolveExpenseProjectUnderLock(
                tx as unknown as { $queryRawUnsafe(q: string, ...v: unknown[]): Promise<unknown> },
                expense,
            );
            if (!lockedProjectId || !canAccessProject(user, lockedProjectId)) {
                return { expense: null, phaseRejected: null, denied: "forbidden" } as const;
            }
            // BOTH RE-CHECKS ANSWER ABOUT `lockedProjectId` (round 21, item 2).
            //
            // They used to be asked about `resolveExpenseProjectId(expense)` —
            // the value read BEFORE the transaction, which is the one thing the
            // locked re-resolve exists to distrust. A fallback-attributed row
            // whose estimate moved would have its phase validated against the
            // job it left and its item link validated against that job's
            // estimates, then written onto the job it joined.
            if (editsCostCode && nextCostCodeId) {
                const verdict = await assertPhaseOfProjectTx(
                    tx as unknown as { $queryRawUnsafe(q: string, ...v: unknown[]): Promise<unknown> },
                    lockedProjectId,
                    nextCostCodeId,
                );
                if (!verdict.ok) {
                    return { expense: null, phaseRejected: verdict.reason, denied: null } as const;
                }
            }
            if (body.itemId) {
                const onThisJob = await itemBelongsToProjectTx(
                    tx as unknown as { $queryRawUnsafe(q: string, ...v: unknown[]): Promise<unknown> },
                    body.itemId,
                    lockedProjectId,
                );
                if (!onThisJob) {
                    return { expense: null, phaseRejected: null, denied: "item" } as const;
                }
            }
            const written = await tx.expense.updateMany({
            where: { id, ...expenseStillOnProjectWhere(expense, lockedProjectId) },
            data: {
                amount: nextAmount,
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
            if (written.count === 0) {
                return { expense: null, phaseRejected: null, denied: "moved" } as const;
            }
            const updated = await tx.expense.findUnique({ where: { id } });
            return { expense: updated, phaseRejected: null, denied: null } as const;
        });
        if (legacyWrite.denied === "forbidden") {
            return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }
        if (legacyWrite.denied === "item") {
            return NextResponse.json(
                { error: "That line item isn't on this project's estimates. Save the Estimate on the web first, or pick a line item from this job." },
                { status: 400 },
            );
        }
        if (legacyWrite.denied) {
            return NextResponse.json(
                {
                    error: "This expense moved to another job while you were editing it.",
                    code: "EXPENSE_REATTRIBUTED",
                },
                { status: 409 },
            );
        }
        if (legacyWrite.phaseRejected) {
            return NextResponse.json(
                {
                    error: "That cost code stopped being one of this project's phases.",
                    code: "PHASE_NOT_ON_PROJECT",
                    reason: legacyWrite.phaseRejected,
                },
                { status: 400 },
            );
        }

        return NextResponse.json(legacyWrite.expense);
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
                // Whether this row is WAITING for a person. It decides what it
                // takes to clear the flag below.
                needsTaxReview: true,
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
            "installedAtCustomer", "taxDeductibleBase", "taxAmount", "costCodeId",
            // Not a column: which of the two things a NULL taxAmount means.
            // `taxKnown: false` is "I do not know what the tax was", which is
            // the state the pipeline starts in; `taxKnown: true` alongside a
            // null amount is "I looked, and there is none". See below.
            "taxKnown",
            // Not a column either: the explicit "I have re-checked this flagged
            // row" acknowledgement. See the needsTaxReview rule below.
            "taxReviewAck",
        ]);


        // `taxAtSource` IS DERIVED, NEVER SUPPLIED (round 20, item 1).
        //
        // It is not an independent fact: "tax was charged on this receipt" is
        // true exactly when there is a tax figure on the row. Accepting it from
        // a client meant two writers for one truth, and every combination they
        // could disagree in — `taxAtSource: true` with no amount (a claim about
        // nothing, which the report would have counted had the amount ever
        // arrived) and `taxAtSource: false` with $16.55 of tax (a deduction
        // silently dropped from the filing).
        //
        // Refused rather than ignored: a caller that sends it believes it is
        // setting something, and a silent drop looks like agreement.
        if (has("taxAtSource")) {
            return NextResponse.json(
                {
                    error: "taxAtSource is derived from taxAmount and cannot be set directly.",
                    code: "TAX_AT_SOURCE_DERIVED",
                },
                { status: 400 },
            );
        }

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
        const editsCostCode = has("costCodeId");

        // CLEARING A REVIEW FLAG IS ITS OWN DECISION.
        //
        // `needsTaxReview` means a re-sync moved the gross out from under a
        // classification a human made, so the whole classification is in doubt
        // — not just whichever field the next request happens to touch. Letting
        // any tax edit clear it meant a bookkeeper answering "yes, installed at
        // customer" silently certified a tax amount and a deduction split they
        // never looked at, and the row went straight back into the excise
        // report.
        //
        // So clearing it takes an explicit acknowledgement AND the two figures
        // the report actually reads. `installedAtCustomer` is optional: it is
        // the one field whose absence cannot overstate a deduction (a null
        // reads as "unanswered" and the report skips the row).
        //
        // A tax edit WITHOUT the ack is still accepted — a partial correction
        // is normal work — it simply leaves the flag standing.
        if (has("taxReviewAck") && body.taxReviewAck !== true && body.taxReviewAck !== false) {
            return NextResponse.json(
                { error: "taxReviewAck must be true or false." },
                { status: 400 },
            );
        }
        // AN ACKNOWLEDGEMENT MUST SAY WHAT WAS DECIDED.
        //
        // Clearing the flag says "I have re-checked this receipt", and there
        // are exactly two answers a person can have re-checked TO:
        //
        //   * a figure — `taxAmount` a coherent number, or
        //   * "there is no sales tax on this receipt" — `taxAmount` an explicit
        //     null, which is a decision and is recorded as `manual-none`.
        //
        // What is NOT an answer is omitting the key: that request says nothing
        // about tax at all, so there is nothing to certify and the flag stands.
        // A blank `taxDeductibleBase` is fine either way — the server computes
        // and stores the whole pre-tax total below rather than leaving a null
        // whose meaning has to be remembered by every reader.
        // A NULL TAX AMOUNT IS TWO DIFFERENT ANSWERS, and the payload has to
        // say which (round 19, item 2):
        //
        //   * `{ taxAmount: null, taxKnown: false }` — "I do not know what the
        //     tax on this receipt was". That is where the row already is, so it
        //     changes no provenance, keeps any review flag up, and CANNOT
        //     acknowledge a review: there is nothing to certify.
        //   * `{ taxAmount: null, taxKnown: true }` — "I looked; there is no
        //     sales tax on this receipt". A decision, recorded as
        //     `manual-none`, and a complete answer to a review.
        //
        // `taxKnown` defaults to TRUE when the key is absent, because the only
        // caller that sends a bare `taxAmount: null` today is a bookkeeper
        // clearing a figure — and the modal now always says which it means.
        if (has("taxKnown") && typeof body.taxKnown !== "boolean") {
            return NextResponse.json(
                { error: "taxKnown must be true or false." },
                { status: 400 },
            );
        }
        const taxIsUnknown = editsTaxAmount && body.taxAmount === null && body.taxKnown === false;

        const acknowledgesReview = body.taxReviewAck === true;
        if (acknowledgesReview) {
            const gross = Number(expense.amount);
            // STRICT TYPE, not `Number(value)`. After JSON parsing, a real
            // figure is `typeof "number"` — `Number(false)`, `Number("")`,
            // and `Number([])` are all `0` too, and none of those is a
            // person answering the review with zero tax.
            const coherent = (value: unknown) => {
                if (typeof value !== "number") return false;
                return (
                    Number.isFinite(value) &&
                    (value === 0 || Math.sign(value) === Math.sign(gross)) &&
                    Math.abs(value) <= Math.abs(gross)
                );
            };
            // "I do not know" is not an answer to a review, and clearing the
            // flag on it would put an unpriced row back into the excise report.
            if (taxIsUnknown) {
                return NextResponse.json(
                    {
                        error: "This receipt is flagged for review, so \"tax unknown\" cannot clear it. Enter the tax, or say the receipt has none.",
                        code: "TAX_UNKNOWN",
                    },
                    { status: 400 },
                );
            }
            // BOTH KEYS, on a flagged row (round 19, item 1). The flag means
            // the whole classification is in doubt, and the two figures are the
            // whole classification — so certifying one while staying silent
            // about the other is exactly the half-answer the flag exists to
            // prevent. Each may be a coherent number or an explicit null.
            const bothPresent = expense.needsTaxReview ? editsTaxAmount && editsBase : editsTaxAmount;
            const answered =
                bothPresent &&
                (body.taxAmount === null || coherent(body.taxAmount)) &&
                (!editsBase || body.taxDeductibleBase === null || coherent(body.taxDeductibleBase));
            if (!answered) {
                return NextResponse.json(
                    {
                        error: expense.needsTaxReview
                            ? "Acknowledging a tax review needs both taxAmount and taxDeductibleBase in the same request — each a figure, or an explicit null."
                            : "Acknowledging a tax review needs taxAmount in the same request — a figure, or an explicit null meaning this receipt has no sales tax.",
                        code: "TAX_REVIEW_INCOMPLETE",
                    },
                    { status: 400 },
                );
            }
        }
        // An unflagged row has nothing to clear, so the ack is not required of
        // ordinary edits; a flagged one keeps its flag until it is given.
        const clearsReview =
            (!expense.needsTaxReview && !taxIsUnknown) || (acknowledgesReview && !taxIsUnknown);

        // WHICH OF THE FOUR STATES THIS REQUEST PUTS THE ROW IN.
        //
        // `taxSource` governs `taxAmount` and `taxDeductibleBase` (see
        // HUMAN_TAX_SOURCES in expense-attribution.ts):
        //
        //   * an explicit `taxAmount: null` is a person saying this receipt has
        //     NO sales tax -> "manual-none". Not an absence: it is the answer a
        //     null figure cannot express on its own, and booking must not write
        //     an OCR guess over it.
        //   * any other tax-figure edit -> "manual".
        //   * OMITTING both keys leaves the column alone, so a row nobody has
        //     spoken about stays open to an automated read.
        //
        // `installedAtCustomer` is NOT one of these — its own value is its
        // evidence (non-null means answered) and booking already refuses to
        // touch it once it is set.
        // "I DO NOT KNOW" IS A RETRACTION, not a no-op (round 20, item 2).
        //
        // It leaves no human answer standing: a row that said "manual" ($16.55)
        // or "manual-none" ("there is no tax") and is now marked unknown has to
        // come all the way back to null, or the pipeline stays locked out of a
        // receipt whose figures nobody is claiming any more — the row would sit
        // with a human provenance and no human answer behind it, and no
        // automated read would ever be allowed to fill it.
        //
        // So it clears the provenance AND both figures together.
        const stampsTaxProvenance = (editsTaxAmount || editsBase) && !taxIsUnknown;
        const nextTaxSource =
            editsTaxAmount && body.taxAmount === null ? "manual-none" : "manual";

        // `taxReviewAck` is not a column, so a request carrying nothing else
        // has no field to write. Told, not silently no-opped.
        if (!editsInstalled && !editsBase && !editsTaxAmount && !editsCostCode) {
            return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
        }

        // The money permission governs anything that lands on a tax return.
        if ((editsInstalled || editsBase || editsTaxAmount)
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

        // A CORRECTED TAX FIGURE, bounded by plausibility — the SHARED bound
        // (src/lib/expense-attribution.ts), because the booking pipeline judges
        // an OCR read against the same number. Zero is allowed: "this receipt
        // had no tax" is an answer a human is entitled to give.
        let nextTaxAmount: number | null = null;
        if (editsTaxAmount && body.taxAmount !== null) {
            // STRICT TYPE, not `Number(body.taxAmount)` — a certified tax
            // figure is not `Number(false)` or `Number("")` landing on 0.
            if (typeof body.taxAmount !== "number" || !Number.isFinite(body.taxAmount)) {
                return NextResponse.json(
                    { error: "taxAmount must be a finite number, or null." },
                    { status: 400 },
                );
            }
            const parsed = body.taxAmount;
            const gross = Number(expense.amount);
            const ceiling = maxPlausibleTaxAmount(gross);
            // A REFUND'S TAX IS NEGATIVE. The rule is direction and magnitude,
            // not positivity: a positive tax on a negative expense is a dropped
            // minus sign, and it would ADD to a filing that should be reduced.
            // Answered as a 400 with the reason, never as a constraint
            // violation surfacing as a 500.
            if (parsed !== 0 && Math.sign(parsed) !== Math.sign(gross)) {
                return NextResponse.json(
                    {
                        error: gross < 0
                            ? "This is a refund, so its tax must be negative too (or zero)."
                            : "Tax must be positive on a purchase (or zero).",
                        code: "TAX_SIGN_MISMATCH",
                    },
                    { status: 400 },
                );
            }
            if (!isPlausibleReceiptTax(parsed, gross)) {
                return NextResponse.json(
                    { error: `That tax is implausible for a ${gross.toFixed(2)} receipt (max ${ceiling.toFixed(2)} in magnitude, 12%).` },
                    { status: 400 },
                );
            }
            nextTaxAmount = parsed;
        }

        let nextBase: number | null = null;
        if (editsBase && body.taxDeductibleBase !== null) {
            // STRICT TYPE, not `Number(body.taxDeductibleBase)`: `Number(false)`
            // and `Number("")` are both `0`, and neither is a person entering a
            // deduction of zero.
            if (typeof body.taxDeductibleBase !== "number" || !Number.isFinite(body.taxDeductibleBase)) {
                return NextResponse.json(
                    { error: "taxDeductibleBase must be a finite number, or null." },
                    { status: 400 },
                );
            }
            const parsed = body.taxDeductibleBase;
            // Signed, like the amount it is a portion of: the resold part of a
            // -$50 return is negative too. A base pointing the other way is a
            // dropped minus sign, and it would ADD to a filing that should be
            // reduced.
            if (parsed !== 0 && Math.sign(parsed) !== Math.sign(Number(expense.amount))) {
                return NextResponse.json(
                    {
                        error: Number(expense.amount) < 0
                            ? "This is a refund, so its deductible amount must be negative too (or zero)."
                            : "The deductible amount must be positive on a purchase (or zero).",
                        code: "BASE_SIGN_MISMATCH",
                    },
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
        if (resultingBase !== null && resultingBase !== 0) {
            const ceiling = Math.round((Number(expense.amount) - resultingTax) * 100) / 100;
            // MAGNITUDE, because both sides are signed. On a refund the ceiling
            // is negative and `base > ceiling` would pass anything.
            if (
                !Number.isFinite(ceiling) ||
                Math.sign(resultingBase) !== Math.sign(ceiling) ||
                Math.abs(resultingBase) > Math.abs(ceiling)
            ) {
                return NextResponse.json(
                    { error: `The deduction base can't exceed the pre-tax receipt total (${ceiling.toFixed(2)}).` },
                    { status: 400 },
                );
            }
        }

        // The flag follows the figure, computed from the row this request
        // LEAVES BEHIND. Signed: a refund's tax is negative and the fact — tax
        // was charged, and is coming back — is just as true.
        const derivesAtSource = editsTaxAmount || taxIsUnknown;
        const resultingAtSource = derivesAtSource
            ? taxIsAtSource(nextTaxAmount)
            : Boolean(expense.taxAtSource);

        let nextCostCodeId: string | null = null;
        if (editsCostCode) {
            // STRICT TYPE. `has("costCodeId")` only proves the key is
            // present — the value can still be a number, boolean, array, or
            // object, and treating every one of those as "clear the cost
            // code" would silently strip a real attribution off a bad
            // request instead of rejecting it.
            if (body.costCodeId !== null && typeof body.costCodeId !== "string") {
                return NextResponse.json(
                    { error: "costCodeId must be a string, or null." },
                    { status: 400 },
                );
            }
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
                // A FIRST pass, outside the transaction, purely so the
                // caller gets a clean 400 instead of a rolled-back write. The
                // ANSWER THAT COUNTS is re-taken inside the transaction below,
                // where the rows it depends on are locked — this one can go
                // stale between here and the write and that is fine, because
                // nothing acts on it.
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
        // A BLANK DEDUCTION BASE IS NOT A NULL WITH A MEANING.
        //
        // "Null means the whole pre-tax total" is a rule every reader has to
        // remember, and the report is one of several. When a person edits the
        // tax figures and leaves the base blank, the server computes and stores
        // what they meant — `amount - tax` — so the row says it outright. The
        // legacy nulls stay readable; nothing new adds to them.
        const computedBase =
            stampsTaxProvenance &&
            (editsBase ? nextBase === null : resultingBase === null)
                ? Math.round((Number(expense.amount) - resultingTax) * 100) / 100
                : null;
        const writesBase = editsBase || computedBase !== null;

        const data = {
                ...(editsInstalled ? { installedAtCustomer: nextInstalled } : {}),
                ...(taxIsUnknown
                    // Both figures and the provenance, in one statement: a
                    // half-retracted row is exactly the shape this is fixing.
                    ? { taxDeductibleBase: null, taxSource: null }
                    : writesBase
                        ? { taxDeductibleBase: computedBase !== null ? computedBase : nextBase }
                        : {}),
                ...(editsTaxAmount ? { taxAmount: nextTaxAmount } : {}),
                ...(derivesAtSource ? { taxAtSource: resultingAtSource } : {}),
                // A human just answered, so the row is no longer awaiting one.
                // Cleared in the SAME write as the answer: two statements would
                // leave a window where the report sees an answered row it still
                // refuses to count.
                ...(editsInstalled || editsBase || editsTaxAmount
                    ? {
                        // Only when the answer that justifies clearing it came
                        // with the request. Written in the SAME statement as
                        // that answer: two statements would leave a window
                        // where the report sees a cleared row it has not been
                        // given the figures for.
                        ...(clearsReview ? { needsTaxReview: false } : {}),
                        // PROVENANCE IS PER DECISION, AND `taxSource` COVERS
                        // EXACTLY TWO COLUMNS: taxAmount and taxDeductibleBase.
                        //
                        // It is stamped only when this request actually carries
                        // one of those FIGURES. Two consequences, both
                        // deliberate:
                        //   * answering only the installed-at-customer question
                        //     does not claim a person supplied tax numbers, and
                        //   * clearing the tax back to blank leaves the
                        //     provenance alone, so a later OCR read may fill
                        //     it — a blank is an absence, not a decision, and
                        //     locking the column on an absence would freeze the
                        //     row out of the pipeline forever.
                        ...(stampsTaxProvenance ? { taxSource: nextTaxSource } : {}),
                    }
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
            const raw = tx as unknown as { $queryRawUnsafe(q: string, ...v: unknown[]): Promise<unknown> };
            await lockExpense(raw, id);
            // THE JOB, RE-RESOLVED UNDER LOCK (round 19, item 3). For a row
            // with no `projectId` of its own the answer lives on the estimate,
            // which somebody else can re-point while this request decides.
            const lockedProjectId = await resolveExpenseProjectUnderLock(raw, expense);
            if (!lockedProjectId || !canAccessProject(user, lockedProjectId)) {
                return { count: 0, phaseRejected: null, denied: "forbidden" } as const;
            }
            // THE PHASE ANSWER THAT COUNTS, taken here (round 17, item 5).
            //
            // The check above ran on the global client and held nothing: an
            // estimate archived or reassigned, or the code deactivated, between
            // it and this write would still be stamped onto the row. This one
            // locks the four tables the answer rests on and reads them on this
            // transaction's snapshot, so it cannot go stale before the update.
            if (editsCostCode && nextCostCodeId) {
                const verdict = await assertPhaseOfProjectTx(raw, lockedProjectId, nextCostCodeId);
                if (!verdict.ok) {
                    return { count: 0, phaseRejected: verdict.reason, denied: null } as const;
                }
            }
            const result = await tx.expense.updateMany({
                where: { ...casWhere, ...expenseStillOnProjectWhere(expense, lockedProjectId) },
                data,
            });
            return { count: result.count, phaseRejected: null, denied: null } as const;
        });
        // TWO different answers, deliberately. "You may not touch this job" is a
        // 403 about the ACTOR; a lost predicate is a 409 about the ROW, and the
        // client's remedy differs (ask for access vs. reopen and retry).
        if (written.denied === "forbidden") {
            return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }
        if (written.phaseRejected) {
            return NextResponse.json(
                {
                    error: "That cost code stopped being one of this project's phases while you were editing.",
                    code: "PHASE_NOT_ON_PROJECT",
                    reason: written.phaseRejected,
                },
                { status: 400 },
            );
        }
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
