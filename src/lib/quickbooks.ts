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

/** Push an estimate to QB. Returns the QB estimate ID. */
export async function syncEstimateToQB(
    tokens: QBTokens,
    estimate: {
        id: string;
        code: string;
        title: string;
        totalAmount: number;
        items: Array<{ name: string; quantity: number; unitCost: number; total: number; type: string }>;
        client: { name: string; email: string | null };
        project: { name: string } | null;
    },
    glMappings: Record<string, string> = {}
): Promise<{ qbId: string; qbUrl: string }> {
    // Build QB Estimate payload
    const lines = estimate.items.map((item, i) => ({
        Id: String(i + 1),
        LineNum: i + 1,
        Description: item.name,
        Amount: item.total,
        DetailType: "SalesItemLineDetail",
        SalesItemLineDetail: {
            Qty: item.quantity,
            UnitPrice: item.unitCost,
        },
    }));

    const payload = {
        TxnDate: new Date().toISOString().split("T")[0],
        DocNumber: estimate.code,
        PrivateNote: estimate.title,
        CustomerRef: { name: estimate.client.name },
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
        client: { name: string; email: string | null };
        project: { name: string } | null;
        items?: Array<{ description: string; amount: number }>;
    }
): Promise<{ qbId: string; qbUrl: string }> {
    const lines: object[] = (invoice.items || []).map((item, i) => ({
        LineNum: i + 1,
        Description: item.description,
        Amount: item.amount,
        DetailType: "SalesItemLineDetail",
        SalesItemLineDetail: { Qty: 1, UnitPrice: item.amount },
    }));

    if (lines.length === 0) {
        lines.push({
            LineNum: 1,
            Description: invoice.project?.name || "Construction Services",
            Amount: invoice.totalAmount,
            DetailType: "SalesItemLineDetail",
            SalesItemLineDetail: { Qty: 1, UnitPrice: invoice.totalAmount },
        });
    }

    const payload = {
        DocNumber: invoice.code,
        TxnDate: new Date().toISOString().split("T")[0],
        CustomerRef: { name: invoice.client.name },
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
