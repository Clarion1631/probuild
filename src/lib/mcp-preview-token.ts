import { createHmac, timingSafeEqual } from "crypto";

const PREVIEW_BUCKET_MS = 300_000;

function previewSecret(secret: string | undefined): string {
    if (!secret) throw new Error("MCP preview token secret is not configured.");
    return secret;
}

export function mintPreviewToken(payload: string, secret = process.env.MCP_SECRET): string {
    const bucket = Math.floor(Date.now() / PREVIEW_BUCKET_MS);
    return createHmac("sha256", previewSecret(secret)).update(`${bucket}:${payload}`).digest("hex").slice(0, 20);
}

export function verifyPreviewToken(token: string | undefined, payload: string, secret = process.env.MCP_SECRET): boolean {
    if (!token || !secret) return false;
    const now = Math.floor(Date.now() / PREVIEW_BUCKET_MS);
    for (const bucket of [now, now - 1]) {
        const expect = createHmac("sha256", secret).update(`${bucket}:${payload}`).digest("hex").slice(0, 20);
        const supplied = Buffer.from(token);
        const expected = Buffer.from(expect);
        if (supplied.length === expected.length && timingSafeEqual(supplied, expected)) return true;
    }
    return false;
}
