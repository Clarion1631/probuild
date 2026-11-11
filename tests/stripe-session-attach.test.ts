/**
 * attachCheckoutSessionIfUnchanged: a Stripe Checkout session is created for the amount read BEFORE the
 * session call, so it may only be attached to the milestone if that amount is still the row's amount.
 * A split / re-price landing in between makes the attach miss. Hermetic: a tiny fake db plus a source
 * tripwire on the create-session route.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { attachCheckoutSessionIfUnchanged } from "../src/lib/stripe-session-attach";

type Row = { id: string; amount: number; status: string; stripeSessionId: string | null };

function fakeDb() {
    const tables: Record<"paymentSchedule" | "estimatePaymentSchedule", Row[]> = { paymentSchedule: [], estimatePaymentSchedule: [] };
    const touched: string[] = [];
    const model = (name: "paymentSchedule" | "estimatePaymentSchedule") => ({
        updateMany: async ({ where, data }: { where: { id: string; amount: unknown; status: { not: string } }; data: { stripeSessionId: string } }) => {
            touched.push(name);
            const hit = tables[name].filter((r) => r.id === where.id && r.amount === where.amount && r.status !== where.status.not);
            for (const r of hit) r.stripeSessionId = data.stripeSessionId;
            return { count: hit.length };
        },
    });
    return { db: { paymentSchedule: model("paymentSchedule"), estimatePaymentSchedule: model("estimatePaymentSchedule") }, tables, touched };
}

test("unchanged row: attaches the session id and returns true", async () => {
    const { db, tables } = fakeDb();
    tables.paymentSchedule.push({ id: "ms-1", amount: 1000, status: "Pending", stripeSessionId: null });
    assert.equal(await attachCheckoutSessionIfUnchanged(db, "invoice", { id: "ms-1", amount: 1000 }, "cs_1"), true);
    assert.equal(tables.paymentSchedule[0].stripeSessionId, "cs_1");
});

test("amount changed since the read: returns false and writes nothing", async () => {
    const { db, tables } = fakeDb();
    tables.paymentSchedule.push({ id: "ms-1", amount: 300, status: "Pending", stripeSessionId: null });
    assert.equal(await attachCheckoutSessionIfUnchanged(db, "invoice", { id: "ms-1", amount: 1000 }, "cs_1"), false);
    assert.equal(tables.paymentSchedule[0].stripeSessionId, null);
});

test("row became Paid: returns false and writes nothing", async () => {
    const { db, tables } = fakeDb();
    tables.estimatePaymentSchedule.push({ id: "eps-1", amount: 1000, status: "Paid", stripeSessionId: null });
    assert.equal(await attachCheckoutSessionIfUnchanged(db, "estimate", { id: "eps-1", amount: 1000 }, "cs_1"), false);
    assert.equal(tables.estimatePaymentSchedule[0].stripeSessionId, null);
});

test("each kind hits its own model", async () => {
    const { db, tables, touched } = fakeDb();
    tables.paymentSchedule.push({ id: "a", amount: 1, status: "Pending", stripeSessionId: null });
    tables.estimatePaymentSchedule.push({ id: "b", amount: 1, status: "Pending", stripeSessionId: null });
    await attachCheckoutSessionIfUnchanged(db, "estimate", { id: "b", amount: 1 }, "cs_e");
    await attachCheckoutSessionIfUnchanged(db, "invoice", { id: "a", amount: 1 }, "cs_i");
    assert.deepEqual(touched, ["estimatePaymentSchedule", "paymentSchedule"]);
    assert.equal(tables.estimatePaymentSchedule[0].stripeSessionId, "cs_e");
    assert.equal(tables.paymentSchedule[0].stripeSessionId, "cs_i");
});

test("create-session route: no unconditional stripeSessionId write; a miss expires the session and returns 409", () => {
    const src = readFileSync(join(process.cwd(), "src/app/api/payments/create-session/route.ts"), "utf8");
    assert.doesNotMatch(src, /\.update\(\{[\s\S]{0,160}?data:\s*\{\s*stripeSessionId/, "an unconditional update writing stripeSessionId is back");
    assert.equal((src.match(/attachCheckoutSessionIfUnchanged\(/g) || []).length, 2, "both branches must use the helper");
    assert.equal((src.match(/checkout\.sessions\.expire\(/g) || []).length, 2, "both miss paths must expire the stale session");
    assert.equal((src.match(/status: 409/g) || []).length, 2);
});
