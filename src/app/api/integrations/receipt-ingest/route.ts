import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { matchProjectByName, matchCostCode } from "@/lib/project-match";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Receipt/check ingest from the "GOLDEN TOUCH — RECEIPT + CHECK AUTOMATION"
 * Google Apps Script. The script already AI-splits each document into category
 * groups (the 15 project steps) and emails the image to QuickBooks; this
 * endpoint is the ProBuild leg: one Pending expense per category group, coded
 * to the matching cost code (phase), with the Drive image linked. Vanessa
 * reviews them in /manager/receipts; they roll into /reports/profitability.
 *
 * Auth: x-ingest-key header must equal RECEIPT_INGEST_SECRET.
 * Shop/overhead docs are NOT sent here (QBO-only) — expenses require a project.
 */

interface IngestLine { sku?: string; desc?: string; price?: string | number }
interface IngestGroup { category: string; amount: number; lines?: IngestLine[] }
interface IngestPayload {
    projectName: string;
    docType?: string; // "receipt" | "check"
    vendor?: string;
    date?: string; // YYYY-MM-DD
    invoice?: string;
    checkNumber?: string;
    memo?: string;
    totalAmount?: number;
    fileId: string; // Drive file id — dedupe key, survives the archive move
    fileUrl?: string;
    fileName?: string;
    groups: IngestGroup[];
}

export async function POST(req: Request) {
    const secret = process.env.RECEIPT_INGEST_SECRET;
    if (!secret || req.headers.get("x-ingest-key") !== secret) {
        return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
    }

    let body: IngestPayload;
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ ok: false, reason: "invalid-json" }, { status: 400 });
    }
    if (!body.fileId || !body.projectName || !Array.isArray(body.groups) || body.groups.length === 0) {
        return NextResponse.json({ ok: false, reason: "missing-fields" }, { status: 400 });
    }

    const receiptUrl = body.fileUrl || `https://drive.google.com/file/d/${body.fileId}/view`;

    // Dedupe: this Drive file was already ingested (the file id is stable across
    // the script's archive move, so re-runs and re-sends are safe).
    const existing = await prisma.expense.findFirst({
        where: { receiptUrl: { contains: body.fileId } },
        select: { id: true },
    });
    if (existing) {
        return NextResponse.json({ ok: true, alreadyIngested: true, created: 0 });
    }

    // Match the Drive folder name to a project, then its latest estimate.
    const projects = await prisma.project.findMany({
        select: {
            id: true, name: true,
            estimates: { orderBy: { createdAt: "desc" }, take: 1, select: { id: true } },
        },
    });
    const project = matchProjectByName(body.projectName, projects);
    if (!project) {
        return NextResponse.json({ ok: false, reason: "project-not-matched", projectName: body.projectName });
    }
    const estimateId = projects.find(p => p.id === project.id)?.estimates[0]?.id;
    if (!estimateId) {
        return NextResponse.json({ ok: false, reason: "project-has-no-estimate", projectId: project.id });
    }

    const costCodes = await prisma.costCode.findMany({
        where: { isActive: true },
        select: { id: true, code: true, name: true },
    });

    const isCheck = String(body.docType || "receipt").toLowerCase() === "check";
    const docRef = isCheck
        ? `Check #${body.checkNumber || "?"}${body.memo ? ` — "${body.memo}"` : ""}`
        : (body.invoice && body.invoice !== "NoInv" ? `Invoice ${body.invoice}` : "Receipt");
    const date = body.date && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? new Date(`${body.date}T12:00:00`) : new Date();

    const warnings: string[] = [];
    let created = 0;

    for (const group of body.groups) {
        const amount = Math.round(Number(group.amount) * 100) / 100;
        if (!Number.isFinite(amount) || amount === 0) continue;

        const costCode = matchCostCode(group.category || "", costCodes);
        if (!costCode) warnings.push(`No cost code matched "${group.category}" — expense created without a phase`);

        const lineSummary = (group.lines || [])
            .slice(0, 6)
            .map(l => l.desc)
            .filter(Boolean)
            .join("; ");

        await prisma.expense.create({
            data: {
                estimateId,
                costCodeId: costCode?.id ?? null,
                amount,
                vendor: body.vendor || "Unknown",
                date,
                status: "Pending",
                receiptUrl,
                description:
                    `[Drive import] ${docRef} · ${group.category}` +
                    (lineSummary ? ` · ${lineSummary}` : "") +
                    ` · pending bookkeeper review`,
            },
        });
        created++;
    }

    if (created === 0) {
        return NextResponse.json({ ok: false, reason: "no-valid-groups" });
    }
    return NextResponse.json({ ok: true, created, projectId: project.id, projectName: project.name, warnings });
}
