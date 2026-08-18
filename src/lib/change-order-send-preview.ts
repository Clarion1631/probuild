import type { CanonicalCoTaxTerms } from "./co-tax";

export type ChangeOrderSendPreviewPayload = {
    changeOrderId: string;
    /** One nonce per preview, signed into the confirmation token. */
    generation: string;
    recipients: ChangeOrderRecipientSet;
    code: string;
    title: string;
    pricingType: string;
    markupPercent: number | null;
    total: number;
    schedules: unknown[];
    status: string;
    revision: number;
    taxTerms: CanonicalCoTaxTerms;
};

const PREVIEW_GENERATION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PREVIEW_SIGNATURE_RE = /^[0-9a-f]{20}$/i;

export function formatChangeOrderConfirmToken(generation: string, signature: string): string {
    if (!PREVIEW_GENERATION_RE.test(generation) || !PREVIEW_SIGNATURE_RE.test(signature)) {
        throw new Error("Invalid change-order preview confirmation token parts");
    }
    return `${generation}.${signature}`;
}

export function parseChangeOrderConfirmToken(
    token: string | undefined,
): { generation: string; signature: string } | null {
    if (!token) return null;
    const [generation, signature, extra] = token.split(".");
    if (extra !== undefined || !PREVIEW_GENERATION_RE.test(generation ?? "") || !PREVIEW_SIGNATURE_RE.test(signature ?? "")) {
        return null;
    }
    return { generation, signature };
}

export type ChangeOrderRecipientSet = {
    primary: string;
    additional: string[];
};

/** Case-insensitive canonical recipient set used by preview tokens and CAS. */
export function canonicalChangeOrderRecipients(
    primaryEmail: string | null | undefined,
    additionalEmail: string | null | undefined,
): ChangeOrderRecipientSet {
    const primary = (primaryEmail ?? "").trim().toLowerCase();
    const additional = (additionalEmail ?? "").trim().toLowerCase();
    return {
        primary,
        additional: additional && additional !== primary ? [additional] : [],
    };
}

/** Stable serialization used for both MCP preview minting and confirmation. */
export function buildChangeOrderSendPreviewPayload(input: ChangeOrderSendPreviewPayload): string {
    return JSON.stringify(input);
}
