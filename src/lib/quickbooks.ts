/**
 * QuickBooks Online API client.
 * Uses OAuth2 tokens stored in integration-store.
 * Docs: https://developer.intuit.com/app/developer/qbo/docs/api/accounting
 */

const QB_API_BASE = process.env.QB_SANDBOX === "true"
    ? "https://sandbox-quickbooks.api.intuit.com/v3/company"
    : "https://quickbooks.api.intuit.com/v3/company";

const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";

export interface QBTokens {
    accessToken: string;
    refreshToken: string;
    realmId: string;
}

/** Exchange authorization code for tokens */
export async function exchangeQBCode(code: string, redirectUri: string): Promise<QBTokens> {
    const clientId = process.env.QB_CLIENT_ID!;
    const clientSecret = process.env.QB_CLIENT_SECRET!;
    const encoded = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

    const res = await fetch(TOKEN_URL, {
        method: "POST",
        headers: {
            Authorization: `Basic ${encoded}`,
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
        },
        body: new URLSearchParams({
            grant_type: "authorization_code",
            code,
            redirect_uri: redirectUri,
        }),
    });

    if (!res.ok) {
        const err = await res.text();
        throw new Error(`QB token exchange failed: ${err}`);
    }

    const data = await res.json();
    return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        realmId: "", // set from callback query param
    };
}

/** Refresh an expired access token */
export async function refreshQBToken(refreshToken: string): Promise<{ accessToken: string; refreshToken: string }> {
    const clientId = process.env.QB_CLIENT_ID!;
    const clientSecret = process.env.QB_CLIENT_SECRET!;
    const encoded = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

    const res = await fetch(TOKEN_URL, {
        method: "POST",
        headers: {
            Authorization: `Basic ${encoded}`,
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
        },
        body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: refreshToken,
        }),
    });

    if (!res.ok) throw new Error("QB token refresh failed");
    const data = await res.json();
    return { accessToken: data.access_token, refreshToken: data.refresh_token };
}

/** Make an authenticated call to the QB API, auto-refreshing if needed */
async function qbFetch(
    path: string,
    tokens: QBTokens,
    opts: RequestInit = {}
): Promise<Response> {
    const url = `${QB_API_BASE}/${tokens.realmId}${path}?minorversion=73`;
    return fetch(url, {
        ...opts,
        headers: {
            Authorization: `Bearer ${tokens.accessToken}`,
            Accept: "application/json",
            "Content-Type": "application/json",
            ...opts.headers,
        },
    });
}

/** Run a QBO SQL-ish query (https://developer.intuit.com/.../data-queries) */
async function qbQuery<T = any>(tokens: QBTokens, query: string): Promise<T[]> {
    const url = `${QB_API_BASE}/${tokens.realmId}/query?query=${encodeURIComponent(query)}&minorversion=73`;
    const res = await fetch(url, {
        headers: {
            Authorization: `Bearer ${tokens.accessToken}`,
            Accept: "application/json",
        },
    });
    if (!res.ok) {
        const err = await res.text();
        throw new Error(`QB query failed: ${err}`);
    }
    const data = await res.json();
    const response = data.QueryResponse || {};
    const key = Object.keys(response).find(k => Array.isArray(response[k]));
    return key ? response[key] : [];
}

