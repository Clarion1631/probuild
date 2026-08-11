import { NextResponse } from "next/server";
import { getCurrentUserWithPermissions, hasPermission } from "@/lib/permissions";
import { getFreshQBTokens, QBNotConnectedError } from "@/lib/quickbooks-payments";
import { fetchBankRegister } from "@/lib/qbo-bank-register";
import { mergeRegister } from "@/lib/register-merge";
import { fetchRegisterMergeInputs } from "../../../automation/register-data";
import { applyRegisterFilters } from "../../../automation/register-filters";

export const dynamic = "force-dynamic";

/**
 * CSV export of the merged money register — the bookkeeper's take-it-to-Excel
 * view. Same permission gate, fetch path, and merge as /automation itself
 * (fetchBankRegister → fetchRegisterMergeInputs → mergeRegister), so the file
 * always matches what the page shows for the same ?range.
 */

const ALLOWED_RANGES = new Set(["30", "60", "90"]);

/** Quote/escape one TEXT cell, defusing spreadsheet-formula injection: a
 * vendor or doc number starting with = + - @ (or control whitespace) would
 * otherwise execute as a formula when the file opens in Excel/Sheets. */
function csvText(value: string | null | undefined): string {
    if (value === null || value === undefined) return "";
    let s = String(value);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Numeric cells (amounts) must NOT get the formula-defusing apostrophe —
 * a leading minus sign is a sign here, not an injection vector. */
function csvNumber(value: number): string {
    return value.toFixed(2);
}

function sinceMsForRangeDays(rangeDays: number): number {
    return Date.now() - rangeDays * 24 * 60 * 60 * 1000;
}

export async function GET(request: Request) {
    const user = await getCurrentUserWithPermissions();
    if (!user) return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
    if (!hasPermission(user, "financialReports")) {
        return NextResponse.json({ ok: false, reason: "forbidden" }, { status: 403 });
    }

    const url = new URL(request.url);
    const range = ALLOWED_RANGES.has(url.searchParams.get("range") ?? "") ? url.searchParams.get("range")! : "30";
    const rangeDays = Number(range);
    const typeParam = url.searchParams.get("type");
    const type = typeParam === "in" || typeParam === "out" ? typeParam : "all";
    const reviewOnly = url.searchParams.get("review") === "1";

    const endDate = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
    const startDateObj = new Date(`${endDate}T00:00:00Z`);
    startDateObj.setUTCDate(startDateObj.getUTCDate() - (rangeDays - 1));
    const startDate = startDateObj.toISOString().slice(0, 10);

    try {
        const register = await fetchBankRegister(getFreshQBTokens, startDate, endDate);
        const inputs = await fetchRegisterMergeInputs(register.rows, sinceMsForRangeDays(rangeDays));
        const merged = mergeRegister(register.rows, inputs.expenses, inputs.receiptEvents, inputs.classifications);

        // Mirror the page's own filters so the file never contains MORE ledger
        // than the view the bookkeeper exported it from.
        const rows = applyRegisterFilters(
            merged.rows.map((r) => ({ ...r, needsReview: r.status === "needs-review" })),
            { type, reviewOnly, mergeUnavailable: false },
        );

        const header = [
            "Date", "Type", "Name", "Doc #", "Amount", "Status", "Status detail",
            "Receipt on file", "In ProBuild job costs", "Amount match", "Project",
            "QuickBooks txn id", "Receipt link",
        ].join(",");

        const lines = rows.map((r) =>
            [
                csvText(r.date),
                csvText(r.qbType),
                csvText(r.name),
                csvText(r.docNum),
                csvNumber(r.amountCents / 100),
                csvText(r.status),
                csvText(r.label),
                csvText(r.edges ? (r.edges.receipt === "pass" ? (r.edges.receiptUnconfirmed ? "unconfirmed" : "yes") : "no") : ""),
                csvText(r.edges ? (r.edges.jobCost === "pass" ? "yes" : "no") : ""),
                csvText(r.edges ? r.edges.amount : ""),
                csvText(r.projectName),
                csvText(r.qbTxnId),
                csvText(r.receiptUrl),
            ].join(","),
        );

        const csv = [header, ...lines].join("\r\n") + "\r\n";
        return new NextResponse(csv, {
            headers: {
                "Content-Type": "text/csv; charset=utf-8",
                "Content-Disposition": `attachment; filename="register-${startDate}_to_${endDate}.csv"`,
                "Cache-Control": "no-store",
            },
        });
    } catch (error) {
        if (error instanceof QBNotConnectedError) {
            return NextResponse.json({ ok: false, reason: "qb-not-connected" }, { status: 503 });
        }
        console.error("register export failed", error instanceof Error ? error.name : "UnknownError");
        return NextResponse.json({ ok: false, reason: "export-failed" }, { status: 500 });
    }
}
