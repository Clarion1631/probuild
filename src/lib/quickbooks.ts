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

export interface QBAttachable {
    Id?: string;
    FileName?: string;
    ContentType?: string;
    Size?: number;
    TempDownloadUri?: string;
    AttachableRef?: Array<{ EntityRef?: { value?: string; type?: string } }>;
}

/** List file attachments linked to a QBO Purchase (receipt images/PDFs). */
export async function getQBPurchaseAttachables(
    tokens: QBTokens,
    purchaseId: string,
): Promise<QBAttachable[]> {
    // QBO transaction ids are numeric; refuse anything else rather than escape it.
    if (!/^\d+$/.test(purchaseId)) return [];
    const rows = await qbQuery<QBAttachable>(
        tokens,
        `SELECT * FROM attachable WHERE AttachableRef.EntityRef.value = '${purchaseId}'`,
    );
    // Entity ids are only unique per entity type, so the value-only query can
    // surface attachments from other transaction types — keep Purchase links.
    return rows.filter(row =>
        row.AttachableRef?.some(
            ref =>
                ref.EntityRef?.value === purchaseId &&
                /^purchase$/i.test(ref.EntityRef?.type ?? ""),
        ),
    );
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

    const name = client.name.trim();
    if (!name) throw new Error("Client name is empty — cannot sync customer to QuickBooks.");
    const byName = await qbQuery(tokens, `SELECT Id FROM Customer WHERE DisplayName = '${escapeQBString(name)}'`);
    if (byName.length > 0) return byName[0].Id;

    // QBO normalizes whitespace when enforcing DisplayName uniqueness, so an
    // exact match can miss while create still rejects as a duplicate (fault 6240).
    // Prefix on the first word only, so internal-whitespace variants still match.
    const normalize = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
    const prefix = name.split(/\s+/)[0];
    const candidates = await qbQuery<{ Id: string; DisplayName?: string }>(
        tokens,
        `SELECT Id, DisplayName FROM Customer WHERE DisplayName LIKE '${escapeQBString(prefix)}%' MAXRESULTS 1000`
    );
    const matches = candidates.filter(c => normalize(c.DisplayName ?? "") === normalize(name));
    if (matches.length > 1) {
        throw new Error(`QB customer lookup for "${name}" matched ${matches.length} customers — resolve the duplicate in QuickBooks.`);
    }
    if (matches.length === 1) return matches[0].Id;

    const res = await qbFetch("/customer", tokens, {
        method: "POST",
        body: JSON.stringify({
            DisplayName: name,
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
        amount: number; // grand total the client pays (tax-inclusive)
        // When set, the QBO invoice carries the sales tax explicitly:
        // a pre-tax taxable line + TxnTaxDetail, so QBO's sales-tax reporting
        // sees the liability and the invoice total still equals `amount`.
        tax?: { preTaxAmount: number; taxAmount: number } | null;
        dueDate?: Date | null;
        billEmail?: string | null;
        privateNote?: string;
    }
): Promise<{ qbId: string; qbUrl: string; total: number }> {
    const withTax = !!input.tax && input.tax.taxAmount > 0;
    const lineAmount = withTax ? input.tax!.preTaxAmount : input.amount;

    const payload: Record<string, unknown> = {
        DocNumber: input.docNumber.slice(0, 21),
        TxnDate: new Date().toISOString().split("T")[0],
        CustomerRef: { value: input.customerId },
        // QuickBooks Payments is the ONLY payment rail (Stripe is disabled until
        // their 180-day hold clears) — the hosted page takes card, debit, AND bank.
        // Note: Intuit can't surcharge, so card fees are merchant-absorbed.
        AllowOnlineCreditCardPayment: true,
        AllowOnlineACHPayment: true,
        ...(input.billEmail ? { BillEmail: { Address: input.billEmail } } : {}),
        ...(input.dueDate ? { DueDate: input.dueDate.toISOString().split("T")[0] } : {}),
        ...(input.privateNote ? { PrivateNote: input.privateNote.slice(0, 4000) } : {}),
        Line: [
            {
                LineNum: 1,
                Description: input.description.slice(0, 4000),
                Amount: lineAmount,
                DetailType: "SalesItemLineDetail",
                SalesItemLineDetail: {
                    ItemRef: { value: input.itemId },
                    Qty: 1,
                    UnitPrice: lineAmount,
                    ...(withTax ? { TaxCodeRef: { value: "TAX" } } : {}),
                },
            },
        ],
        ...(withTax ? { TxnTaxDetail: { TotalTax: input.tax!.taxAmount } } : {}),
    };

    const res = await qbFetch("/invoice", tokens, { method: "POST", body: JSON.stringify(payload) });
    if (!res.ok) throw new Error(`QB milestone invoice create failed: ${await res.text()}`);
    const data = await res.json();
    const qbId = data.Invoice?.Id;
    const total = Number(data.Invoice?.TotalAmt ?? 0);
    return { qbId, qbUrl: `https://app.qbo.intuit.com/app/invoice?txnId=${qbId}`, total };
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

/**
 * Result of probing a QBO invoice's existence + payable state.
 * Unlike getQBInvoiceStatus (which collapses every failure into null), this
 * distinguishes a permanently gone/voided invoice from a transient API error,
 * so the sync poller can flag stuck milestones without acting on a blip.
 */
export type QBInvoiceProbe =
    | { state: "ok"; balance: number; total: number; paymentTxnIds: string[] }
    | { state: "voided" } // HTTP 200, exists, total & balance === 0, no linked payments
    | { state: "notFound" } // HTTP 400 Fault 610 or HTTP 404 (authoritative "gone" only)
    | { state: "error"; status: number }; // 401/429/5xx/network/malformed — transient, never act on

/**
 * Probe a QBO invoice and classify it. QBO's behavior for gone invoices is
 * inconsistent: a *voided* invoice returns 200 with TotalAmt=0; a *deleted* one
 * may return 400 + Fault code 610 ("Object Not Found"), a 404, or even 200 with
 * stale data. This folds all of those into a single discriminated result.
 */
export async function probeQBInvoice(tokens: QBTokens, qbInvoiceId: string): Promise<QBInvoiceProbe> {
    let res: Response;
    try {
        res = await qbFetch(`/invoice/${qbInvoiceId}`, tokens, { method: "GET" });
    } catch {
        return { state: "error", status: 0 };
    }
    if (res.ok) {
        // A 200 should always carry an Invoice. A parse failure or a missing payload
        // is anomalous — treat it as transient (never as "gone"); only an explicit
        // 404/610 below is authoritative for notFound.
        let data: any;
        try {
            data = await res.json();
        } catch {
            return { state: "error", status: res.status };
        }
        const inv = data?.Invoice;
        if (!inv) return { state: "error", status: res.status };
        const total = Number(inv.TotalAmt);
        const balance = Number(inv.Balance);
        // A well-formed invoice always carries numeric TotalAmt/Balance. Missing or
        // non-finite values mean a malformed/partial payload — treat as transient,
        // never as voided (which would false-alarm an otherwise-healthy milestone).
        if (!Number.isFinite(total) || !Number.isFinite(balance)) return { state: "error", status: res.status };
        const paymentTxnIds: string[] = (inv.LinkedTxn || [])
            .filter((t: any) => t.TxnType === "Payment")
            .map((t: any) => String(t.TxnId));
        // Voided invoices come back 200 with TotalAmt=0, Balance=0, and no linked payments.
        if (total === 0 && balance === 0 && paymentTxnIds.length === 0) return { state: "voided" };
        return { state: "ok", balance, total, paymentTxnIds };
    }
    if (res.status === 404) return { state: "notFound" };
    const body = await res.text().catch(() => "");
    if (res.status === 400 && /"code"\s*:\s*"610"|Object Not Found/i.test(body)) {
        return { state: "notFound" };
    }
    return { state: "error", status: res.status };
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

/** Read core invoice fields needed for payments/deletes. */
export async function readQBInvoice(tokens: QBTokens, qbInvoiceId: string) {
    const res = await qbFetch(`/invoice/${qbInvoiceId}`, tokens, { method: "GET" });
    if (!res.ok) return null;
    const inv = (await res.json()).Invoice;
    if (!inv) return null;
    return {
        syncToken: String(inv.SyncToken),
        customerId: String(inv.CustomerRef?.value ?? ""),
        balance: Number(inv.Balance ?? 0),
        total: Number(inv.TotalAmt ?? 0),
        docNumber: inv.DocNumber ?? null,
    };
}

/** Receive a payment against an invoice (full open balance). TEST/admin tooling. */
export async function createQBPaymentForInvoice(tokens: QBTokens, qbInvoiceId: string): Promise<{ paymentId: string; amount: number } | null> {
    const inv = await readQBInvoice(tokens, qbInvoiceId);
    if (!inv || inv.balance <= 0 || !inv.customerId) return null;
    const res = await qbFetch("/payment", tokens, {
        method: "POST",
        body: JSON.stringify({
            TotalAmt: inv.balance,
            CustomerRef: { value: inv.customerId },
            Line: [{ Amount: inv.balance, LinkedTxn: [{ TxnId: qbInvoiceId, TxnType: "Invoice" }] }],
        }),
    });
    if (!res.ok) throw new Error(`QB payment create failed: ${await res.text()}`);
    const p = (await res.json()).Payment;
    return { paymentId: String(p.Id), amount: Number(p.TotalAmt ?? inv.balance) };
}

/** Hard-delete a payment (test cleanup). */
export async function deleteQBPayment(tokens: QBTokens, paymentId: string): Promise<boolean> {
    const get = await qbFetch(`/payment/${paymentId}`, tokens, { method: "GET" });
    if (!get.ok) return false;
    const syncToken = String((await get.json()).Payment?.SyncToken ?? "0");
    const res = await fetch(
        `${QB_API_BASE}/${tokens.realmId}/payment?operation=delete&minorversion=73`,
        {
            method: "POST",
            headers: { Authorization: `Bearer ${tokens.accessToken}`, Accept: "application/json", "Content-Type": "application/json" },
            body: JSON.stringify({ Id: paymentId, SyncToken: syncToken }),
        }
    );
    return res.ok;
}

/** Hard-delete an invoice (test cleanup). Fails in QBO if payments are still linked. */
export async function deleteQBInvoice(tokens: QBTokens, qbInvoiceId: string): Promise<boolean> {
    const inv = await readQBInvoice(tokens, qbInvoiceId);
    if (!inv) return false;
    const res = await fetch(
        `${QB_API_BASE}/${tokens.realmId}/invoice?operation=delete&minorversion=73`,
        {
            method: "POST",
            headers: { Authorization: `Bearer ${tokens.accessToken}`, Accept: "application/json", "Content-Type": "application/json" },
            body: JSON.stringify({ Id: qbInvoiceId, SyncToken: inv.syncToken }),
        }
    );
    return res.ok;
}

/** Read an invoice's online-payment toggles + sync token (for sparse updates). */
export async function getQBInvoicePaymentOptions(tokens: QBTokens, qbInvoiceId: string) {
    const res = await qbFetch(`/invoice/${qbInvoiceId}`, tokens, { method: "GET" });
    if (!res.ok) return null;
    const inv = (await res.json()).Invoice;
    if (!inv) return null;
    return {
        syncToken: String(inv.SyncToken),
        card: inv.AllowOnlineCreditCardPayment === true,
        ach: inv.AllowOnlineACHPayment === true,
        balance: Number(inv.Balance ?? 0),
    };
}

/** Sparse-update an invoice's online-payment toggles (card / bank transfer). */
export async function setQBInvoicePaymentOptions(
    tokens: QBTokens,
    qbInvoiceId: string,
    syncToken: string,
    opts: { card: boolean; ach: boolean }
): Promise<boolean> {
    const res = await qbFetch("/invoice", tokens, {
        method: "POST",
        body: JSON.stringify({
            Id: qbInvoiceId,
            SyncToken: syncToken,
            sparse: true,
            AllowOnlineCreditCardPayment: opts.card,
            AllowOnlineACHPayment: opts.ach,
        }),
    });
    return res.ok;
}

/** Add customer-facing text before QBO sends its invoice email. */
export async function appendQBInvoiceCustomerMemo(
    tokens: QBTokens,
    qbInvoiceId: string,
    line: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
    const read = await qbFetch(`/invoice/${qbInvoiceId}`, tokens, { method: "GET" });
    if (!read.ok) return { ok: false, error: `Could not read QuickBooks invoice (${read.status})` };
    const invoice = (await read.json().catch(() => null))?.Invoice;
    if (!invoice?.SyncToken) return { ok: false, error: "QuickBooks invoice response was incomplete" };

    const current = String(invoice.CustomerMemo?.value ?? "").trim();
    if (current.includes(line)) return { ok: true };
    const update = await qbFetch("/invoice", tokens, {
        method: "POST",
        body: JSON.stringify({
            Id: qbInvoiceId,
            SyncToken: String(invoice.SyncToken),
            sparse: true,
            CustomerMemo: { value: [current, line].filter(Boolean).join("\n\n").slice(0, 1000) },
        }),
    });
    if (!update.ok) return { ok: false, error: `Could not add the backup link to the QuickBooks invoice (${update.status})` };
    return { ok: true };
}

/** Posted money-out transactions (expenses/checks/card charges) from the books. */
export async function getRecentQBPurchases(tokens: QBTokens, sinceDaysAgo: number) {
    const since = new Date(Date.now() - sinceDaysAgo * 86_400_000).toISOString().split("T")[0];
    const rows = await getQBPurchasesSince(tokens, new Date(`${since}T00:00:00.000Z`));
    return rows.map(p => ({
        qbId: String(p.Id),
        date: p.TxnDate ?? null,
        amount: Number(p.TotalAmt ?? 0),
        paymentType: p.PaymentType ?? null, // Cash | Check | CreditCard
        docNumber: p.DocNumber ?? null,
        vendor: p.EntityRef?.name ?? null,
        account: p.AccountRef?.name ?? null,
        memo: p.PrivateNote ?? null,
    }));
}

/**
 * Read all posted QBO Purchase rows on or after a transaction date.
 * Pagination matters for the initial historical backfill; a single QBO query
 * page would silently stop after its MAXRESULTS boundary.
 */
export async function getQBPurchasesSince(tokens: QBTokens, since: Date, until?: Date): Promise<any[]> {
    if (!Number.isFinite(since.getTime())) {
        throw new Error("QBO purchase query requires a valid since date");
    }
    if (until && !Number.isFinite(until.getTime())) {
        throw new Error("QBO purchase query requires a valid until date");
    }

    const sinceDate = since.toISOString().slice(0, 10);
    // Inclusive upper bound so callers can chunk a long backfill into
    // date windows that each finish within the serverless duration limit.
    const untilClause = until ? ` AND TxnDate <= '${until.toISOString().slice(0, 10)}'` : "";
    const pageSize = 1000;
    const purchases: any[] = [];

    for (let startPosition = 1; ; startPosition += pageSize) {
        const page = await qbQuery<any>(
            tokens,
            `SELECT * FROM Purchase WHERE TxnDate >= '${sinceDate}'${untilClause} ORDERBY TxnDate ASC STARTPOSITION ${startPosition} MAXRESULTS ${pageSize}`,
        );
        purchases.push(...page);
        if (page.length < pageSize) break;
    }

    return purchases;
}

/**
 * Read Purchase rows changed since a timestamp using QBO Change Data Capture.
 * Unlike a TxnDate query, CDC catches newly entered backdated purchases,
 * corrections, voids, refunds, and deletion tombstones. QBO caps CDC lookback
 * at 30 days and returns at most 1,000 entities, so truncated responses fail
 * visibly instead of silently leaving local job costs stale.
 */
export async function getQBPurchaseChangesSince(
    tokens: QBTokens,
    since: Date,
): Promise<any[]> {
    if (!Number.isFinite(since.getTime())) {
        throw new Error("QBO Purchase CDC requires a valid since date");
    }

    const params = new URLSearchParams({
        entities: "Purchase",
        changedSince: since.toISOString(),
        minorversion: "73",
    });
    const response = await fetch(
        `${QB_API_BASE}/${tokens.realmId}/cdc?${params.toString()}`,
        {
            headers: {
                Authorization: `Bearer ${tokens.accessToken}`,
                Accept: "application/json",
            },
        },
    );
    if (!response.ok) {
        throw new Error(`QBO Purchase CDC failed with status ${response.status}`);
    }

    const payload = await response.json();
    const cdcResponses = Array.isArray(payload?.CDCResponse)
        ? payload.CDCResponse
        : [];
    const queryResponses = cdcResponses.flatMap((entry: any) =>
        Array.isArray(entry?.QueryResponse) ? entry.QueryResponse : [],
    );
    const purchases: any[] = [];
    for (const queryResponse of queryResponses) {
        const page = Array.isArray(queryResponse?.Purchase)
            ? queryResponse.Purchase
            : [];
        const totalCount = Number(queryResponse?.totalCount ?? page.length);
        if (
            page.length >= 1000 ||
            (Number.isFinite(totalCount) && totalCount > page.length)
        ) {
            throw new Error("QBO Purchase CDC response was truncated");
        }
        purchases.push(...page);
    }

    // Keep the last representation if QBO includes the same id more than once.
    const byId = new Map<string, any>();
    const withoutId: any[] = [];
    for (const purchase of purchases) {
        const id = purchase?.Id === undefined ? "" : String(purchase.Id);
        if (id) byId.set(id, purchase);
        else withoutId.push(purchase);
    }
    return [...byId.values(), ...withoutId];
}

/** Posted customer payments (money in) from the books. */
export async function getRecentQBPaymentsList(tokens: QBTokens, sinceDaysAgo: number) {
    const since = new Date(Date.now() - sinceDaysAgo * 86_400_000).toISOString().split("T")[0];
    const rows = await qbQuery<any>(tokens, `SELECT * FROM Payment WHERE TxnDate >= '${since}' ORDERBY TxnDate DESC MAXRESULTS 500`);
    return rows.map(p => ({
        qbId: String(p.Id),
        date: p.TxnDate ?? null,
        amount: Number(p.TotalAmt ?? 0),
        customer: p.CustomerRef?.name ?? null,
        reference: p.PaymentRefNum ?? null,
    }));
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

/** Send a QBO invoice email to a client. */
export async function sendQBInvoice(tokens: QBTokens, qbInvoiceId: string, sendTo?: string | null) {
    const qs = new URLSearchParams({ minorversion: "73" });
    if (sendTo) qs.set("sendTo", sendTo);
    const url = `${QB_API_BASE}/${tokens.realmId}/invoice/${qbInvoiceId}/send?${qs}`;
    const res = await fetch(url, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${tokens.accessToken}`,
            Accept: "application/json",
            "Content-Type": "application/octet-stream",
        },
    });
    if (!res.ok) return { ok: false as const, status: res.status, error: await res.text() };
    const data = await res.json().catch(() => ({}));
    return { ok: true as const, status: res.status, emailStatus: data.Invoice?.EmailStatus ?? null };
}
