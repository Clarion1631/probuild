import type { CanonicalCoTaxTerms } from "./co-tax";

export type ChangeOrderSendPreviewPayload = {
    changeOrderId: string;
    recipient: string;
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

/** Stable serialization used for both MCP preview minting and confirmation. */
export function buildChangeOrderSendPreviewPayload(input: ChangeOrderSendPreviewPayload): string {
    return JSON.stringify(input);
}
