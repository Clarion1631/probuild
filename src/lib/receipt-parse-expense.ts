/**
 * The AI receipt parser's ONE write, split out of
 * src/app/api/receipts/parse/route.ts (round 38, item 1).
 *
 * It lives here rather than in the route so two concurrent connections can
 * drive the real thing against a real Postgres
 * (tests/attribution-lock-order-db.test.ts). A lock order is the one thing a
 * scripted client can never have an opinion about, and importing the route
 * itself drags in `mobile-auth`, which refuses to load without NEXTAUTH_SECRET.
 */
import { lockEstimateAttribution } from "@/lib/expense-attribution";
import { lockAttributionParents } from "@/lib/phase-invariant";

/** The transaction client subset the write below needs. */
interface ParsedReceiptDb {
    $transaction<T>(fn: (tx: {
        $queryRawUnsafe(q: string, ...v: unknown[]): Promise<unknown>;
        expense: { create(args: { data: Record<string, unknown> }): Promise<{ id: string }> };
    }) => Promise<T>): Promise<T>;
}

/**
 * WRITE THE PARSED RECEIPT, UNDER THE CANONICAL ATTRIBUTION LOCKS.
 *
 * Split out of the handler so it can be driven against a real Postgres by two
 * concurrent connections (tests/attribution-lock-order-db.test.ts) — a lock
 * order is the one thing a scripted client can never have an opinion about,
 * and the handler around this needs an image, an Anthropic key and a session.
 *
 * THE ORDER, and the lock nobody writes down (round 38, item 1):
 * Project -> Estimate -> EstimateItem -> CostCode -> Expense. This transaction
 * never names `"Project"`, so round 37's tripwire read it as estimate-only. It
 * is not: the `create` sets `projectId`, and Postgres enforces that foreign key
 * by taking `FOR KEY SHARE` on the referenced `Project` row — which conflicts
 * with the `FOR UPDATE` a job editor holds. Share-locking the estimate and only
 * then writing `projectId` is `Estimate -> Project`, a deadlock cycle against a
 * Project-first writer, and this route has no `withTxRetry` to fall back on.
 *
 * `projectId` is the job the caller's ACCESS CHECK was answered about, so it is
 * both the right row to lock and the value the guard already refuses to differ
 * from. `null` means the estimate moved to another job while the image was
 * being read: nothing is written, and the caller reports `estimate-moved`
 * rather than showing a row on a job nobody chose.
 */
export async function createParsedReceiptExpense(
    db: ParsedReceiptDb,
    input: {
        projectId: string;
        estimateId: string;
        description: string;
        amount: number;
        date: Date;
        vendor: string;
    },
): Promise<{ id: string } | null> {
    return db.$transaction(async tx => {
        const raw = tx as unknown as { $queryRawUnsafe(q: string, ...v: unknown[]): Promise<unknown> };
        await lockAttributionParents(raw, {
            projectId: input.projectId,
            estimateId: input.estimateId,
        });
        const pair = await lockEstimateAttribution(raw, input.estimateId);
        if (!pair || pair.projectId !== input.projectId) return null;
        return tx.expense.create({
            data: {
                // ONE PAIR, from one locked read. Cost code stays null: this
                // parse reads vendor/total/date, never a phase.
                estimateId: pair.estimateId,
                projectId: pair.projectId,
                description: input.description,
                amount: input.amount,
                date: input.date,
                vendor: input.vendor,
                status: "Pending",
            },
        });
    });
}
