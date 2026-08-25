import assert from "node:assert/strict";
import test from "node:test";
import { buildCommercialSidingQboEvidence, assertReadOnlyQboRequest } from "../src/lib/commercial-siding-qbo-evidence";
import {
    createCommercialSidingQboEvidenceHandlers,
    HEAD,
    OPTIONS,
} from "../src/app/api/automation/commercial-siding-qbo-evidence/route";

const EXPECTED_CANDIDATES = [
    "INV-00321", "INV-00321-1", "INV-00321-2", "INV-00321-3",
    "INV-00246", "INV-00246-1", "INV-00246-2", "INV-00246-3",
];

test("commercial-siding QBO evidence keeps only exact candidate invoices for April Velilla", async () => {
    const queried: string[] = [];
    const evidence = await buildCommercialSidingQboEvidence({
        queryInvoices: async (docNumber) => {
            queried.push(docNumber);
            if (docNumber !== "INV-00321") return [];
            return [
                {
                    Id: "invoice-321",
                    DocNumber: "INV-00321",
                    TxnDate: "2026-08-20",
                    CustomerRef: { value: "customer-april", name: "April Velilla" },
                    TotalAmt: 9302.4,
                    Balance: 6511.68,
                    PrivateNote: "Commercial Siding source",
                    CustomerMemo: { value: "Milestone invoice" },
                    TxnSource: "INTUIT",
                    LinkedTxn: [{ TxnId: "payment-6279", TxnType: "Payment" }],
                },
                { Id: "wrong-customer", DocNumber: "INV-00321", CustomerRef: { name: "Someone Else" }, TotalAmt: 9302.4, Balance: 6511.68 },
                { Id: "wrong-customer-case", DocNumber: "INV-00321", CustomerRef: { name: "APRIL VELILLA" }, TotalAmt: 9302.4, Balance: 6511.68 },
                { Id: "wrong-customer-whitespace", DocNumber: "INV-00321", CustomerRef: { name: " April Velilla " }, TotalAmt: 9302.4, Balance: 6511.68 },
                { Id: "wrong-doc", DocNumber: "INV-99999", CustomerRef: { name: "April Velilla" }, TotalAmt: 9302.4, Balance: 6511.68 },
            ];
        },
        readPayment: async () => null,
        now: () => new Date("2026-08-24T23:00:00.000Z"),
    });

    assert.deepEqual(queried, EXPECTED_CANDIDATES);
    assert.deepEqual(evidence.candidates.find(row => row.docNumber === "INV-00321"), {
        docNumber: "INV-00321",
        matchState: "matched",
        invoices: [{
            id: "invoice-321",
            docNumber: "INV-00321",
            txnDate: "2026-08-20",
            customer: { id: "customer-april", name: "April Velilla" },
            totalCents: 930240,
            balanceCents: 651168,
            status: "partially-paid",
            voidState: "not-voided",
            privateNote: "Commercial Siding source",
            memo: "Milestone invoice",
            source: "INTUIT",
            linkedTxnPaymentIds: ["payment-6279"],
            payments: [],
            unverifiedLinkedPaymentIds: ["payment-6279"],
        }],
    });
});

test("commercial-siding QBO evidence explicitly reports every candidate with no verified QBO match", async () => {
    const evidence = await buildCommercialSidingQboEvidence({
        queryInvoices: async () => [],
        readPayment: async () => null,
        now: () => new Date("2026-08-24T23:00:00.000Z"),
    });

    assert.equal(evidence.verifiedAt, "2026-08-24T23:00:00.000Z");
    assert.deepEqual(
        evidence.candidates.map(row => [row.docNumber, row.matchState, row.invoices]),
        EXPECTED_CANDIDATES.map(docNumber => [docNumber, "no-verified-qbo-match", []]),
    );
});

test("commercial-siding QBO evidence reports no match when QBO returns only a near customer name", async () => {
    const evidence = await buildCommercialSidingQboEvidence({
        queryInvoices: async (docNumber) => docNumber === "INV-00246-3" ? [{
            Id: "near-customer-only",
            DocNumber: "INV-00246-3",
            CustomerRef: { name: " april velilla " },
            TotalAmt: 1,
            Balance: 1,
        }] : [],
        readPayment: async () => null,
        now: () => new Date("2026-08-24T23:00:00.000Z"),
    });

    assert.deepEqual(evidence.candidates.find(row => row.docNumber === "INV-00246-3"), {
        docNumber: "INV-00246-3",
        matchState: "no-verified-qbo-match",
        invoices: [],
    });
});