function escapeQBString(s: string): string {
    return s.replace(/'/g, "\\'");
}

/** Find a QBO customer by display name, creating it if missing. Returns the QBO customer Id. */
export async function ensureQBCustomer(
    tokens: QBTokens,
    client: { name: string; email?: string | null; qbCustomerId?: string | null }
): Promise<string> {
    // Trust a previously stored id if it still exists
    if (client.qbCustomerId) {
        const existing = await qbQuery(tokens, `SELECT Id FROM Customer WHERE Id = '${escapeQBString(client.qbCustomerId)}'`);
        if (existing.length > 0) return client.qbCustomerId;
    }

    const byName = await qbQuery(tokens, `SELECT Id FROM Customer WHERE DisplayName = '${escapeQBString(client.name)}'`);
    if (byName.length > 0) return byName[0].Id;

    const res = await qbFetch("/customer", tokens, {
        method: "POST",
        body: JSON.stringify({
            DisplayName: client.name,
            ...(client.email ? { PrimaryEmailAddr: { Address: client.email } } : {}),
        }),
    });
    if (!res.ok) {
        const err = await res.text();
        throw new Error(`QB customer create failed: ${err}`);
    }
    const data = await res.json();
    return data.Customer.Id;
}

const QB_SERVICE_ITEM_NAME = "Construction Services";

/** Find or create the Service item used for all ProBuild invoice lines. */
export async function ensureQBServiceItem(tokens: QBTokens): Promise<string> {
    const items = await qbQuery(tokens, `SELECT Id FROM Item WHERE Name = '${escapeQBString(QB_SERVICE_ITEM_NAME)}'`);
    if (items.length > 0) return items[0].Id;

    // Need an income account to hang the item on — prefer an existing Income account.
    const accounts = await qbQuery(tokens, `SELECT Id, Name FROM Account WHERE AccountType = 'Income' MAXRESULTS 1`);
    let incomeAccountId: string;
    if (accounts.length > 0) {
        incomeAccountId = accounts[0].Id;
    } else {
        const created = await qbFetch("/account", tokens, {
            method: "POST",
            body: JSON.stringify({ Name: "Construction Income", AccountType: "Income", AccountSubType: "ServiceFeeIncome" }),
        });
        if (!created.ok) throw new Error(`QB income account create failed: ${await created.text()}`);
        incomeAccountId = (await created.json()).Account.Id;
    }

    const res = await qbFetch("/item", tokens, {
        method: "POST",
        body: JSON.stringify({
            Name: QB_SERVICE_ITEM_NAME,
            Type: "Service",
            IncomeAccountRef: { value: incomeAccountId },
        }),
    });
    if (!res.ok) throw new Error(`QB service item create failed: ${await res.text()}`);
    return (await res.json()).Item.Id;
}

/**
 * Create a QBO invoice for ONE payment milestone, with QuickBooks Payments
 * (card + ACH) enabled so the customer gets Intuit's hosted "Review & Pay" page.
 */
export async function createQBMilestoneInvoice(
    tokens: QBTokens,
    input: {
        docNumber: string; // ≤ 21 chars
        customerId: string;
        itemId: string;
        description: string;
        amount: number;
        dueDate?: Date | null;
        billEmail?: string | null;
        privateNote?: string;
    }
): Promise<{ qbId: string; qbUrl: string }> {
    const payload: Record<string, unknown> = {
        DocNumber: input.docNumber.slice(0, 21),
        TxnDate: new Date().toISOString().split("T")[0],
        CustomerRef: { value: input.customerId },
        // Bank-transfer ONLY on the QuickBooks hosted page (free for the client).
        // Card payments are deliberately routed through Stripe instead, where the
        // 2.9% processing fee is passed to the client — QBO can't surcharge cards.
        AllowOnlineCreditCardPayment: false,
        AllowOnlineACHPayment: true,
        ...(input.billEmail ? { BillEmail: { Address: input.billEmail } } : {}),
        ...(input.dueDate ? { DueDate: input.dueDate.toISOString().split("T")[0] } : {}),
        ...(input.privateNote ? { PrivateNote: input.privateNote.slice(0, 4000) } : {}),
        Line: [
            {
                LineNum: 1,
                Description: input.description.slice(0, 4000),
                Amount: input.amount,
                DetailType: "SalesItemLineDetail",
                SalesItemLineDetail: {
                    ItemRef: { value: input.itemId },
                    Qty: 1,
                    UnitPrice: input.amount,
                },
            },
        ],
    };

    const res = await qbFetch("/invoice", tokens, { method: "POST", body: JSON.stringify(payload) });
    if (!res.ok) throw new Error(`QB milestone invoice create failed: ${await res.text()}`);
    const data = await res.json();
    const qbId = data.Invoice?.Id;
    return { qbId, qbUrl: `https://app.qbo.intuit.com/app/invoice?txnId=${qbId}` };
}

/** Fetch the customer-facing payment link for a QBO invoice (requires QB Payments enabled). */
export async function getQBInvoicePaymentLink(tokens: QBTokens, qbInvoiceId: string): Promise<string | null> {
    const url = `${QB_API_BASE}/${tokens.realmId}/invoice/${qbInvoiceId}?include=invoiceLink&minorversion=73`;
    const res = await fetch(url, {
        headers: { Authorization: `Bearer ${tokens.accessToken}`, Accept: "application/json" },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.Invoice?.InvoiceLink || null;
}

export interface QBInvoiceStatus {
    balance: number;
    total: number;
    paymentTxnIds: string[];
}

/** Read a QBO invoice's balance + linked payment transactions. */
export async function getQBInvoiceStatus(tokens: QBTokens, qbInvoiceId: string): Promise<QBInvoiceStatus | null> {
    const res = await qbFetch(`/invoice/${qbInvoiceId}`, tokens, { method: "GET" });
    if (!res.ok) return null;
    const data = await res.json();
    const inv = data.Invoice;
    if (!inv) return null;
    const paymentTxnIds: string[] = (inv.LinkedTxn || [])
        .filter((t: any) => t.TxnType === "Payment")
        .map((t: any) => String(t.TxnId));
    return { balance: Number(inv.Balance ?? 0), total: Number(inv.TotalAmt ?? 0), paymentTxnIds };
}

/** Read a QBO payment (date / amount / reference) for receipt details. */
export async function getQBPayment(
    tokens: QBTokens,
    paymentId: string
): Promise<{ txnDate: string | null; amount: number; referenceNumber: string | null } | null> {
    const res = await qbFetch(`/payment/${paymentId}`, tokens, { method: "GET" });
    if (!res.ok) return null;
    const data = await res.json();
    const p = data.Payment;
    if (!p) return null;
    return {
        txnDate: p.TxnDate || null,
        amount: Number(p.TotalAmt ?? 0),
        referenceNumber: p.PaymentRefNum || null,
    };
}

/** Push an estimate to QB. Returns the QB estimate ID. */
export async function syncEstimateToQB(
    tokens: QBTokens,
    estimate: {
        id: string;
        code: string;
        title: string;
        totalAmount: number;
        items: Array<{ name: string; quantity: number; unitCost: number; total: number; type: string }>;
        customerId: string;
        itemId: string;
        project: { name: string } | null;
    },
    glMappings: Record<string, string> = {}
): Promise<{ qbId: string; qbUrl: string }> {
    // Build QB Estimate payload
    const lines = estimate.items.map((item, i) => ({
        LineNum: i + 1,
        Description: item.name,
        Amount: item.total,
        DetailType: "SalesItemLineDetail",
        SalesItemLineDetail: {
            ItemRef: { value: estimate.itemId },
            Qty: item.quantity,
            UnitPrice: item.unitCost,
        },
    }));

    const payload = {
        TxnDate: new Date().toISOString().split("T")[0],
        DocNumber: estimate.code.slice(0, 21),
        PrivateNote: estimate.title,
        CustomerRef: { value: estimate.customerId },
        Line: lines,
    };

    const res = await qbFetch("/estimate", tokens, {
        method: "POST",
        body: JSON.stringify(payload),
    });

    if (!res.ok) {
        const err = await res.text();
        throw new Error(`QB estimate sync failed: ${err}`);
    }

    const data = await res.json();
    const qbId = data.Estimate?.Id;
    const realmId = tokens.realmId;
    const qbUrl = `https://app.qbo.intuit.com/app/estimate?txnId=${qbId}`;

    return { qbId, qbUrl };
}

/** Push an invoice to QB. Returns the QB invoice ID. */
export async function syncInvoiceToQB(
    tokens: QBTokens,
    invoice: {
        code: string;
        totalAmount: number;
        balanceDue: number;
        customerId: string;
        itemId: string;
        project: { name: string } | null;
        items?: Array<{ description: string; amount: number }>;
    }
): Promise<{ qbId: string; qbUrl: string }> {
    const lines: object[] = (invoice.items || []).map((item, i) => ({
        LineNum: i + 1,
        Description: item.description,
        Amount: item.amount,
        DetailType: "SalesItemLineDetail",
        SalesItemLineDetail: { ItemRef: { value: invoice.itemId }, Qty: 1, UnitPrice: item.amount },
    }));

    if (lines.length === 0) {
        lines.push({
            LineNum: 1,
            Description: invoice.project?.name || "Construction Services",
            Amount: invoice.totalAmount,
            DetailType: "SalesItemLineDetail",
            SalesItemLineDetail: { ItemRef: { value: invoice.itemId }, Qty: 1, UnitPrice: invoice.totalAmount },
        });
    }

    const payload = {
        DocNumber: invoice.code.slice(0, 21),
        TxnDate: new Date().toISOString().split("T")[0],
        CustomerRef: { value: invoice.customerId },
        Line: lines,
    };

    const res = await qbFetch("/invoice", tokens, {
        method: "POST",
        body: JSON.stringify(payload),
    });

    if (!res.ok) {
        const err = await res.text();
        throw new Error(`QB invoice sync failed: ${err}`);
    }

    const data = await res.json();
    const qbId = data.Invoice?.Id;
    const qbUrl = `https://app.qbo.intuit.com/app/invoice?txnId=${qbId}`;
    return { qbId, qbUrl };
}
