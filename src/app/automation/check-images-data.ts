import { prisma } from "@/lib/prisma";
import {
    proposeImageMatches,
    type BankImageCandidate,
    type BankImageKind,
    type BankImageLine,
} from "@/lib/bank-image";
import { suggestMatches, type MatchSuggestion } from "@/lib/check-payer-match";

/**
 * Data for the Automation page's "Check images" panel — the human worklist
 * for the check-payer pipeline (scripts/extract-check-payers.mjs writes the
 * extractions; this reads them).
 *
 * READ-ONLY. The only writer of BankImageMatch is the explicit
 * confirmBankImageMatch server action (src/lib/actions.ts) — a row in that
 * table means a HUMAN said yes (see prisma/schema.prisma).
 *
 * Caller (src/app/automation/page.tsx) is gated on the `financialReports`
 * permission before this ever runs — internal roles only, never the client
 * or sub portals.
 */

const IMAGE_KINDS = new Set(["CHECK_FRONT", "CHECK_BACK", "DEPOSIT_SLIP", "DEPOSIT_PHOTO"]);
/** Display cap — this is a review worklist, not an archive browser. */
export const CHECK_IMAGE_DISPLAY_LIMIT = 50;
/** Candidate ledger lines considered for proposals (most recent first). */
const LINE_CANDIDATE_LIMIT = 1000;

export interface CheckImageConfirmedMatch {
    bankLineId: string | null;
    lineDescriptor: string | null;
    linePostedDate: string | null;
    lineAmountCents: number | null;
    confirmedBy: string;
    /** ISO timestamp */
    confirmedAt: string;
    note: string | null;
}

export interface CheckImageProposedLine {
    bankLineId: string;
    confidence: string;
    reason: string;
    lineDescriptor: string;
    linePostedDate: string | null;
    lineAmountCents: number;
}

export interface CheckImagePanelRow {
    id: string;
    kind: string;
    sourceExternalId: string;
    fileName: string;
    driveFileId: string | null;
    /** ISO timestamp */
    capturedAt: string;
    /** YYYY-MM-DD */
    documentDate: string | null;
    amountCents: number | null;
    normalizedCheckNumber: string | null;
    /** Null both when extraction hasn't run (extractedAt null) AND when it
     * ran but found nothing / was scrubbed — `extracted` disambiguates. */
    payerName: string | null;
    memoText: string | null;
    extracted: boolean;
    extractionModel: string | null;
    payerMatches: MatchSuggestion[];
    memoMatches: MatchSuggestion[];
    proposal: CheckImageProposedLine | null;
    /** Why no line could be proposed, when there is no proposal and no confirmation. */
    unmatchedDetail: string | null;
    confirmed: CheckImageConfirmedMatch | null;
}

function toDateOnly(value: Date | null | undefined): string | null {
    return value ? value.toISOString().slice(0, 10) : null;
}

export async function fetchCheckImagePanelData(): Promise<{ rows: CheckImagePanelRow[]; totalImages: number }> {
    const [images, totalImages, lines, clients, projects] = await Promise.all([
        prisma.bankImage.findMany({
            orderBy: { capturedAt: "desc" },
            take: CHECK_IMAGE_DISPLAY_LIMIT,
            include: {
                matches: {
                    include: {
                        bankLine: {
                            select: { id: true, rawDescriptor: true, postedDate: true, amountCents: true },
                        },
                    },
                },
            },
        }),
        prisma.bankImage.count(),
        prisma.bankLine.findMany({
            orderBy: { postedDate: "desc" },
            take: LINE_CANDIDATE_LIMIT,
            select: { id: true, postedDate: true, amountCents: true, rawDescriptor: true, checkNumber: true },
        }),
        prisma.client.findMany({ select: { id: true, name: true } }),
        prisma.project.findMany({ select: { id: true, name: true } }),
    ]);

    const candidateLines: BankImageLine[] = lines.map((line) => ({
        id: line.id,
        postedDate: toDateOnly(line.postedDate) ?? "",
        amountCents: line.amountCents,
        rawDescriptor: line.rawDescriptor,
        checkNumber: line.checkNumber,
    })).filter((line) => line.postedDate !== "");

    const matchableImages: BankImageCandidate[] = images
        .filter((img) => IMAGE_KINDS.has(img.kind))
        .map((img) => ({
            id: img.id,
            kind: img.kind as BankImageKind,
            documentDate: toDateOnly(img.documentDate),
            amountCents: img.amountCents,
            normalizedCheckNumber: img.normalizedCheckNumber,
        }));

    const alreadyMatchedImageIds = images
        .filter((img) => img.matches.length > 0)
        .map((img) => img.id);

    const { proposals, unmatched } = proposeImageMatches(matchableImages, candidateLines, {
        alreadyMatchedImageIds,
    });
    const proposalByImage = new Map(proposals.map((p) => [p.bankImageId, p]));
    const unmatchedByImage = new Map(unmatched.map((u) => [u.bankImageId, u]));
    const lineById = new Map(candidateLines.map((line) => [line.id, line]));

    const rows: CheckImagePanelRow[] = images.map((img) => {
        // bankImageId is @unique on BankImageMatch, so 0 or 1 rows.
        const match = img.matches[0] ?? null;
        const extracted = img.extractedAt !== null;
        const suggestions = extracted
            ? suggestMatches({ payerName: img.payerName, memoText: img.memoText }, clients, projects)
            : { payerMatches: [], memoMatches: [] };
        const proposal = proposalByImage.get(img.id) ?? null;
        const proposalLine = proposal ? lineById.get(proposal.bankLineId) ?? null : null;

        return {
            id: img.id,
            kind: img.kind,
            sourceExternalId: img.sourceExternalId,
            fileName: img.fileName,
            driveFileId: img.driveFileId,
            capturedAt: img.capturedAt.toISOString(),
            documentDate: toDateOnly(img.documentDate),
            amountCents: img.amountCents,
            normalizedCheckNumber: img.normalizedCheckNumber,
            payerName: img.payerName,
            memoText: img.memoText,
            extracted,
            extractionModel: img.extractionModel,
            payerMatches: suggestions.payerMatches,
            memoMatches: suggestions.memoMatches,
            proposal: proposal
                ? {
                    bankLineId: proposal.bankLineId,
                    confidence: proposal.confidence,
                    reason: proposal.reason,
                    lineDescriptor: proposal.lineDescriptor,
                    linePostedDate: proposalLine?.postedDate ?? null,
                    lineAmountCents: proposal.lineAmountCents,
                }
                : null,
            unmatchedDetail: match ? null : unmatchedByImage.get(img.id)?.detail ?? null,
            confirmed: match
                ? {
                    bankLineId: match.bankLineId,
                    lineDescriptor: match.bankLine?.rawDescriptor ?? null,
                    linePostedDate: toDateOnly(match.bankLine?.postedDate ?? null),
                    lineAmountCents: match.bankLine?.amountCents ?? null,
                    confirmedBy: match.confirmedBy,
                    confirmedAt: match.confirmedAt.toISOString(),
                    note: match.note,
                }
                : null,
        };
    });

    return { rows, totalImages };
}
