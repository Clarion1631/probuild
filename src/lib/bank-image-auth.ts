import { createHash, timingSafeEqual } from "node:crypto";

/** Constant-time check for the dedicated machine-to-machine bank-image key. */
export function isValidBankImageIngestKey(supplied: string | null | undefined, secret: string | undefined): boolean {
    if (!secret || !supplied) return false;
    const expectedDigest = createHash("sha256").update(secret).digest();
    const suppliedDigest = createHash("sha256").update(supplied).digest();
    return timingSafeEqual(expectedDigest, suppliedDigest);
}
