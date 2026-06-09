import { NextRequest, NextResponse } from "next/server";
import { getQBSettings, saveQBSettings } from "@/lib/integration-store";
import { refreshQBToken } from "@/lib/quickbooks";

const QB_API_BASE = process.env.QB_SANDBOX === "true"
    ? "https://sandbox-quickbooks.api.intuit.com/v3/company"
    : "https://quickbooks.api.intuit.com/v3/company";

async function qbFetch(path: string, tokens: any) {
    const url = `${QB_API_BASE}/${tokens.realmId}${path}?minorversion=73`;
    return fetch(url, {
        headers: {
            Authorization: `Bearer ${tokens.accessToken}`,
            Accept: "application/json",
            "Content-Type": "application/json",
        },
    });
}

async function getTokens() {
    const qb = await getQBSettings();
    if (!qb.connected || !qb.accessToken || !qb.refreshToken || !qb.realmId) {
        throw new Error("QuickBooks not connected");
    }

    try {
        const fresh = await refreshQBToken(qb.refreshToken);
        await saveQBSettings({ accessToken: fresh.accessToken, refreshToken: fresh.refreshToken });
        return { accessToken: fresh.accessToken, refreshToken: fresh.refreshToken, realmId: qb.realmId };
    } catch {
        return { accessToken: qb.accessToken, refreshToken: qb.refreshToken, realmId: qb.realmId };
    }
}

export async function GET(req: NextRequest) {
    try {
        const tokens = await getTokens();

        // 1. Fetch Employees
        const empQuery = "select Id, DisplayName from Employee where Active = true";
        const empRes = await qbFetch(`/query?query=${encodeURIComponent(empQuery)}`, tokens);
        const empData = empRes.ok ? await empRes.json() : {};
        const employees = empData.QueryResponse?.Employee || [];

        // 2. Fetch Vendors (for 1099 workers/subcontractors tracking time)
        const venQuery = "select Id, DisplayName from Vendor where Active = true";
        const venRes = await qbFetch(`/query?query=${encodeURIComponent(venQuery)}`, tokens);
        const venData = venRes.ok ? await venRes.json() : {};
        const vendors = venData.QueryResponse?.Vendor || [];

        const workers = [
            ...employees.map((e: any) => ({
                id: `Employee:${e.Id}`,
                name: `${e.DisplayName} (Employee)`,
            })),
            ...vendors.map((v: any) => ({
                id: `Vendor:${v.Id}`,
                name: `${v.DisplayName} (Vendor)`,
            })),
        ].sort((a, b) => a.name.localeCompare(b.name));

        return NextResponse.json({ workers });
    } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to fetch workers";
        return NextResponse.json({ error: msg }, { status: 500 });
    }
}