test("commercial-siding QBO evidence attaches linked payment facts and only the invoice's applied line cents", async () => {
    const evidence = await buildCommercialSidingQboEvidence({
        queryInvoices: async (docNumber) => docNumber === "INV-00246" ? [{
            Id: "invoice-246",
            DocNumber: "INV-00246",
            CustomerRef: { value: "customer-april", name: "April Velilla" },
            TotalAmt: 9302.4,
            Balance: 0,
            LinkedTxn: [{ TxnId: "payment-6279", TxnType: "Payment" }, { TxnId: "credit-1", TxnType: "CreditMemo" }],
        }] : [],
        readPayment: async (paymentId) => paymentId === "payment-6279" ? {
            Id: "payment-6279",
            TxnDate: "2026-07-23",
            TotalAmt: 2793.29,
            Line: [
                { Amount: 2790.72, LinkedTxn: [{ TxnId: "invoice-246", TxnType: "Invoice" }] },
                { Amount: 2.57, LinkedTxn: [{ TxnId: "other-invoice", TxnType: "Invoice" }] },
            ],
        } : null,
        now: () => new Date("2026-08-24T23:00:00.000Z"),
    });

    const invoice = evidence.candidates.find(row => row.docNumber === "INV-00246")?.invoices[0];
    assert.deepEqual(invoice?.linkedTxnPaymentIds, ["payment-6279"]);
    assert.deepEqual(invoice?.payments, [{
        id: "payment-6279",
        txnDate: "2026-07-23",
        totalCents: 279329,
        appliedLineAmountsCents: [279072],
    }]);
});

test("commercial-siding QBO evidence treats zero-dollar invoices with any linked transaction as status unknown", async () => {
    const evidence = await buildCommercialSidingQboEvidence({
        queryInvoices: async (docNumber) => docNumber === "INV-00246-1" ? [{
            Id: "invoice-zero-with-credit",
            DocNumber: "INV-00246-1",
            CustomerRef: { name: "April Velilla" },
            TotalAmt: 0,
            Balance: 0,
            LinkedTxn: [{ TxnId: "credit-1", TxnType: "CreditMemo" }],
        }, {
            Id: "invoice-zero-with-payment",
            DocNumber: "INV-00246-1",
            CustomerRef: { name: "April Velilla" },
            TotalAmt: 0,
            Balance: 0,
            LinkedTxn: [{ TxnId: "payment-1", TxnType: "Payment" }],
        }] : [],
        readPayment: async (paymentId) => ({ Id: paymentId, TotalAmt: 0 }),
        now: () => new Date("2026-08-24T23:00:00.000Z"),
    });

    const invoices = evidence.candidates.find(row => row.docNumber === "INV-00246-1")?.invoices;
    assert.deepEqual(invoices?.map(invoice => invoice ? [invoice.status, invoice.voidState] : null), [
        ["unknown", "unknown"],
        ["unknown", "unknown"],
    ]);
});

test("commercial-siding QBO evidence converts finite amounts to integer cents and marks malformed amounts unknown", async () => {
    const evidence = await buildCommercialSidingQboEvidence({
        queryInvoices: async (docNumber) => docNumber === "INV-00321-1" ? [{
            Id: "invoice-fraction",
            DocNumber: "INV-00321-1",
            CustomerRef: { name: "April Velilla" },
            TotalAmt: 1.005,
            Balance: "not-a-number",
        }] : [],
        readPayment: async () => null,
        now: () => new Date("2026-08-24T23:00:00.000Z"),
    });

    const invoice = evidence.candidates.find(row => row.docNumber === "INV-00321-1")?.invoices[0];
    assert.equal(invoice?.totalCents, 101);
    assert.equal(invoice?.balanceCents, null);
});

