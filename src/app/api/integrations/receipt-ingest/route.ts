import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { assertPhaseOfProjectTx } from "@/lib/phase-invariant";
import { resolveProjectPhaseCodes } from "@/lib/project-phases";
import { prismaPhaseDataSource } from "@/lib/project-phases-db";
import { dateOnlyInTimeZone, resolveCompanyTimeZone } from "@/lib/company-timezone";
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

    // The PROJECT's phases, not every active company code. Matching a Gemini
    // category string against the whole company list let a Drive import book a
    // phase that exists only on some other job — and this path writes the code
    // straight onto the expense.
    const costCodes = (await resolveProjectPhaseCodes(prismaPhaseDataSource, project.id))
        .map((phase) => ({ id: phase.id, code: phase.code, name: phase.name }));

    const isCheck = String(body.docType || "receipt").toLowerCase() === "check";
    const docRef = isCheck
        ? `Check #${body.checkNumber || "?"}${body.memo ? ` — "${body.memo}"` : ""}`
        : (body.invoice && body.invoice !== "NoInv" ? `Invoice ${body.invoice}` : "Receipt");
    // `T12:00:00` with no zone is the SERVER's noon, not the company's — on a
    // UTC host that is 05:00 Pacific, still the right day, but it is the right
    // answer by luck rather than by rule. The shared parser makes it a company
    // calendar day like every other writer.
    const companyTimeZone = await resolveCompanyTimeZone();
    const date = body.date && /^\d{4}-\d{2}-\d{2}$/.test(body.date)
        ? dateOnlyInTimeZone(body.date, companyTimeZone)
        : new Date();

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

        // A MATCHED PHASE IS STILL A CLAIM ABOUT THIS JOB (round 18, item 4).
        //
        // `matchCostCode` is a string match over the company's codes; it knows
        // nothing about which phases this job carries, and nothing here held
        // the answer still. The invariant locks the four tables it rests on and
        // answers on the transaction that inserts the row; a code that is not
        // (or no longer) a phase of this job is dropped rather than posted,
        // with the same warning an unmatched category already produces.
        const ingested = await prisma.$transaction(async tx => {
            let phaseId = costCode?.id ?? null;
            if (phaseId) {
                const verdict = await assertPhaseOfProjectTx(
                    tx as unknown as { $queryRawUnsafe(q: string, ...v: unknown[]): Promise<unknown> },
                    project.id,
                    phaseId,
                );
                if (!verdict.ok) phaseId = null;
            }
            await tx.expense.create({
            data: {
                estimateId,
                projectId: project.id,
                costCodeId: phaseId,
                // The category came from the Apps Script's Gemini read, not
                // from a person — "ai", never "capture", so nothing downstream
                // treats it as a human's answer. No confidence: matchCostCode
                // is a string match and has no score to report, and inventing
                // one would be a guess presented as a measurement.
                costCodeSource: phaseId ? "ai" : null,
                costCodeConfidence: null,
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
            return phaseId;
        });
        if (costCode && ingested === null) {
            warnings.push(
                `"${group.category}" matched ${costCode.code}, which is not a phase of this job — expense created without one`,
            );
        }
        created++;
    }

    if (created === 0) {
        return NextResponse.json({ ok: false, reason: "no-valid-groups" });
    }
    return NextResponse.json({ ok: true, created, projectId: project.id, projectName: project.name, warnings });
}
