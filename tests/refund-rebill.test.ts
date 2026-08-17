/**
 * Refunded milestones must come back BILLABLE, not merely un-Paid.
 *
 * PR #389 gave refunds a real row identity and restored `status`/`paidAt`/
 * `paymentDate` across the whole charge group. What it deliberately left behind
 * was the Stripe rail pair — `stripeSessionId` and `stripePaymentIntentId` — on
 * every released row, on the theory that they were how a redelivered
 * `charge.refunded` re-found the group.
 *
 * That left the milestone Pending but permanently un-collectible. Every path
 * that would bill it again reads a non-null rail id on a NON-Paid row as "a
 * payment is in flight on this row — refuse":
 *
 *   - `progress-billing.ts` validation ("A payment is in progress on X — wait
 *     for it to finish or void it before billing") and its pinned claim, whose
 *     WHERE requires both columns to be null;
 *   - `billing-core.ts` rebalance, single-milestone delete, and the re-split
 *     in-flight probe;
 *   - the schedule-delete filter in `saveEstimate` (`actions.ts`);
 *   - the portal's pay-in-full affordance.
 *
 * Nothing on the row distinguishes "checkout still open" from "charge refunded",
 * so no guard-side fix is possible — the columns have to be cleared when the
 * money is released.
 *
 * These tests pin the two halves of that:
 *  1. the release statement itself clears both rails (and still pins status);
 *  2. clearing them cannot break redelivery, because `resolveChargeGroup`
 *     matches on `status: "Paid"` and never on the rail id alone.
 *
 * The end-to-end cycle (bill → pay → refund → re-bill → pay again, both mirror
 * sides, one notification per real payment) is `e2e/money-pipeline.spec.ts` S13,
 * which needs the throwaway CI Postgres.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import { resolveChargeGroup, unwindChargeGroup, type ChargeGroup } from "../src/lib/refund-group";

type RawCall = { sql: string; table: string; ids: string[] };

/**
 * Minimal stand-in for the transaction client `unwindChargeGroup` is handed.
 * `$queryRaw` is a tagged template, so it receives (strings, ...values): the
 * first value is the `Prisma.raw` table name, the second the id array.
 */
function fakeTx(rawResult: (table: string, ids: string[]) => { id: string }[]) {
    const rawCalls: RawCall[] = [];
    const tx = {
        $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
            const table = (values[0] as Prisma.Sql).strings.join("").replace(/"/g, "");
            const ids = values[1] as string[];
            rawCalls.push({ sql: strings.join(" ? "), table, ids });
            return Promise.resolve(rawResult(table, ids));
        },
    };
    return { tx: tx as any, rawCalls };
}

const row = (id: string, parentId: string) => ({ id, name: id, parentId, parentCode: "C-1" });

const group = (over: Partial<ChargeGroup> = {}): ChargeGroup => ({
    estimateSchedules: [],
    invoiceSchedules: [],
    unattributable: [],
    estimateIds: [],
    invoiceIds: [],
    ...over,
});

describe("unwindChargeGroup releases the Stripe rails, not just the status", () => {
    test("the reset statement clears stripeSessionId and stripePaymentIntentId on both tables", async () => {
        // Returning no rows keeps the parent recomputes out of this test — the
        // statement itself is what is being pinned.
        const { tx, rawCalls } = fakeTx(() => []);

        await unwindChargeGroup(tx, group({
            estimateSchedules: [row("eps-1", "est-1")],
            invoiceSchedules: [row("ps-1", "inv-1")],
            estimateIds: ["est-1"],
            invoiceIds: ["inv-1"],
        }));

        assert.deepEqual(
            rawCalls.map((c) => c.table).sort(),
            ["EstimatePaymentSchedule", "PaymentSchedule"],
            "both sides of the mirror are reset",
        );
        for (const call of rawCalls) {
            const sql = call.sql.replace(/\s+/g, " ");
            assert.match(sql, /"status" = 'Pending'/, `${call.table}: status released`);
            assert.match(sql, /"paidAt" = NULL/, `${call.table}: paidAt cleared`);
            assert.match(sql, /"paymentDate" = NULL/, `${call.table}: paymentDate cleared`);
            // The fix. Without these the row is Pending but un-billable.
            assert.match(sql, /"stripeSessionId" = NULL/, `${call.table}: checkout session cleared`);
            assert.match(sql, /"stripePaymentIntentId" = NULL/, `${call.table}: charge link cleared`);
            // Still a claimed update: a row another writer already moved off Paid
            // must not be counted as reset by us.
            assert.match(sql, /"status" = 'Paid'/, `${call.table}: only Paid rows are claimed`);
        }
    });

    test("only rows the statement actually claimed are reported as released", async () => {
        // The invoice row loses its claim (another writer moved it off Paid first).
        const { tx } = fakeTx((table, ids) =>
            table === "EstimatePaymentSchedule" ? ids.map((id) => ({ id })) : [],
        );

        const result = await unwindChargeGroup(tx, group({
            estimateSchedules: [],
            invoiceSchedules: [row("ps-1", "inv-1")],
            invoiceIds: ["inv-1"],
        }));

        assert.deepEqual(result.invoiceSchedules, [], "an unclaimed row is not reported as reset");
    });

    test("no statement is issued for an empty side", async () => {
        const { tx, rawCalls } = fakeTx(() => []);
        await unwindChargeGroup(tx, group({ invoiceSchedules: [row("ps-1", "inv-1")], invoiceIds: ["inv-1"] }));
        assert.deepEqual(rawCalls.map((c) => c.table), ["PaymentSchedule"]);
    });
});

describe("clearing the rails cannot break refund redelivery", () => {
    /**
     * Redelivery safety never depended on the rail id surviving: every lookup in
     * `resolveChargeGroup` is filtered on `status: "Paid"`, so an already-released
     * row was invisible to a second delivery even while it still carried the
     * intent. This asserts that filter is present on both direct lookups, which
     * is what makes clearing safe.
     */
    test("a released (Pending) row carrying the intent is never resolved into the group", async () => {
        const wheres: any[] = [];
        const rows = [
            { id: "eps-1", name: "Deposit", amount: 100, estimateId: "est-1", stripePaymentIntentId: "pi_1", estimate: { code: "E1" } },
        ];
        const db = {
            estimatePaymentSchedule: {
                findMany: ({ where }: any) => {
                    wheres.push(where);
                    return Promise.resolve(where.status === "Paid" ? rows : []);
                },
            },
            paymentSchedule: { findMany: ({ where }: any) => { wheres.push(where); return Promise.resolve([]); } },
        } as any;

        const resolved = await resolveChargeGroup(db, "pi_1");

        assert.equal(resolved.estimateSchedules.length, 1, "a still-Paid row resolves");
        assert.ok(
            wheres.slice(0, 2).every((w) => w.status === "Paid"),
            "both direct lookups filter on Paid, so a released row can never be re-unwound",
        );
    });
});
