type AttachModel = {
    // eslint-disable-next-line no-unused-vars
    updateMany(args: {
        where: { id: string; amount: any; status: { not: string } }; // eslint-disable-line @typescript-eslint/no-explicit-any
        data: { stripeSessionId: string };
    }): Promise<{ count: number }>;
};

/**
 * Attach a freshly created Stripe Checkout session to the milestone it was created for, but ONLY if
 * the milestone still has the amount the session was created for (and is not Paid).
 *
 * create-session reads the milestone with no lock, builds the session for that amount, and only then
 * records the session id. A split ("Partial payment") or an "Edit amounts" re-price can commit in
 * between, while both stripe fields are still null; an unconditional write would then pin the
 * old-amount session to the now-smaller row, and the client would pay the old amount while the webhook
 * credits only the row's current amount. This write is a conditional update on the same row the split's
 * own pinned claim updates, so the two serialize and exactly one of them wins. `false` means the row
 * changed: the caller must expire the session and not hand out its URL.
 */
export async function attachCheckoutSessionIfUnchanged(
    db: { paymentSchedule: AttachModel; estimatePaymentSchedule: AttachModel },
    kind: "invoice" | "estimate",
    row: { id: string; amount: unknown },
    stripeSessionId: string,
): Promise<boolean> {
    const model = kind === "estimate" ? db.estimatePaymentSchedule : db.paymentSchedule;
    const { count } = await model.updateMany({
        where: { id: row.id, amount: row.amount, status: { not: "Paid" } },
        data: { stripeSessionId },
    });
    return count === 1;
}
