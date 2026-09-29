/**
 * The one list of "this must block a cascade delete" cases, shared by
 * tests/delete-projects-money-guard.test.ts and tests/delete-client-money-guard.test.ts
 * so the two lists cannot drift. Neutral fixture names only (public repo).
 */
import {
    CREATE_IN_FLIGHT_MARKER,
    AMBIGUOUS_CREATE_MARKER,
    composeCreateMarker,
} from "../../src/lib/qbo-create-markers";

export type World = {
    inv: Record<string, any>;
    milestone: Record<string, any>;
    billing: Record<string, any>;
    retainer: Record<string, any>;
    coBilledInvoiceIds: string[];
};

export type DeleteBlockerCase = {
    name: string;
    apply: (w: World) => void;
    clause: string;
    subject: "invoice" | "retainer";
};

const identity = { docNumber: "INV-A1-2", privateNote: "ProBuild INV-A1 - Deposit" };
const QBO_MILESTONE = 'is linked or pending in QuickBooks (milestone "Deposit")';
const STRIPE_REVERSED = 'has a Stripe payment that was later marked unpaid (milestone "Deposit")';
const STRIPE_OPEN = 'has a Stripe checkout that may still be payable (milestone "Deposit")';

export const DELETE_BLOCKER_CASES: DeleteBlockerCase[] = [
    { name: "paid milestone", apply: (w) => { w.milestone.status = "Paid"; }, clause: "has recorded payments", subject: "invoice" },
    { name: "invoice Paid", apply: (w) => { w.inv.status = "Paid"; }, clause: "is paid or partially paid", subject: "invoice" },
    { name: "invoice Partially Paid", apply: (w) => { w.inv.status = "Partially Paid"; }, clause: "is paid or partially paid", subject: "invoice" },
    { name: "change-order billing", apply: (w) => { w.coBilledInvoiceIds = [w.inv.id]; }, clause: "has change-order billing", subject: "invoice" },
    { name: "QBO-linked milestone", apply: (w) => { w.milestone.qbInvoiceId = "qb-1"; }, clause: QBO_MILESTONE, subject: "invoice" },
    { name: "create in flight", apply: (w) => { w.milestone.qbSyncError = CREATE_IN_FLIGHT_MARKER; }, clause: QBO_MILESTONE, subject: "invoice" },
    { name: "ambiguous create", apply: (w) => { w.milestone.qbSyncError = composeCreateMarker(AMBIGUOUS_CREATE_MARKER, identity); }, clause: QBO_MILESTONE, subject: "invoice" },
    { name: "QBO-linked billing", apply: (w) => { w.billing.qbInvoiceId = "qb-2"; }, clause: 'is linked or pending in QuickBooks (progress billing "INV-A1-P1")', subject: "invoice" },
    { name: "invoice qbInvoiceId", apply: (w) => { w.inv.qbInvoiceId = "qb-3"; }, clause: "is linked or pending in QuickBooks", subject: "invoice" },
    { name: "invoice ambiguous marker", apply: (w) => { w.inv.qbSyncMarker = AMBIGUOUS_CREATE_MARKER; }, clause: "is linked or pending in QuickBooks", subject: "invoice" },
    { name: "Stripe PaymentIntent only", apply: (w) => { w.milestone.stripePaymentIntentId = "pi_test_1"; }, clause: STRIPE_REVERSED, subject: "invoice" },
    { name: "Stripe PaymentIntent and session", apply: (w) => { w.milestone.stripePaymentIntentId = "pi_test_1"; w.milestone.stripeSessionId = "cs_test_1"; }, clause: STRIPE_REVERSED, subject: "invoice" },
    { name: "Stripe session only", apply: (w) => { w.milestone.stripeSessionId = "cs_test_1"; }, clause: STRIPE_OPEN, subject: "invoice" },
    { name: "Canceled milestone with session", apply: (w) => { w.milestone.status = "Canceled"; w.milestone.stripeSessionId = "cs_test_1"; }, clause: STRIPE_OPEN, subject: "invoice" },
    { name: "retainer Paid", apply: (w) => { w.retainer.status = "Paid"; }, clause: "is marked Paid", subject: "retainer" },
    { name: "retainer Partially Paid", apply: (w) => { w.retainer.status = "Partially Paid"; }, clause: "is marked Partially Paid", subject: "retainer" },
    { name: "legacy retainer amount", apply: (w) => { w.retainer.status = "Sent"; w.retainer.amountPaid = 50; }, clause: "has a recorded payment", subject: "retainer" },
];
