/**
 * Check evidence for invoice payments — "Paid by X, chk#N", backed by the
 * physical check image a human confirmed against the bank ledger.
 *
 * A paid milestone recorded as method "check" carries a referenceNumber (the
 * check #). A confirmed BankImageMatch means a human said "this image
 * explains this bank line". This module ties the two together so the invoice
 * detail can show the payer printed on the actual instrument.
 *
 * CHECK NUMBERS ARE NOT UNIQUE ACROSS PAYERS — every checkbook has a #1027.
 * So a number match alone is never enough: the amount must corroborate
 * (image amount when readable, otherwise the confirmed bank line's amount).
 * No corroborating amount ⇒ no evidence shown. Honest silence beats a
 * plausible wrong name on a money page.
 *
 * READ-ONLY and display-only: nothing here writes, settles, or notifies.
 * The pure matcher is separated from the Prisma fetch for unit testing
 * (tests/check-evidence.test.ts).
 */

import { prisma } from "@/lib/prisma";
import { normalizeCheckRef } from "@/lib/check-payer-match";

export interface CheckEvidence {
    /** Payer printed on the check, when the extraction could read it. */
    payerName: string | null;
    /** Digits-only check number (the normalized identity). */
    checkNumber: string;
    /** Google Drive file id for the image, when the pull recorded one. */
    driveFileId: string | null;
    fileName: string | null;
    /** Who confirmed the image ↔ bank line match, and when (ISO). */
    confirmedBy: string;
    confirmedAt: string;
}

/** Confirmed image row shape the pure matcher consumes. */
export interface ConfirmedCheckImage {
    normalizedCheckNumber: string | null;
    /** Positive cents printed on the document, when readable. */
    amountCents: number | null;
    /** Signed cents of the confirmed bank line, when the match carries one. */
    lineAmountCents: number | null;
    payerName: string | null;
    driveFileId: string | null;
    fileName: string | null;
    confirmedBy: string;
    confirmedAt: string;
}

export interface PaymentForEvidence {
    id: string;
    referenceNumber: string | null;
    /** Milestone amount in cents. */
    amountCents: number | null;
}

/**
 * Pure. For each payment, find the confirmed check image whose number AND
 * amount both agree. Ambiguity (two confirmed images with the same number
 * and amount) yields nothing — never a guess. Returns paymentId → evidence.
 */
export function matchCheckEvidence(
    payments: PaymentForEvidence[],
    confirmedImages: ConfirmedCheckImage[],
): Map<string, CheckEvidence> {
    const out = new Map<string, CheckEvidence>();

    for (const payment of payments) {
        const ref = normalizeCheckRef(payment.referenceNumber);
        if (!ref) continue;
        const amountCents = payment.amountCents;
        if (amountCents === null || !Number.isSafeInteger(amountCents) || amountCents <= 0) continue;

        const hits = confirmedImages.filter((img) => {
            if (img.normalizedCheckNumber !== ref) return false;
            // Amount corroboration: the document amount when readable,
            // otherwise the confirmed bank line's magnitude.
            if (img.amountCents !== null) return img.amountCents === amountCents;
            if (img.lineAmountCents !== null) return Math.abs(img.lineAmountCents) === amountCents;
            return false;
        });

        if (hits.length !== 1) continue; // 0 = no evidence; 2+ = ambiguous, never guess
        const img = hits[0];
        out.set(payment.id, {
            payerName: img.payerName,
            checkNumber: ref,
            driveFileId: img.driveFileId,
            fileName: img.fileName,
            confirmedBy: img.confirmedBy,
            confirmedAt: img.confirmedAt,
        });
    }

    return out;
}

/**
 * Server fetch for the invoice detail page. Loads only the confirmed
 * check-front images whose numbers appear on the given payments, then runs
 * the pure matcher. Failures are the caller's to degrade on (the invoice
 * page renders fine with no evidence).
 */
export async function fetchCheckEvidenceForPayments(
    payments: PaymentForEvidence[],
): Promise<Record<string, CheckEvidence>> {
    const refs = [...new Set(
        payments.map((p) => normalizeCheckRef(p.referenceNumber)).filter((r): r is string => r !== null),
    )];
    if (refs.length === 0) return {};

    const matches = await prisma.bankImageMatch.findMany({
        where: {
            bankImage: {
                kind: "CHECK_FRONT",
                normalizedCheckNumber: { in: refs },
            },
        },
        include: {
            bankImage: {
                select: {
                    normalizedCheckNumber: true,
                    amountCents: true,
                    payerName: true,
                    driveFileId: true,
                    fileName: true,
                },
            },
            bankLine: { select: { amountCents: true } },
        },
    });

    const confirmed: ConfirmedCheckImage[] = matches.map((m) => ({
        normalizedCheckNumber: m.bankImage.normalizedCheckNumber,
        amountCents: m.bankImage.amountCents,
        lineAmountCents: m.bankLine?.amountCents ?? null,
        payerName: m.bankImage.payerName,
        driveFileId: m.bankImage.driveFileId,
        fileName: m.bankImage.fileName,
        confirmedBy: m.confirmedBy,
        confirmedAt: m.confirmedAt.toISOString(),
    }));

    return Object.fromEntries(matchCheckEvidence(payments, confirmed));
}
