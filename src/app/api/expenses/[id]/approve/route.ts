import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { canAccessProject, getCurrentUserWithPermissions, hasPermission } from "@/lib/permissions";
import {
    assertExpenseMutableOutsideQbo,
    isQboManagedExpenseError,
} from "@/lib/qbo-expense-guard";
import {
    expenseStillOnProjectWhere,
    resolveExpenseProjectId,
    resolveExpenseProjectUnderLock,
} from "@/lib/expense-attribution";
import { lockExpense } from "@/lib/expense-lock";
import { lockAttributionParents } from "@/lib/phase-invariant";

/**
 * APPROVING AN EXPENSE IS A MUTATION OF THE SAME ROW, SO IT TAKES THE SAME
 * RULES AS PUT AND DELETE (Codex round 35, item 3).
 *
 * This handler used to check `getServerSession` — that SOMEBODY was signed in
 * — and then update a bare expense id. It resolved no project, required no
 * permission, and named nothing but the id in its predicate. Any authenticated
 * account that knew or guessed an id could stamp any expense on any job
 * "Reviewed": the sign-off the receipt queue treats as "a person has looked at
 * this", and the one thing standing between a mis-booked receipt and a job's
 * cost report. A textbook IDOR, and the most damaging kind — it forges a
 * human's judgement rather than merely changing a number.
 *
 * So it now applies EXACTLY what the sibling handlers apply, and for the same
 * reasons stated there: the `timeClock` permission, the RESOLVED job (never the
 * estimate's, which is the job a re-attributed row LEFT), project access,
 * failing CLOSED on a row with no resolvable job, and the locked re-resolve
 * plus fenced write so a row that moves in the gap is not stamped under a
 * permission granted for somewhere else.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
        const user = await getCurrentUserWithPermissions();
        if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        if (!hasPermission(user, "timeClock")) {
            return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }

        const { id } = await params;
        if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

        const expense = await prisma.expense.findUnique({
            where: { id },
            select: {
                qbPurchaseId: true,
                status: true,
                projectId: true,
                estimateId: true,
                estimate: { select: { projectId: true } },
            },
        });
        assertExpenseMutableOutsideQbo(expense);
        if (!expense) return NextResponse.json({ error: "Expense not found" }, { status: 404 });

        // Fail CLOSED: with no resolvable project there is no scope to
        // authorize against, so nobody may approve it here.
        const projectId = resolveExpenseProjectId(expense);
        if (!projectId || !canAccessProject(user, projectId)) {
            return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }

        const approved = await prisma.$transaction(async tx => {
            const raw = tx as unknown as { $queryRawUnsafe(q: string, ...v: unknown[]): Promise<unknown> };
            // THE PARENTS FIRST, THEN THE ROW (round 40, item 1). The global
            // order is Project -> Estimate -> EstimateItem -> CostCode ->
            // Expense, and EXPENSE IS LAST.
            //
            // This transaction took the per-expense lock and only then called
            // `resolveExpenseProjectUnderLock`, which for a fallback-attributed
            // row (no `projectId` of its own) share-locks the ESTIMATE to
            // answer. That is Expense -> Estimate, and the booking path is
            // Estimate -> Expense — a cycle, broken by Postgres killing one
            // side with 40P01, and neither of these routes runs under
            // `withTxRetry`. Round 37 and 38 missed it because the tripwire
            // only knew about the Project/Estimate half of the order.
            //
            // `projectId` is the job the access check above was answered
            // about, so it is both the right row to hold and the value the
            // guard below refuses to differ from.
            await lockAttributionParents(raw, { projectId, estimateId: expense.estimateId });
            // The shared per-expense lock, so this is ordered against the tax
            // PATCH and the QBO sync rather than merely racing them.
            await lockExpense(raw, id);
            const locked = await resolveExpenseProjectUnderLock(raw, expense);
            if (!locked || !canAccessProject(user, locked)) {
                return { count: 0, denied: true } as const;
            }
            // ...and if the locked answer is a job whose row this transaction
            // is NOT holding, it stops: continuing would reach for that
            // Project after the Expense lock, which is the inversion again one
            // job over. `count: 0` is the 409 the caller already understands.
            if (locked !== projectId) {
                return { count: 0, denied: false } as const;
            }
            const result = await tx.expense.updateMany({
                where: {
                    id,
                    // The QBO guard restated as a PREDICATE. The throw above
                    // answers about the row as it was read; a Purchase id that
                    // lands in the gap makes the row QuickBooks-owned, and the
                    // approval must not slip in behind it.
                    qbPurchaseId: null,
                    // The status this approval was decided FROM. A row somebody
                    // else already moved is not silently re-stamped, and the
                    // caller is told rather than shown a success for a decision
                    // that was not theirs.
                    status: expense.status,
                    // The attribution the authorization rested on: a row that
                    // moved in the gap matches nothing instead of being
                    // approved under a stale permission.
                    ...expenseStillOnProjectWhere(expense, locked),
                },
                data: { status: "Reviewed" },
            });
            return { count: result.count, denied: false } as const;
        });
        // TWO different answers, as in the PATCH: "you may not touch this job"
        // is a 403 about the ACTOR, a lost predicate is a 409 about the ROW.
        if (approved.denied) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        if (approved.count === 0) {
            return NextResponse.json(
                {
                    error: "This expense changed while you were approving it. Reopen it and try again.",
                    code: "EXPENSE_REATTRIBUTED",
                },
                { status: 409 },
            );
        }
        return NextResponse.json({ success: true });
    } catch (err) {
        // NAME-BASED, not `instanceof`: under Node 20 + tsx this module can be
        // loaded twice under different specifiers, which makes `instanceof`
        // false for an error the guard itself threw.
        if (isQboManagedExpenseError(err)) {
            return NextResponse.json({ error: err.message }, { status: 409 });
        }
        const msg = err instanceof Error ? err.message : "Failed to approve";
        return NextResponse.json({ error: msg }, { status: 500 });
    }
}