test("commercial-siding QBO evidence never turns incomplete QBO amounts into paid or voided evidence", async () => {
    const evidence = await buildCommercialSidingQboEvidence({
        queryInvoices: async (docNumber) => docNumber === "INV-00321-2" ? [{
            Id: "invoice-blank-amounts",
            DocNumber: "INV-00321-2",
            CustomerRef: { name: "April Velilla" },
            TotalAmt: " ",
            Balance: 0,
        }] : [],
        readPayment: async () => null,
        now: () => new Date("2026-08-24T23:00:00.000Z"),
    });

    const invoice = evidence.candidates.find(row => row.docNumber === "INV-00321-2")?.invoices[0];
    assert.equal(invoice?.totalCents, null);
    assert.equal(invoice?.balanceCents, 0);
    assert.equal(invoice?.status, "unknown");
    assert.equal(invoice?.voidState, "unknown");
});

test("commercial-siding QBO evidence stays unknown when Balance is missing", async () => {
    const evidence = await buildCommercialSidingQboEvidence({
        queryInvoices: async (docNumber) => docNumber === "INV-00321-3" ? [{
            Id: "invoice-missing-balance",
            DocNumber: "INV-00321-3",
            CustomerRef: { name: "April Velilla" },
            TotalAmt: 1,
            Balance: "",
        }] : [],
        readPayment: async () => null,
        now: () => new Date("2026-08-24T23:00:00.000Z"),
    });

    const invoice = evidence.candidates.find(row => row.docNumber === "INV-00321-3")?.invoices[0];
    assert.equal(invoice?.status, "unknown");
    assert.equal(invoice?.voidState, "unknown");
});

test("commercial-siding QBO evidence read-only guard rejects writes and request bodies", () => {
    assert.deepEqual(assertReadOnlyQboRequest(), { method: "GET" });
    assert.throws(() => assertReadOnlyQboRequest({ method: "POST" }), /read-only/i);
    assert.throws(() => assertReadOnlyQboRequest({ method: "GET", body: "{}" }), /read-only/i);
    for (const method of ["PUT", "PATCH", "DELETE"]) {
        assert.throws(() => assertReadOnlyQboRequest({ method }), /read-only/i);
    }
});

test("commercial-siding QBO evidence endpoint fails closed on auth and only invokes read dependencies", async () => {
    let queryCalls = 0;
    let tokenCalls = 0;
    const makeHandlers = (user: { role: string; permissions?: { financialReports?: boolean } } | null) =>
        createCommercialSidingQboEvidenceHandlers({
            getCurrentUser: async () => user,
            canReadFinancialEvidence: candidate => candidate?.role === "ADMIN" || candidate?.permissions?.financialReports === true,
            getReadOnlyTokens: async () => {
                tokenCalls++;
                return { accessToken: "test-access", refreshToken: "test-refresh", realmId: "test-realm" };
            },
            queryInvoices: async () => {
                queryCalls++;
                return [];
            },
            readPayment: async () => null,
            now: () => new Date("2026-08-24T23:00:00.000Z"),
        });

    const unauthorized = await makeHandlers(null).GET();
    assert.equal(unauthorized.status, 401);
    assert.equal(queryCalls, 0);
    assert.equal(tokenCalls, 0);

    const forbidden = await makeHandlers({ role: "FIELD_CREW" }).GET();
    assert.equal(forbidden.status, 403);
    assert.equal(queryCalls, 0);
    assert.equal(tokenCalls, 0);

    const allowedHandlers = makeHandlers({ role: "FINANCE", permissions: { financialReports: true } });
    const allowed = await allowedHandlers.GET();
    assert.equal(allowed.status, 200);
    assert.equal((await allowed.json()).ok, true);
    assert.equal(tokenCalls, 1);
    assert.equal(queryCalls, EXPECTED_CANDIDATES.length);

    const callsBeforeMethodRejections = { queryCalls, tokenCalls };
    assert.equal((await allowedHandlers.HEAD()).status, 405);
    assert.equal((await allowedHandlers.OPTIONS()).status, 405);
    assert.deepEqual({ queryCalls, tokenCalls }, callsBeforeMethodRejections);
});

test("commercial-siding QBO evidence endpoint rejects HEAD and OPTIONS without invoking its GET path", async () => {
    const head = await HEAD();
    const options = await OPTIONS();
    assert.equal(head.status, 405);
    assert.equal(options.status, 405);
    assert.equal(head.headers.get("allow"), "GET");
    assert.equal(options.headers.get("allow"), "GET");
});
