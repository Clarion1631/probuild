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
 * THREE SECRETS, NOT ONE. They belong to three different programs with three
 * different blast radii. Each line below is the COMPLETE capability list for
 * that key — if a route needs something not on its key's list, it needs a
 * different key, not a wider one.
 *
 *   RECEIPT_INTAKE_SECRET  — the Apps Script forwarders.
 *     MAY: POST /api/receipts/intake, /intake/start, /intake/{id}/finalize,
 *          and only under source drive | email | chat.
 *     MAY NOT: read the queue, see another job's receipts, archive anything,
 *          resolve a missing-receipt chase.
 *   RECEIPT_ARCHIVE_SECRET — the nightly Drive archive mirror.
 *     MAY: GET /api/receipts/intake?state=BOOKED (BOOKED/ARCHIVED rows only),
 *          POST /api/receipts/intake/{id}/archived.
 *     MAY NOT: create a row, publish one, change a document's contents,
 *          resolve a missing-receipt chase.
 *   RECEIPT_BRIDGE_SECRET  — Beverly's Chat bridge (Phase 2 §4).
 *     MAY: GET /api/automation/receipt-requests/threads (export live threads),
 *          POST /api/automation/receipt-requests/answers (record a SIGNED memo
 *          against one of our own fingerprints).
 *     MAY NOT: touch a ReceiptIntake row at all — not create one, not read
 *          one, not archive one.
 *
 * One shared secret gave a script that only copies files to Drive the power to
 * inject Purchases into the books, and gave the ingest forwarders the power to
 * enumerate every receipt in the system. The bridge is the same argument a
 * third time: it runs in Beverly's Apps Script project, not ours, and its key
 * must not be able to book anything. A leak of any one of the three is bounded
 * by what that program actually does, and they rotate independently.
 *
 * Presenting the WRONG one of the three is a 403, not a 401 — see
 * wrongCapability.
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
 * Which of the three programs presented this secret, or null for none.
 *
 * ALL THREE COMPARES ALWAYS RUN. Short-circuiting on the first match would make
 * the response time depend on WHICH key was presented, which is a free hint to
 * anyone probing.
 *
 * A value configured for more than one of the variables silently re-merges
 * capabilities that exist to be separate, so it is refused outright rather than
 * resolved in some order.
 */
function classifySecret(provided: string): IntakeCapability | null {
    const matched: IntakeCapability[] = [];
    for (const [capability, expected] of [
        ["ingest", process.env.RECEIPT_INTAKE_SECRET],
        ["archive", process.env.RECEIPT_ARCHIVE_SECRET],
        ["bridge", process.env.RECEIPT_BRIDGE_SECRET],
    ] as const) {
        // Unset means that capability is refused outright — never "allow
        // because unset" (secretMatches returns false for an absent expected).
        if (secretMatches(provided, expected)) matched.push(capability);
    }
    if (matched.length === 0) return null;
    if (matched.length > 1) {
        console.error("[receipts/intake] receipt secrets are not distinct:", matched.join(" == "));
        return null;
    }
    return matched[0];
}

/**
 * Secret-only auth for the machine bridge endpoints (Phase 2 §4).
 *
 * NO SESSION BRANCH, deliberately: these are Apps Script endpoints on the
 * proxy's exact-match bypass, and a browser has no business posting a signed
 * memo. Cross-use is a 403 with both capabilities named, so a mis-wired script
 * is obvious instead of looking like a rotation problem.
 */
export function authenticateBridge(
    req: Request,
    need: IntakeCapability = "bridge",
): { ok: true; capability: IntakeCapability } | { ok: false; response: NextResponse } {
    const provided = req.headers.get(RECEIPT_INTAKE_SECRET_HEADER);
    if (provided === null) return { ok: false, response: unauthorized() };
    const verdict = classifySecret(provided);
    if (verdict === null) return { ok: false, response: unauthorized() };
    if (verdict !== need) return { ok: false, response: wrongCapability(verdict, need) };
    return { ok: true, capability: verdict };
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
        // THE TWO-SECRET INVARIANT MUST HOLD REGARDLESS OF WHAT WAS PRESENTED.
        //
        // Both intake secrets configured, non-empty, and distinct — checked
        // BEFORE any compare against `provided`. Checking it only by way of
        // "both matched the same value" (the old shape) missed the far more
        // likely misconfiguration: just ONE var set (a rotation half-done, a
        // preview env missing a copy-paste). With only RECEIPT_INTAKE_SECRET
        // set, `secretMatches(provided, archive)` is false for every input —
        // not because the caller lacks the archive key, but because there IS
        // no archive key — so a caller holding the ingest secret sailed
        // through untouched while the archive program was silently
        // unreachable by anyone AND the ingest key was one env-var away from
        // also being accepted as the archive key the moment someone filled it
        // in wrong.
        //
        // Scoped to the two INTAKE secrets deliberately: RECEIPT_BRIDGE_SECRET
        // belongs to a different program (authenticateBridge) whose absence
        // must not take the forwarders down. classifySecret below still runs
        // all three compares and refuses any value that matches more than one.
        const ingest = process.env.RECEIPT_INTAKE_SECRET;
        const archive = process.env.RECEIPT_ARCHIVE_SECRET;
        if (!ingest || !archive || ingest === archive) {
            console.error("[receipts/intake] RECEIPT_INTAKE_SECRET / RECEIPT_ARCHIVE_SECRET misconfigured (missing or identical) — refusing every secret-authenticated request");
            return { ok: false, response: unauthorized() };
        }

        const verdict = classifySecret(provided);
        if (verdict === null) return { ok: false, response: unauthorized() };
        if (verdict !== need) return { ok: false, response: wrongCapability(verdict, need) };

        return {
            ok: true,
            via: "secret",
            user: null,
            userVia: null,
            capability: verdict,
            allowedSources: verdict === "ingest" ? INGEST_ALLOWED_SOURCES : new Set(),
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
