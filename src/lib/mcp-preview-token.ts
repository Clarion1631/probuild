import { createHmac, timingSafeEqual } from "crypto";

const PREVIEW_BUCKET_MS = 300_000;

export function mintPreviewToken(payload: string): string {
    const bucket = Math.floor(Date.now() / PREVIEW_BUCKET_MS);
    return createHmac("sha256", process.env.MCP_SECRET ?? "").update(`${bucket}:${payload}`).digest("hex").slice(0, 20);
}

export function verifyPreviewToken(token: string | undefined, payload: string): boolean {
    if (!token) return false;
    const now = Math.floor(Date.now() / PREVIEW_BUCKET_MS);
    for (const bucket of [now, now - 1]) {
        const expect = createHmac("sha256", process.env.MCP_SECRET ?? "").update(`${bucket}:${payload}`).digest("hex").slice(0, 20);
        const supplied = Buffer.from(token);
        const expected = Buffer.from(expect);
        if (supplied.length === expected.length && timingSafeEqual(supplied, expected)) return true;
    }
    return false;
}
