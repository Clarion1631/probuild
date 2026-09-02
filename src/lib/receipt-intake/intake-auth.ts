/**
 * Auth for /api/receipts/intake and its sub-routes.
 *
 * `/api/receipts/intake` is on the proxy's EXACT-MATCH public bypass
 * (src/proxy.ts) so machine callers get a clean 401 instead of a 307 to
 * /login. That makes this the ONLY gate on the route, so it fails closed
 * everywhere:
 *
 *   - no `RECEIPT_INTAKE_SECRET` configured  -> the secret path is refused
 *     outright, never "allow because unset" (getclients-auth-gate lesson).
 *   - a bogus/expired session cookie -> authenticateMobileOrSession returns
 *     ok:false, and this returns 401 JSON, never a redirect.
 *
 * RECEIPT_INTAKE_SECRET is deliberately a NEW variable, not the v1
 * RECEIPT_INGEST_SECRET: v1 and v2 must rotate independently, and during the
 * shadow week both pipelines are live at once.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { authenticateMobileOrSession } from "@/lib/mobile-auth";
import type { User } from "@prisma/client";

export const RECEIPT_INTAKE_SECRET_HEADER = "x-receipt-intake-secret";

export type IntakeAuth =
    | { ok: true; via: "secret"; user: null }
    | { ok: true; via: "session"; user: User }
    | { ok: false; response: NextResponse };

/** Constant-time compare over fixed-length digests, so header length leaks nothing. */
export function secretMatches(provided: string | null, expected: string | undefined): boolean {
    if (!expected) return false;
    const expectedDigest = createHash("sha256").update(expected).digest();
    const gotDigest = createHash("sha256").update(provided ?? "").digest();
    return timingSafeEqual(expectedDigest, gotDigest);
}

function unauthorized(): NextResponse {
    return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
}

/**
 * Secret first, then a session/mobile-Bearer user. A caller presenting a WRONG
 * secret header is refused outright rather than falling through to the session
 * check — a machine caller with a stale secret must see 401, not silently
 * succeed because a browser cookie happened to ride along.
 */
export async function authenticateIntake(req: Request): Promise<IntakeAuth> {
    const provided = req.headers.get(RECEIPT_INTAKE_SECRET_HEADER);
    if (provided !== null) {
        if (secretMatches(provided, process.env.RECEIPT_INTAKE_SECRET)) {
            return { ok: true, via: "secret", user: null };
        }
        return { ok: false, response: unauthorized() };
    }

    const auth = await authenticateMobileOrSession(req);
    if (!auth.ok) {
        // Preserve 403 for a DISABLED account; everything else is 401 JSON.
        return {
            ok: false,
            response: NextResponse.json({ ok: false, reason: "unauthorized" }, { status: auth.status }),
        };
    }
    return { ok: true, via: "session", user: auth.user };
}

export const STAFF_READ_ROLES = ["ADMIN", "MANAGER", "FINANCE"];
