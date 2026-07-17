import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSessionOrDev } from "@/lib/auth";
import { formatLocalDateString, parseSalesTaxFilters, querySalesTaxData, rowsToCsv } from "@/lib/sales-tax-report";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
    const session = await getSessionOrDev();
    if (!session?.user?.email) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const user = await prisma.user.findUnique({ where: { email: session.user.email } });
    if (!user || (user.role !== "ADMIN" && user.role !== "FINANCE")) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const filters = parseSalesTaxFilters(req.nextUrl.searchParams);
    const { rows } = await querySalesTaxData(filters);
    const csv = rowsToCsv(rows, filters.basis);

    // Filename fields are already whitelisted by parseSalesTaxFilters (basis is enum,
    // dates come from parseLocalDateString which matches /^\d{4}-\d{2}-\d{2}/), so
    // no header-injection-capable characters can appear here. Still: format defensively.
    const fromStr = formatLocalDateString(filters.from);
    const toStr = formatLocalDateString(filters.to);
    const filename = `sales-tax-${filters.basis}-${fromStr}-to-${toStr}.csv`;

    return new NextResponse(csv, {
        status: 200,
        headers: {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": `attachment; filename="${filename}"`,
            "Cache-Control": "no-store",
        },
    });
}
