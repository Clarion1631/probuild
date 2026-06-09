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

/** Create or find a client in QuickBooks Online. Returns the QBO Customer ID. */
export async function syncClientToQB(
    tokens: QBTokens,
    client: {
        name: string;
        email: string | null;
        primaryPhone: string | null;
        addressLine1: string | null;
        city: string | null;
        state: string | null;
        zipCode: string | null;
    }
): Promise<string> {
    // 1. Check if the customer already exists by DisplayName to avoid duplicate names in QBO.
    const escapedName = client.name.replace(/'/g, "\\'");
    const query = `select * from Customer where DisplayName = '${escapedName}'`;
    const checkRes = await qbFetch(`/query?query=${encodeURIComponent(query)}`, tokens);
    
    if (checkRes.ok) {
        const queryData = await checkRes.json();
        const existing = queryData.QueryResponse?.Customer?.[0];
        if (existing) {
            return existing.Id;
        }
    }

    // 2. If not found, create new Customer
    const payload = {
        DisplayName: client.name,
        PrimaryEmailAddr: client.email ? { Address: client.email } : undefined,
        PrimaryPhone: client.primaryPhone ? { FreeFormNumber: client.primaryPhone } : undefined,
        BillAddr: (client.addressLine1 || client.city || client.state || client.zipCode) ? {
            Line1: client.addressLine1 || undefined,
            City: client.city || undefined,
            CountrySubDivisionCode: client.state || undefined,
            PostalCode: client.zipCode || undefined,
        } : undefined,
    };

    const res = await qbFetch("/customer", tokens, {
        method: "POST",
        body: JSON.stringify(payload),
    });

    if (!res.ok) {
        const err = await res.text();
        throw new Error(`QB client creation failed: ${err}`);
    }

    const data = await res.json();
    return data.Customer.Id;
}

/** Create a Project in QBO (as a sub-customer with Job=true). Returns the QBO Project/Customer ID. */
export async function syncProjectToQB(
    tokens: QBTokens,
    project: {
        name: string;
        clientName: string;
    },
    qbCustomerId: string
): Promise<string> {
    // A QBO Project is a Customer with Job=true, IsProject=true, and ParentRef.
    // DisplayName must be unique, so we name it "Client Name - Project Name"
    const displayName = `${project.clientName} - ${project.name}`.slice(0, 100);
    
    // Check if it already exists
    const escapedName = displayName.replace(/'/g, "\\'");
    const query = `select * from Customer where DisplayName = '${escapedName}'`;
    const checkRes = await qbFetch(`/query?query=${encodeURIComponent(query)}`, tokens);
    
    if (checkRes.ok) {
        const queryData = await checkRes.json();
        const existing = queryData.QueryResponse?.Customer?.[0];
        if (existing) {
            return existing.Id;
        }
    }

    const payload = {
        DisplayName: displayName,
        Job: true,
        ParentRef: {
            value: qbCustomerId,
        },
        IsProject: true,
        ProjectStatus: "RUNNING",
    };

    const res = await qbFetch("/customer", tokens, {
        method: "POST",
        body: JSON.stringify(payload),
    });

    if (!res.ok) {
        const err = await res.text();
        throw new Error(`QB project creation failed: ${err}`);
    }

    const data = await res.json();
    return data.Customer.Id;
}

/** Sync a TimeEntry to QuickBooks TimeActivity */
export async function syncTimeEntryToQB(
    tokens: QBTokens,
    entry: {
        date: string; // YYYY-MM-DD
        hours: number;
        description: string | null;
        qbProjectId: string;
    },
    qbWorker: {
        type: "Employee" | "Vendor";
        id: string;
    }
): Promise<string> {
    const payload: any = {
        TxnDate: entry.date,
        NameOf: qbWorker.type,
        CustomerRef: {
            value: entry.qbProjectId,
        },
        Hours: Math.floor(entry.hours),
        Minutes: Math.round((entry.hours % 1) * 60),
        Description: entry.description || "Labor",
        BillableStatus: "NotBillable",
    };

    if (qbWorker.type === "Employee") {
        payload.EmployeeRef = { value: qbWorker.id };
    } else {
        payload.VendorRef = { value: qbWorker.id };
    }

    const res = await qbFetch("/timeactivity", tokens, {
        method: "POST",
        body: JSON.stringify(payload),
    });

    if (!res.ok) {
        const err = await res.text();
        throw new Error(`QB TimeActivity sync failed: ${err}`);
    }

    const data = await res.json();
    return data.TimeActivity.Id;
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
        qbProjectId?: string | null;
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
        CustomerRef: estimate.qbProjectId 
            ? { value: estimate.qbProjectId }
            : { name: estimate.client.name },
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
        qbProjectId?: string | null;
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
        CustomerRef: invoice.qbProjectId
            ? { value: invoice.qbProjectId }
            : { name: invoice.client.name },
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
