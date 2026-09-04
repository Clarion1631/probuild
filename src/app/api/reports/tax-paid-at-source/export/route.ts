import { NextRequest, NextResponse } from "next/server";
import { getSessionOrDev } from "@/lib/auth";
import { canUseDevAuthFallback, getCurrentUserWithPermissions, hasPermission } from "@/lib/permissions";
import {
    queryTaxAtSourceRows,
    resolveTaxAtSourceFilters,
    rowsToCsv,
} from "@/lib/tax-at-source-report";

export const dynamic = "force-dynamic";

/**
 * The CSV Vanessa's handoff file is built from. Gated by the SAME permission as
 * the page — an export route is a second door onto the same money, and a page
 * gate that the download bypasses is not a gate.
 */
export async function GET(req: NextRequest) {
    const session = await getSessionOrDev();
    if (!session?.user?.email) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const user = await getCurrentUserWithPermissions();
    const devAllowed = await canUseDevAuthFallback();
    if ((!user || !hasPermission(user, "financialReports")) && !devAllowed) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const filters = await resolveTaxAtSourceFilters(req.nextUrl.searchParams);
    const rows = await queryTaxAtSourceRows(filters);

    // Both keys are validated /^\d{4}-\d{2}-\d{2}$/ by the parser (anything
    // else falls back to the current quarter), so neither can inject a header.
    const filename = `tax-paid-at-source-${filters.fromKey}-to-${filters.toKey}.csv`;

    return new NextResponse(rowsToCsv(rows), {
        status: 200,
        headers: {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": `attachment; filename="${filename}"`,
            "Cache-Control": "no-store",
        },
    });
}
