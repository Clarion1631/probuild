/**
 * Pure helper for the "Partial payment" modal (safe to import from a "use client" file: no
 * prisma, no server imports). Turns what the user typed into integer cents, or null when it is
 * not a usable "amount received" for a milestone of `fullAmount`: it must be a finite number,
 * a whole number of cents (never silently rounded), greater than zero and less than the full amount.
 */
export function partialSplitCents(
    input: string | number,
    fullAmount: number,
): { firstCents: number; remainderCents: number } | null {
    if (typeof input === "string" && input.trim() === "") return null;
    const n = Number(input);
    if (!Number.isFinite(n)) return null;
    if (Math.abs(n * 100 - Math.round(n * 100)) >= 1e-6) return null;
    const firstCents = Math.round(n * 100);
    const fullCents = Math.round(fullAmount * 100);
    if (firstCents <= 0 || firstCents >= fullCents) return null;
    return { firstCents, remainderCents: fullCents - firstCents };
}
