/**
 * Auth for /api/receipts/intake and its sub-routes.
 *
 * Every one of these paths is on the proxy's EXACT-MATCH public bypass
 * (src/proxy.ts) so machine callers get a clean 401 instead of a 307 to
 * /login. That makes this the ONLY gate, so it fails closed everywhere:
 *
 *   - no secret configured -> that capability is refused outright, never
 *     "allow because unset" (getclients-auth-gate lesson).
 *   - a bogus/expired session cookie -> authenticateMobileOrSession returns
 *     ok:false, and this returns 401 JSON, never a redirect.
 *
 * TWO SECRETS, NOT ONE. They belong to different programs with different
 * blast radii:
 *
 *   RECEIPT_INTAKE_SECRET  — the forwarders. May only INGEST, and only under
 *     the sources they actually own (drive/email/chat). Cannot read the queue,
 *     cannot see another job's receipts, cannot archive anything.
 *   RECEIPT_ARCHIVE_SECRET — the nightly Drive mirror. May only READ
 *     BOOKED/ARCHIVED rows and report back what it archived. Cannot create a
 *     row, cannot publish one, cannot touch a document's contents.
 *
 * One shared secret gave a script that only copies files to Drive the power to
 * inject Purchases into the books, and gave the ingest forwarders the power to
 * enumerate every receipt in the system. Splitting them means a leak of either
 * one is bounded by what that program actually does. They rotate independently
 * for the same reason.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { authenticateMobileOrSession } from "@/lib/mobile-auth";
import type { User } from "@prisma/client";

export const RECEIPT_INTAKE_SECRET_HEADER = "x-receipt-intake-secret";

/** What a caller is asking to do. Checked against the secret it presented. */
export type IntakeCapability = "ingest" | "archive" | "bridge";

export type IntakeAuth =
    | {
        ok: true;
        via: "secret";
        user: null;
        userVia: null;
        capability: IntakeCapability;
        /** Sources this secret may declare. Empty for the archive secret. */
        allowedSources: ReadonlySet<string>;
    }
    /** `userVia` distinguishes the crew app from a browser — the route mints `source` from it. */
    | { ok: true; via: "session"; user: User; userVia: "mobile-jwt" | "next-auth" }
    | { ok: false; response: NextResponse };

/** The forwarders own these three and nothing else. */
export const INGEST_ALLOWED_SOURCES: ReadonlySet<string> = new Set(["drive", "email", "chat"]);

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

function wrongCapability(have: IntakeCapability, need: IntakeCapability): NextResponse {
    // 403, not 401: the caller IS authenticated, it just holds the other
    // program's key. Saying so is what makes a mis-wired script obvious
    // instead of looking like a rotation problem.
    return NextResponse.json(
        { ok: false, reason: "forbidden", have, need },
        { status: 403 },
    );
}

/**
 * Secret first, then a session/mobile-Bearer user.
 *
 * `need` is what the ROUTE requires. A caller presenting a valid secret for the
 * OTHER capability is refused with 403 rather than falling through to the
 * session check — a forwarder must never be able to read the queue by holding
 * the ingest key, and the mirror must never be able to create a row.
 */
export async function authenticateIntake(
    req: Request,
    need: IntakeCapability = "ingest",
): Promise<IntakeAuth> {
    const provided = req.headers.get(RECEIPT_INTAKE_SECRET_HEADER);
    if (provided !== null) {
        const ingest = process.env.RECEIPT_INTAKE_SECRET;
        const archive = process.env.RECEIPT_ARCHIVE_SECRET;

        // Both compares always run: short-circuiting on the first match would
        // make the response time depend on WHICH key was presented.
        const isIngest = secretMatches(provided, ingest);
        const isArchive = secretMatches(provided, archive);

        if (!isIngest && !isArchive) return { ok: false, response: unauthorized() };

        // A single value configured for both variables is a misconfiguration
        // that would silently re-merge the two capabilities. Refuse it.
        if (isIngest && isArchive) {
            console.error("[receipts/intake] RECEIPT_INTAKE_SECRET and RECEIPT_ARCHIVE_SECRET are identical");
            return { ok: false, response: unauthorized() };
        }

        const capability: IntakeCapability = isIngest ? "ingest" : "archive";
        if (capability !== need) return { ok: false, response: wrongCapability(capability, need) };

        return {
            ok: true,
            via: "secret",
            user: null,
            userVia: null,
            capability,
            allowedSources: capability === "ingest" ? INGEST_ALLOWED_SOURCES : new Set(),
        };
    }

    const auth = await authenticateMobileOrSession(req);
    if (!auth.ok) {
        // Preserve 403 for a DISABLED account; everything else is 401 JSON.
        return {
            ok: false,
            response: NextResponse.json({ ok: false, reason: "unauthorized" }, { status: auth.status }),
        };
    }
    return { ok: true, via: "session", user: auth.user, userVia: auth.via };
}

export const STAFF_READ_ROLES = ["ADMIN", "MANAGER", "FINANCE"];
