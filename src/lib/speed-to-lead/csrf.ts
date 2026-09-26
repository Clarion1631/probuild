import { createHmac, timingSafeEqual } from "node:crypto";
import { APPROVAL_COMMIT_WINDOW_MS } from "./constants";

/**
 * Session-bound CSRF token for the outreach approve/edit/regenerate/send-again
 * Server Actions (spec Approval "How": "Approve is a POST Server Action ...
 * with an origin check and a session-bound CSRF token"). Minted when the
 * outreach detail page renders (a GET — never mutates), verified inside the
 * action.
 *
 * Not a general CSRF framework — scoped to exactly this action, bound to the
 * session email plus the message/version it authorizes, so a token minted
 * for one draft can never authorize a different one.
 */
function secret(): string {
    return process.env.NEXTAUTH_SECRET ?? "";
}

/**
 * `issuedAt` binds the token to a bounded window rather than the session
 * email alone — a token minted once used to verify forever, for any future
 * session under that email, which is not "session-bound" at all. It expires
 * after APPROVAL_COMMIT_WINDOW_MS, the same window the approval it gates must
 * itself commit within (spec Approval), so the token can never outlive the
 * action it authorizes.
 */
export function mintOutreachCsrfToken(sessionEmail: string, messageId: string, versionId: string, issuedAt: number = Date.now()): string {
    const sig = createHmac("sha256", secret()).update(`${sessionEmail}:${messageId}:${versionId}:${issuedAt}`).digest("hex");
    return `${issuedAt}.${sig}`;
}

export function verifyOutreachCsrfToken(token: string, sessionEmail: string, messageId: string, versionId: string, now: number = Date.now()): boolean {
    if (!secret()) return false;
    const dot = token.indexOf(".");
    if (dot <= 0) return false;
    const issuedAtRaw = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const issuedAt = Number(issuedAtRaw);
    if (!Number.isFinite(issuedAt) || issuedAt > now || now - issuedAt > APPROVAL_COMMIT_WINDOW_MS) return false;
    const expected = createHmac("sha256", secret()).update(`${sessionEmail}:${messageId}:${versionId}:${issuedAt}`).digest("hex");
    const a = Buffer.from(sig, "hex");
    const b = Buffer.from(expected, "hex");
    if (a.length === 0 || a.length !== b.length) return false;
    return timingSafeEqual(a, b);
}

/** True when the request's Origin header matches this app's own base URL. */
export function isSameOriginRequest(originHeader: string | null, env: NodeJS.ProcessEnv = process.env): boolean {
    if (!originHeader) return false;
    const expected = env.NEXT_PUBLIC_APP_URL || env.NEXTAUTH_URL || "";
    if (!expected) return false;
    try {
        return new URL(originHeader).origin === new URL(expected).origin;
    } catch {
        return false;
    }
}
