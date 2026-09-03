import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { canAccessProject, getCurrentUserWithPermissions, hasPermission } from "@/lib/permissions";
import {
    assertExpenseMutableOutsideQbo,
    isQboManagedExpenseError,
} from "@/lib/qbo-expense-guard";
import {
    COST_CODE_ID_INVALID_MESSAGE,
    deductionCeiling,
    expenseStillOnProjectWhere,
    hasTaxClassification,
    parseCostCodeIdEdit,
    parseTaxReviewAck,
    TAX_REVIEW_ACK_MALFORMED_MESSAGE,
    taxReviewAckIsComplete,
    planTaxRevalidation,
    taxDeductibleBaseFits,
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
import { assertPhaseOfProjectTx, lockAttributionParents } from "@/lib/phase-invariant";
import { prismaPhaseDataSource } from "@/lib/project-phases-db";
import { CALENDAR_DATE_NOT_REAL, classifyCalendarDate, dateOnlyInTimeZone, resolveCompanyTimeZone } from "@/lib/company-timezone";

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
        if (isQboManagedExpenseError(error)) {
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

        // THE TAX-REVIEW ACKNOWLEDGEMENT, PARSED ONCE, ATOMICALLY
        // (round 39, item 1).
        //
        // This route may not write the tax columns, so an ack here cannot be
        // "the new figures" the way the PATCH's is. It is the opposite: a
        // statement that the figures ALREADY ON THE ROW were looked at against
        // the total this request is about to write. All four parts are
        // required and are compared under the lock, so a stale form or a
        // concurrent PATCH cannot be certified by accident — see the
        // `ackMatches` note below.
        //
        // Absent is the normal case and means "not reviewed", which flags.
        // Present-but-malformed is a client bug and is refused rather than
        // quietly ignored, because ignoring it would look exactly like a
        // successful certification to the caller.
        // ONE PARSER, shared with the PATCH (round 43, item 1). This route
        // needs the OBJECT form: it may not write the tax columns, so its ack
        // has to NAME the figures already on the row rather than replace them.
        // A bare boolean is the PATCH's form and means nothing here, because
        // there would be no figures beside it to certify.
        const parsedAck = parseTaxReviewAck(body);
        if (parsedAck.kind === "invalid" || parsedAck.kind === "flag") {
            return NextResponse.json(
                { error: TAX_REVIEW_ACK_MALFORMED_MESSAGE, code: "TAX_REVIEW_ACK_MALFORMED" },
                { status: 400 },
            );
        }
        const reviewAck = parsedAck.kind === "figures" ? parsedAck : null;
        /** Two nullable money figures, compared in whole cents. */
        const sameFigure = (a: number | null, b: number | null) =>
            a === null || b === null
                ? a === null && b === null
                : Math.round(a * 100) === Math.round(b * 100);

        // Phase 3 (spec §3.7): an edit here is a HUMAN re-coding the expense,
        // so it takes the highest precedence and no automated pass may touch it
        // again. `costCodeSource` is never read off the body — a client cannot
        // assert its own provenance — it is derived from the fact that a person
        // used this endpoint. The key is only acted on when it is present, so
        // existing callers that send {amount, vendor, date, ...} are unchanged.
        // THE SHARED PARSER, not a third reading of the same key (round 40,
        // item 3). This used to collapse EVERY non-string to `null` and then
        // write `costCodeId: null, costCodeSource: "manual-none"` — so a
        // malformed payload such as `{ costCodeId: { id: "cc-1" } }` did not
        // fail: it CLEARED the phase and stamped the clear as a person's
        // deliberate decision, which is exactly the provenance every automated
        // pass is forbidden to repair. A typo in a client became a permanent,
        // unrepairable loss of attribution.
        const costCodeEdit = parseCostCodeIdEdit(body);
        if (costCodeEdit.kind === "invalid") {
            return NextResponse.json(
                { error: COST_CODE_ID_INVALID_MESSAGE, field: "costCodeId" },
                { status: 400 },
            );
        }
        const editsCostCode = costCodeEdit.kind !== "untouched";
        const nextCostCodeId: string | null =
            costCodeEdit.kind === "set" ? costCodeEdit.costCodeId : null;
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
            // Provenance for the four above. Accepting either here would let
            // a caller stamp "manual" on a row nobody answered, which is the
            // one value booking treats as untouchable. Two columns, because
            // the tax figure and the deduction base are decided separately —
            // see the PATCH's provenance rules below.
            "taxSource",
            "taxDeductibleBaseSource",
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
            // MONEY HERE IS SIGNED (round 40, item 2). A refund or a vendor
            // credit is a NEGATIVE expense — the QBO sync says so in as many
            // words, both tax CHECK constraints are written for it, and the
            // PATCH's own sign rules exist to serve it. This route refused
            // every negative gross, so the one handler that can change a
            // receipt's total could not correct a credit at all: the amount
            // was the very thing it would not accept. Only NON-FINITE is
            // refused now.
            if (!Number.isFinite(raw)) {
                return NextResponse.json(
                    { error: "Amount must be a finite number of dollars.", field: "amount" },
                    { status: 400 },
                );
            }
            nextAmount = raw;
        }
        // THE DATE IS VALIDATED HERE, BEFORE ANY LOCK OR WRITE (round 47,
        // item 2). It used to be resolved inline in the `data:` payload deep
        // inside the write transaction, so a caller's typo — a well-shaped
        // impossible day like 2026-02-31, which is what a bad OCR read looks
        // like — threw out of the parser and came back as a 500.
        let nextDate: Date | null | undefined;
        try {
            nextDate = Object.prototype.hasOwnProperty.call(body, "date")
                ? (body.date ? await expenseDate(body.date) : null)
                : undefined;
        } catch (error) {
            if (error instanceof InvalidExpenseDateError) {
                return NextResponse.json({ error: error.message, date: error.value }, { status: 400 });
            }
            throw error;
        }
        const resultingAmount = nextAmount ?? Number(expense.amount);
        const existingBase =
            expense.taxDeductibleBase === null ? null : Number(expense.taxDeductibleBase);
        // THE FAST FAIL ASKS THE SAME QUESTION THE DATABASE DOES, SIGNED —
        // AND IT ASKS IT IN THE SAME ORDER (round 42, item 1).
        //
        // It used to compare `existingBase > ceiling`, unsigned. On a credit
        // that is backwards: a valid row (amount -50, tax -4, base -40) has
        // `-40 > -46` and was refused — so a request that merely edited the
        // VENDOR of a legitimate credit got a 400 naming a deduction base it
        // never mentioned.
        //
        // The signed rule fixed that and left a second, subtler version of the
        // same shape: this check ran BEFORE the tax was re-validated, so a row
        // whose TAX is also invalidated by the new gross (207.74 / 16.55 tax /
        // 50 base, edited to 10) was refused here for its base, even though the
        // plan under the lock would have cleared BOTH stale figures and
        // accepted the edit. The receipt stayed uncorrectable through the only
        // handler that can correct it — the exact failure round 41 fixed one
        // branch of.
        //
        // So the fast fail runs the SAME plan the locked path runs and refuses
        // only what the plan itself calls a base-only misfit. `grossMoved` is
        // false because this pass is not deciding the review flag — only
        // whether there is a base problem the clears cannot resolve.
        const fastPlan = planTaxRevalidation(
            {
                taxAmount: expense.taxAmount === null ? null : Number(expense.taxAmount),
                taxDeductibleBase: existingBase,
                installedAtCustomer: null,
                taxSource: null,
                taxDeductibleBaseSource: null,
            },
            resultingAmount,
            { grossMoved: false },
        );
        if (fastPlan.reason === "base-cannot-fit") {
            const ceiling = deductionCeiling(resultingAmount, Number(expense.taxAmount ?? 0));
            return NextResponse.json(
                {
                    error: `This amount would leave a deduction base of ${existingBase!.toFixed(2)} outside the pre-tax total (${ceiling.toFixed(2)}). Clear or lower the deduction base first.`,
                },
                { status: 400 },
            );
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
            const raw = tx as unknown as { $queryRawUnsafe(q: string, ...v: unknown[]): Promise<unknown> };
            // THE ATTRIBUTION PARENTS, IN THE CANONICAL ORDER, BEFORE ANYTHING
            // ELSE (round 37, item 3): Project -> Estimate -> EstimateItem ->
            // CostCode -> Expense.
            //
            // The three calls below reach these tables in scattered order —
            // `resolveExpenseProjectUnderLock` share-locks the Estimate, then
            // `assertPhaseOfProjectTx` reaches for the Project — and the
            // per-expense lock came first, so a booking taking the parents
            // before its Expense lock and this handler taking them after it
            // are a cycle from both ends. One acquisition, one order.
            await lockAttributionParents(raw, {
                projectId: resolvedProjectId,
                estimateId: expense.estimateId,
                itemId: body.itemId || null,
                costCodeId: editsCostCode ? nextCostCodeId : null,
            });
            // THE SHARED PER-EXPENSE LOCK (round 35, item 1).
            //
            // The tax PATCH has taken it since round 17; this handler never
            // did, and it is the OTHER writer of the values every tax
            // invariant is built from. `taxDeductibleBase <= amount -
            // taxAmount` and the 12% plausibility band are both ratios of the
            // GROSS, and the gross is exactly what this route rewrites — so a
            // PUT could read the tax figures, have a concurrent PATCH replace
            // them, and then apply an amount that was only ever coherent
            // against the values it first saw.
            await lockExpense(raw, id);
            // The same locked re-resolve as the DELETE: this route stamps
            // "manual" and rewrites the amount, and a fallback-attributed row
            // can change jobs between the authorization above and this write.
            const lockedProjectId = await resolveExpenseProjectUnderLock(raw, expense);
            if (!lockedProjectId || !canAccessProject(user, lockedProjectId)) {
                return { expense: null, phaseRejected: null, denied: "forbidden" } as const;
            }
            // ...AND IF IT IS NOT THE JOB WHOSE ROWS ARE HELD, THIS REQUEST
            // STOPS (round 37, item 3). A fallback-attributed row whose
            // estimate moved between the pre-transaction read and here answers
            // for a Project that is NOT in the locked set, so continuing would
            // take Estimate -> Project after all. The editor reopens and
            // retries against the job the row actually joined.
            if (lockedProjectId !== resolvedProjectId) {
                return { expense: null, phaseRejected: null, denied: "moved" } as const;
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
                const verdict = await assertPhaseOfProjectTx(raw, lockedProjectId, nextCostCodeId);
                if (!verdict.ok) {
                    return { expense: null, phaseRejected: verdict.reason, denied: null } as const;
                }
            }
            if (body.itemId) {
                const onThisJob = await itemBelongsToProjectTx(raw, body.itemId, lockedProjectId);
                if (!onThisJob) {
                    return { expense: null, phaseRejected: null, denied: "item" } as const;
                }
            }
            // THE TAX CLASSIFICATION, RE-READ UNDER THE LOCK.
            //
            // Everything checked before the transaction was checked against the
            // row as it was READ, on the global client — the one state the lock
            // exists to distrust. These columns are re-read here so the
            // verdicts below, and the predicate that carries them, all speak
            // about the same row the write lands on.
            //
            // `installedAtCustomer` IS ONE OF THEM (round 38, item 3). It was
            // not selected and not pinned, because the `classified` test below
            // did not mention it — and it is the ONE column that can carry a
            // bookkeeper's whole tax answer on its own, with every figure left
            // null. See `hasTaxClassification`.
            const current = await tx.expense.findUnique({
                where: { id },
                select: {
                    amount: true,
                    taxAmount: true,
                    taxDeductibleBase: true,
                    installedAtCustomer: true,
                    taxSource: true,
                    taxDeductibleBaseSource: true,
                    needsTaxReview: true,
                },
            });
            if (!current) {
                return { expense: null, phaseRejected: null, denied: "moved" } as const;
            }
            const lockedAmount = Number(current.amount);
            const lockedTax = current.taxAmount === null ? null : Number(current.taxAmount);
            const lockedBase =
                current.taxDeductibleBase === null ? null : Number(current.taxDeductibleBase);
            const lockedTaxSource = current.taxSource ?? null;
            const lockedBaseSource = current.taxDeductibleBaseSource ?? null;
            const finalAmount = nextAmount ?? lockedAmount;
            const inCents = (value: number) => Math.round(value * 100);
            const grossChanges =
                nextAmount !== undefined && inCents(nextAmount) !== inCents(lockedAmount);

            // `Expense_taxDeductibleBase_check`, MIRRORED IN CODE.
            //
            // Stated exactly as the constraint is — sign against the AMOUNT,
            // magnitude against the pre-tax ceiling — rather than as the
            // unsigned `base > ceiling` the fast-fail above uses, which cannot
            // see every shape Postgres refuses. Reaching it means something
            // moved under the request, and it is answered as a 400 naming the
            // remedy instead of as the 500 a CHECK violation surfaces as.
            // THE NEW GROSS, JUDGED AGAINST THE FIGURES ALREADY ON THE ROW,
            // THROUGH THE SHARED PLAN (round 41, item 2).
            //
            // This route could only ever RAISE `needsTaxReview`. It never
            // handled a tax the new gross cannot carry, so editing a $207.74
            // receipt with $16.55 of tax down to 0, to -5, or to any positive
            // amount under $16.55 wrote a row that violates
            // `Expense_taxAmount_check` — Postgres refused it and the generic
            // catch turned that into a 500. The unit tests said 200 because the
            // fake `updateMany` enforces no CHECK constraints, and production
            // said nothing because the rollout trigger was quietly repairing
            // the row until `--post-deploy` drops it.
            //
            // `planTaxRevalidation` is the same rule the QBO sync applies and
            // the compatibility trigger transcribes, so all three now answer
            // one question one way.
            const revalidation = planTaxRevalidation(
                {
                    taxAmount: lockedTax,
                    taxDeductibleBase: lockedBase,
                    installedAtCustomer: current.installedAtCustomer,
                    taxSource: lockedTaxSource,
                    taxDeductibleBaseSource: lockedBaseSource,
                },
                finalAmount,
                { grossMoved: grossChanges },
            );
            // A BASE THAT NO LONGER FITS IS STILL A 400 HERE, not a silent
            // clear. The plan's branch 2 would throw the allocation away; this
            // route deliberately refuses instead and names the remedy, which is
            // strictly more conservative — nothing of the person's is destroyed
            // and they are told why (round 35). The plan's branch 1 CANNOT be
            // answered that way: refusing every gross edit on a row whose tax
            // no longer fits would leave the receipt uncorrectable through the
            // only handler that can correct it.
            if (revalidation.reason === "base-cannot-fit") {
                return { expense: null, phaseRejected: null, denied: "base" } as const;
            }

            // AND THE PLAUSIBILITY BOUND, WHICH THIS ROUTE NEVER RAN AT ALL.
            //
            // `taxAmount` is not editable here, but `amount` is — and the bound
            // is a RATIO. Lowering a $207.74 receipt to $100 leaves its $16.55
            // of tax at 16.6%, past the 12% band that `book.ts` and the tax
            // PATCH both refuse; a receipt taken negative leaves a positive tax
            // pointing the wrong way. Either way the edit walks the row into a
            // classification NO writer of those columns would have accepted,
            // and the excise report reads it as a certified figure.
            //
            // PUT cannot refuse it — changing a receipt's total is ordinary
            // work, and the tax columns are not this route's to correct — so it
            // takes BOOKING's remedy rather than the PATCH's: the row is
            // flagged and a person is asked to look again.
            // THE SHARED DEFINITION, not a fourth local copy (round 38, item
            // 3). This one used to omit `installedAtCustomer`, so a row whose
            // only classification was a bookkeeper's explicit "installed at
            // the customer" — every figure null — was treated as unclassified
            // and its gross could be edited with no review flag, while the QBO
            // sync and the rollout trigger both counted the same row as
            // classified. Three writers, three answers, and the narrowest one
            // decided what reached the excise return.
            const classified = hasTaxClassification({
                taxAmount: lockedTax,
                taxDeductibleBase: lockedBase,
                installedAtCustomer: current.installedAtCustomer,
                taxSource: lockedTaxSource,
                taxDeductibleBaseSource: lockedBaseSource,
            });
            const stillPlausible =
                lockedTax === null || isPlausibleReceiptTax(lockedTax, finalAmount);
            // A PERMISSION IS NOT A REVIEW (round 39, item 1).
            //
            // This used to flag only when the resulting figures were
            // implausible OR the actor lacked `financialReports`, which reads
            // as "a finance user's edit is self-certifying". It is not.
            // Changing a receipt's total is ordinary work that anyone with
            // `timeClock` may do; deciding that the tax figures still describe
            // the new total is a separate act, and holding a role is evidence
            // of neither having done it nor having been asked to. A bookkeeper
            // lowering a $412.10 receipt to $398 left $34.06 of tax and a $200
            // deduction base standing, inside every band, certified by nobody —
            // and straight into the excise return. The DB rollout trigger flags
            // EVERY gross change on a classified row; the handler must not be
            // the weaker of the two.
            //
            // So every gross change on a classified row flags it, and the ONLY
            // thing that prevents the flag is an explicit acknowledgement in
            // the same request naming the figures that were reviewed and the
            // amount they were reviewed AGAINST. `financialReports` is
            // necessary for that ack to count — certifying tax is what that
            // permission is for — but it is never sufficient on its own.
            //
            // The ack does not CLEAR a flag that is already set: that is the
            // PATCH's job (`taxReviewAck`, which requires the figures
            // themselves), and this route may not write the tax columns at all.
            // TWO QUESTIONS, ANSWERED SEPARATELY. "Does this ack describe the
            // write that is landing?" is about the ROW, and the answer "no" is
            // a 409: the person certified something else. "May this actor
            // certify tax at all?" is about the ACTOR, and a crew member's
            // perfectly accurate ack simply buys nothing — their edit is
            // flagged like any other. Collapsing the two would answer 409 to
            // somebody whose only problem is a permission.
            const ackDescribesThisWrite =
                reviewAck !== null &&
                inCents(reviewAck.amount) === inCents(finalAmount) &&
                sameFigure(reviewAck.taxAmount, lockedTax) &&
                sameFigure(reviewAck.taxDeductibleBase, lockedBase) &&
                (reviewAck.installedAtCustomer ?? null) === (current.installedAtCustomer ?? null);
            const ackCounts = ackDescribesThisWrite && hasPermission(user, "financialReports");
            // AN ACK THAT DESCRIBES A DIFFERENT ROW IS NOT AN ACK. The person
            // certified figures, or a total, that this write is not producing —
            // a stale form, or a concurrent PATCH that moved the tax underneath
            // them. Answering 409 sends them back to re-read rather than
            // silently downgrading their certification to a flag they never saw.
            if (reviewAck !== null && classified && grossChanges && !ackDescribesThisWrite) {
                return { expense: null, phaseRejected: null, denied: "ack" } as const;
            }
            // ...and an ack cannot certify an IMPOSSIBLE classification: a tax
            // outside the 12% band is a figure no writer of that column would
            // have accepted, whoever says otherwise — and neither can it
            // certify one the plan just had to CLEAR.
            const flagsReview =
                revalidation.needsTaxReview &&
                !(ackCounts && stillPlausible && revalidation.reason !== "tax-cannot-fit");
            // AND THE ACKNOWLEDGED WRITE SAYS SO OUT LOUD (round 41, item 3).
            //
            // During the drain window the compatibility trigger forces
            // `needsTaxReview` true on EVERY classified gross change, because
            // the old build cannot speak for itself. It cannot see an ack, so a
            // certified edit was flagged anyway and the row stayed out of the
            // filing — the ack bought nothing for exactly as long as the
            // scaffolding stood.
            //
            // The trigger's exemption is "this statement named the flag
            // column", which is precisely what the old build can never do. So
            // an acknowledged write states `needsTaxReview: false` EXPLICITLY
            // rather than omitting it. Writing `false` onto a row that is
            // already `false` changes no data; it is the signal.
            //
            // Only when the row was NOT already flagged. Clearing a flag that
            // is already up needs the PATCH, which demands the figures
            // themselves — this route may not write the tax columns at all, so
            // it has no business retiring a review it cannot answer.
            const acknowledgedWrite =
                !flagsReview && classified && grossChanges && ackCounts && !current.needsTaxReview;

            const written = await tx.expense.updateMany({
            where: {
                id,
                // COMPARE-AND-SET on the tax figures these verdicts rested on,
                // pinned to what was read UNDER the lock. The lock orders the
                // writers that take it; the predicate is what still protects
                // against one that does not (a script, a migration, a path
                // somebody forgets to wire).
                //
                // Normalised to null rather than passed through as undefined:
                // Prisma reads an undefined filter as NO filter, so an
                // un-normalised pin would silently drop itself on exactly the
                // rows — the un-classified ones — where it looks harmless.
                amount: current.amount,
                taxAmount: current.taxAmount ?? null,
                taxDeductibleBase: current.taxDeductibleBase ?? null,
                // Pinned for the same reason it is now READ: the review verdict
                // rests on it, so a PATCH answering the installed-at-customer
                // question between this read and the write must lose the CAS
                // rather than have its answer decided against.
                installedAtCustomer: current.installedAtCustomer ?? null,
                taxSource: lockedTaxSource,
                taxDeductibleBaseSource: lockedBaseSource,
                needsTaxReview: Boolean(current.needsTaxReview),
                ...expenseStillOnProjectWhere(expense, lockedProjectId),
            },
            data: {
                amount: nextAmount,
                vendor: has("vendor") ? (body.vendor || null) : undefined,
                // Same company-calendar-day rule as the POST — see there.
                date: nextDate,
                description: has("description") ? (body.description || null) : undefined,
                itemId: has("itemId") ? (body.itemId || null) : undefined,
                ...(editsCostCode
                    ? {
                        costCodeId: nextCostCodeId,
                        // CLEARING THE PHASE IS A DECISION, SO IT IS RECORDED AS ONE
                        // (round 36, item 3). This used to write a null source
                        // beside the null code, reasoning that provenance for no
                        // code has nothing to guard. Null is the exact state the
                        // QBO suggester and the backfill both read as "no human has
                        // spoken here, a machine may write", so the next sync put
                        // the same regex suggestion straight back and the
                        // bookkeeper's clear vanished within the hour.
                        //
                        // "manual-none" is the same shape `taxSource` already uses
                        // for "a person looked and the answer is nothing" — it is
                        // in HUMAN_COST_CODE_SOURCES, so notHumanCodedExpenseWhere()
                        // holds every automated pass off it, while a human later
                        // picking a real phase still overwrites it with "manual".
                        costCodeSource: nextCostCodeId ? "manual" : "manual-none",
                        costCodeConfidence: null,
                    }
                    : {}),
                // FIGURES THE NEW GROSS CANNOT CARRY GO IN THE SAME STATEMENT
                // AS THE GROSS (round 41, item 2). Without this the write
                // violates `Expense_taxAmount_check` and the handler answers
                // 500; with it the row lands valid and flagged, which is the
                // policy the QBO sync and the rollout trigger already apply.
                ...revalidation.clears,
                // Raised in the SAME statement as the gross that invalidated
                // the classification. Two statements would leave a window in
                // which the excise report sees the new amount under the old
                // certification — which is the exact state the flag exists to
                // keep out of a filing.
                ...(flagsReview
                    ? { needsTaxReview: true }
                    // ...and an ACKNOWLEDGED write states the flag explicitly
                    // rather than staying silent, so the compatibility trigger
                    // can tell a certified edit from the old build's (round 41,
                    // item 3). No-op as data; load-bearing as a signal.
                    : acknowledgedWrite ? { needsTaxReview: false } : {}),
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
        if (legacyWrite.denied === "ack") {
            return NextResponse.json(
                {
                    error: "The tax figures you reviewed are not the ones on this expense any more, or the total you reviewed them against is not the one being saved. Reopen it, check the figures, and try again.",
                    code: "TAX_REVIEW_ACK_STALE",
                },
                { status: 409 },
            );
        }
        if (legacyWrite.denied === "item") {
            return NextResponse.json(
                { error: "That line item isn't on this project's estimates. Save the Estimate on the web first, or pick a line item from this job." },
                { status: 400 },
            );
        }
        if (legacyWrite.denied === "base") {
            return NextResponse.json(
                {
                    error: "This amount would leave a deduction base above the pre-tax total. Reopen the expense and clear or lower the deduction base first.",
                    code: "BASE_ABOVE_CEILING",
                },
                { status: 400 },
            );
        }
        if (legacyWrite.denied) {
            return NextResponse.json(
                {
                    error: "This expense moved to another job, or its tax figures changed, while you were editing it. Reopen it and try again.",
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
        if (isQboManagedExpenseError(error)) {
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
/** Thrown for a date the caller SENT and got wrong — a 400, never a 500. */
export class InvalidExpenseDateError extends Error {
    constructor(public readonly value: string, reason: string) {
        super(`date ${reason}`);
        this.name = "InvalidExpenseDateError";
    }
}

/**
 * `Expense.date` is a COMPANY CALENDAR DAY. A bare YYYY-MM-DD goes through the
 * shared parser so it lands at local noon; a full timestamp is already an
 * instant and is kept as one.
 *
 * ANYTHING ELSE IS A 400 (round 47, item 2). This used to end in
 * `new Date(value)`, which turns junk into an Invalid Date and hands it to
 * Prisma, and a well-shaped impossible day like `2026-02-31` passed the regex,
 * reached the parser, and threw — answering a caller's typo with a 500.
 */
async function expenseDate(value: unknown): Promise<Date> {
    const verdict = classifyCalendarDate(value);
    if (verdict.kind === "valid") {
        return dateOnlyInTimeZone(verdict.date, await resolveCompanyTimeZone());
    }
    // A CALENDAR-DAY SHAPE THAT NAMES NO REAL DAY IS REFUSED HERE, and never
    // retried as an instant: `new Date("2026-02-31")` does not fail, it rolls
    // forward to 3 March, so the fallback below would turn an impossible date
    // into a silently wrong one — worse than the 500 it replaced.
    if (verdict.kind === "invalid" && verdict.reason === CALENDAR_DATE_NOT_REAL) {
        throw new InvalidExpenseDateError(verdict.value, verdict.reason);
    }
    // A full timestamp is legitimate here and is NOT a calendar day, so it is
    // tried before the verdict is treated as a refusal.
    const instant = new Date(value as string);
    if (!Number.isNaN(instant.getTime())) return instant;
    throw new InvalidExpenseDateError(
        verdict.kind === "invalid" ? verdict.value : String(value),
        verdict.kind === "invalid" ? verdict.reason : "is not a valid date",
    );
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
        const patchCostCodeEdit = parseCostCodeIdEdit(body);
        const editsCostCode = patchCostCodeEdit.kind !== "untouched";

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
        // So clearing it takes an explicit acknowledgement AND all three of the
        // fields the report actually reads — `taxAmount`, `taxDeductibleBase`
        // and `installedAtCustomer`. That last one is NOT optional, whatever an
        // earlier draft of this comment said: it is the single field the excise
        // report keys on, so omitting it preserves a stored `true` and
        // re-admits the receipt on an eligibility nobody re-checked (round 43,
        // item 1). A null answer IS an answer; what is refused is silence.
        //
        // A tax edit WITHOUT the ack is still accepted — a partial correction
        // is normal work — it simply leaves the flag standing.
        // ONE PARSER, shared with the PUT (round 43, item 1). This route WRITES
        // the tax columns, so its ack is the bare boolean and the answers
        // travel beside it in the same body; the object form belongs to the PUT
        // and means nothing here.
        const patchAck = parseTaxReviewAck(body);
        if (patchAck.kind === "invalid" || patchAck.kind === "figures") {
            return NextResponse.json(
                { error: TAX_REVIEW_ACK_MALFORMED_MESSAGE, code: "TAX_REVIEW_ACK_MALFORMED" },
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

        const acknowledgesReview = patchAck.kind === "flag";
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
            // ...AND `installedAtCustomer` IS ONE OF THEM (round 43, item 1).
            //
            // It was optional here on the reasoning that "a null reads as
            // unanswered and the report skips the row" — true of a null, and
            // beside the point. Omitting the key does not write a null; it
            // PRESERVES whatever is stored, and the excise report keys on
            // exactly `installedAtCustomer: true` + `needsTaxReview: false`. So
            // a flagged row whose stored answer was already `true` had its
            // review cleared by a request that never mentioned installation,
            // and the receipt went straight back into the return on an
            // eligibility nobody re-checked.
            //
            // Required only when a flag is actually being CLEARED: an ordinary
            // ack on an unflagged row certifies nothing that was in doubt. A
            // `null` answer is still an answer ("I do not know whether this was
            // resold"), and the report reads it as not deductible — what is
            // refused is SILENCE.
            const complete = expense.needsTaxReview
                ? taxReviewAckIsComplete({
                    taxAmount: editsTaxAmount,
                    taxDeductibleBase: editsBase,
                    installedAtCustomer: editsInstalled,
                })
                : editsTaxAmount;
            const answered =
                complete &&
                (body.taxAmount === null || coherent(body.taxAmount)) &&
                (!editsBase || body.taxDeductibleBase === null || coherent(body.taxDeductibleBase));
            if (!answered) {
                return NextResponse.json(
                    {
                        error: expense.needsTaxReview
                            ? "Acknowledging a tax review needs taxAmount, taxDeductibleBase AND installedAtCustomer in the same request — the whole classification, not part of it."
                            : "Acknowledging a tax review needs taxAmount in the same request — a figure, or an explicit null meaning this receipt has no sales tax.",
                        code: expense.needsTaxReview && !editsInstalled
                            ? "TAX_REVIEW_ACK_MALFORMED"
                            : "TAX_REVIEW_INCOMPLETE",
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
        // PROVENANCE IS PER FIELD (round 33, item 4). `taxSource` governs
        // `taxAmount` ALONE; `taxDeductibleBaseSource` governs the deduction
        // base (see HUMAN_TAX_SOURCES in expense-attribution.ts):
        //
        //   * an explicit `taxAmount: null` is a person saying this receipt has
        //     NO sales tax -> `taxSource` "manual-none". Not an absence: it is
        //     the answer a null figure cannot express on its own, and booking
        //     must not write an OCR guess over it.
        //   * any other `taxAmount` edit -> `taxSource` "manual".
        //   * a `taxDeductibleBase`-ONLY edit still does NOT stamp `taxSource`.
        //     The base is a portion of the tax figure, not an answer about it —
        //     stamping "manual" there would permanently block an OCR read from
        //     ever filling `taxAmount` on a row nobody has actually spoken to
        //     tax about (book.ts refuses to touch a human-sourced row). It
        //     stamps `taxDeductibleBaseSource` "manual" instead, which says the
        //     true thing about the field it actually answered.
        //   * ONE COLUMN COULD NOT SAY BOTH. With `taxSource` governing the
        //     pair, the sequence "bookkeeper sets a base, booking later fills
        //     the tax" ended with `taxSource: "ocr"` standing over a base a
        //     person had typed — stored provenance claiming a machine decided
        //     a figure it never saw.
        //   * OMITTING `taxAmount` leaves `taxSource` alone, so a row nobody
        //     has spoken about stays open to an automated read; omitting
        //     `taxDeductibleBase` leaves its source alone for the same reason.
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
        // So it clears BOTH provenances and both figures together.
        // Otherwise, only a `taxAmount` edit stamps `taxSource` — a
        // `taxDeductibleBase`-only edit leaves it untouched (see above) and
        // stamps `taxDeductibleBaseSource` instead.
        const stampsTaxProvenance = editsTaxAmount && !taxIsUnknown;
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
        // MAGNITUDE AND DIRECTION, because all three figures are signed — and
        // through the SHARED helper, so the PUT's two checks, this one, the
        // booking fill and the database CHECK are one rule rather than four
        // transcriptions of it (round 40, item 2).
        if (!taxDeductibleBaseFits(resultingBase, Number(expense.amount), resultingTax)) {
            const ceiling = deductionCeiling(Number(expense.amount), resultingTax);
            return NextResponse.json(
                { error: `The deduction base can't exceed the pre-tax receipt total (${ceiling.toFixed(2)}).` },
                { status: 400 },
            );
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
            // STRICT TYPE, through the SHARED parser (round 40, item 3).
            // `has("costCodeId")` only proves the key is present — the value
            // can still be a number, boolean, array, or object, and treating
            // every one of those as "clear the cost code" would silently strip
            // a real attribution off a bad request instead of rejecting it.
            // This handler was the only one of the three that got that right;
            // it now shares the rule rather than being the copy that happens
            // to be correct.
            if (patchCostCodeEdit.kind === "invalid") {
                return NextResponse.json(
                    { error: COST_CODE_ID_INVALID_MESSAGE },
                    { status: 400 },
                );
            }
            nextCostCodeId =
                patchCostCodeEdit.kind === "set" ? patchCostCodeEdit.costCodeId : null;
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
        // WHAT THE BASE COLUMN WILL ACTUALLY HOLD, named once — so its
        // provenance is decided from the value being written rather than from
        // which key the request happened to carry. A server-computed base is
        // still a human's decision: it is `amount - tax` written out because
        // the person who edited the tax left the base blank meaning "all of
        // it", not a figure anything read off a receipt.
        const nextBaseValue = computedBase !== null ? computedBase : nextBase;

        const data = {
                ...(editsInstalled ? { installedAtCustomer: nextInstalled } : {}),
                ...(taxIsUnknown
                    // Both figures and BOTH provenances, in one statement: a
                    // half-retracted row is exactly the shape this is fixing,
                    // and a base source left saying "manual" over a base that
                    // is now null is the same lie in miniature.
                    ? { taxDeductibleBase: null, taxSource: null, taxDeductibleBaseSource: null }
                    : writesBase
                        ? {
                            taxDeductibleBase: nextBaseValue,
                            // Written in the SAME statement as the figure it
                            // describes, and derived from it: a base is
                            // "manual" exactly when this request leaves one
                            // standing. Clearing the base back to blank clears
                            // its source too — a blank is an absence, not a
                            // decision, and locking the column on an absence
                            // would freeze the row out of the pipeline.
                            taxDeductibleBaseSource: nextBaseValue === null ? null : "manual",
                        }
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
                        // EXACTLY ONE COLUMN: taxAmount. The deduction base
                        // carries its own, written above beside the figure it
                        // describes (round 33, item 4).
                        //
                        // It is stamped only when this request actually carries
                        // the tax FIGURE. Two consequences, both
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
                        // Same decision, same recording — see the block above.
                        costCodeSource: nextCostCodeId ? "manual" : "manual-none",
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
            // THE ATTRIBUTION PARENTS FIRST, IN THE CANONICAL ORDER (round 37,
            // item 3): Project -> Estimate -> EstimateItem -> CostCode ->
            // Expense. Same reason as the PUT handler above — the two calls
            // below take the Estimate before the Project on their own, which
            // is a cycle against a Project-first job editor.
            await lockAttributionParents(raw, {
                projectId,
                estimateId: expense.estimateId,
                costCodeId: editsCostCode ? nextCostCodeId : null,
            });
            await lockExpense(raw, id);
            // THE JOB, RE-RESOLVED UNDER LOCK (round 19, item 3). For a row
            // with no `projectId` of its own the answer lives on the estimate,
            // which somebody else can re-point while this request decides.
            const lockedProjectId = await resolveExpenseProjectUnderLock(raw, expense);
            if (!lockedProjectId || !canAccessProject(user, lockedProjectId)) {
                return { count: 0, phaseRejected: null, denied: "forbidden" } as const;
            }
            // The row moved out of the locked job (see the PUT handler): the
            // predicate below would match nothing anyway, and asking the phase
            // question about the new job would take its Project row out of
            // order. `count: 0` is the 409 "reopen and retry" the client
            // already understands.
            if (lockedProjectId !== projectId) {
                return { count: 0, phaseRejected: null, denied: null } as const;
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
