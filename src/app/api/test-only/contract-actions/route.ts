import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import {
    getContracts,
    getContract,
    updateContract,
    deleteContract,
    getExecutedContractPdf,
    getContractSigningHistory,
    getContractSendDefaults,
    getLead,
} from "@/lib/actions";

/**
 * TEST-ONLY dispatcher for the contract server-action family.
 *
 * WHY THIS EXISTS
 * ---------------
 * The contract guards (assertContractAccess / canAccessContract /
 * contractScopeWhere, PR #367) were covered only by source-pattern assertions
 * in e2e/financial-action-auth.spec.ts: read actions.ts as text, check the
 * guard tokens appear in the right order. Codex flagged that twice as only
 * partially sufficient — any refactor that keeps the token shapes while
 * changing the semantics passes. Proving the guards BEHAVE requires actually
 * invoking the actions as a specific caller and asserting the outcome.
 *
 * Server Actions are addressed over the wire by a build-hash `Next-Action` id,
 * and the actions under test are called from server components, so they have
 * no stable client reference a test could POST to. This route is the smallest
 * thing that closes that gap: a dispatcher that calls the SAME exported
 * functions the app calls, inside a real request, with the caller's own
 * cookies.
 *
 * WHY IT IS NOT A PRIVILEGE ESCALATION
 * ------------------------------------
 * It grants nothing. It does not construct a session, does not impersonate,
 * and does not bypass a single guard — it forwards the request's own identity
 * into the action and reports what the action decided. A caller can already
 * invoke every one of these actions through the app; this route only makes the
 * invocation addressable by name so a test can assert on the answer. The error
 * message is returned verbatim precisely BECAUSE the meaningful assertion is
 * "Forbidden" vs "Unauthorized" vs data — and the actions already surface both
 * strings to any caller who triggers them through the UI.
 *
 * FOUR INDEPENDENT GATES, so a single mistake does not expose it:
 *  1. PLAYWRIGHT_TEST_SECRET must be set. Production does not set it (it is
 *     also what registers the test-only CredentialsProvider in lib/auth.ts —
 *     see CLAUDE.md), so in production this module answers 404 and nothing
 *     below it ever runs.
 *  2. VERCEL_ENV must not be "production", belt-and-braces against the secret
 *     ever being added to the prod environment by accident.
 *  3. The request must present that same secret in `x-e2e-secret`, compared in
 *     constant time.
 *  4. Only the eight allowlisted action names dispatch at all.
 *
 * Every rejection is a bare 404, not a 401/403: an enabled-but-unauthorized
 * caller learns nothing about whether the route exists.
 *
 * The proxy bypass this route needs (src/proxy.ts) is gated on the SAME
 * PLAYWRIGHT_TEST_SECRET, so it too is dead code in production. The bypass is
 * required only so an UNAUTHENTICATED request reaches the action and is
 * refused by the action's own gate, rather than being bounced to /login by the
 * proxy — the proxy redirect would prove nothing about assertContractAccess.
 */

export const dynamic = "force-dynamic";

// Exactly the family under test, plus getLead — whose embedded `contracts`
// relation was the Codex round-1 blocker (an anonymous caller holding a lead id
// received every contract field, including the signing accessToken, through an
// action that is not itself part of the contract family).
const ACTIONS: Record<string, (...args: any[]) => Promise<any>> = {
    getContracts,
    getContract,
    updateContract,
    deleteContract,
    getExecutedContractPdf,
    getContractSigningHistory,
    getContractSendDefaults,
    getLead,
};

function secretMatches(provided: string | null): boolean {
    const expected = process.env.PLAYWRIGHT_TEST_SECRET;
    if (!expected || !provided) return false;
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    // timingSafeEqual throws on a length mismatch, which would itself be a
    // length oracle if it escaped as a 500. Compare lengths first, and keep the
    // comparison constant time for equal-length candidates.
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
}

function enabled(): boolean {
    return !!process.env.PLAYWRIGHT_TEST_SECRET && process.env.VERCEL_ENV !== "production";
}

const NOT_FOUND = () => new NextResponse("Not Found", { status: 404 });

export async function POST(req: Request) {
    if (!enabled()) return NOT_FOUND();
    if (!secretMatches(req.headers.get("x-e2e-secret"))) return NOT_FOUND();

    const body = await req.json().catch(() => null);
    const name = typeof body?.action === "string" ? body.action : "";
    const args = Array.isArray(body?.args) ? body.args : [];

    const action = Object.prototype.hasOwnProperty.call(ACTIONS, name) ? ACTIONS[name] : undefined;
    if (!action) return NextResponse.json({ ok: false, error: "Unknown action" }, { status: 400 });

    try {
        const data = await action(...args);
        // Prisma Decimal / Date do not survive NextResponse.json on their own
        // in a shape a test can compare; normalize through JSON first.
        return NextResponse.json({ ok: true, data: JSON.parse(JSON.stringify(data ?? null)) });
    } catch (e) {
        // 200 with ok:false, deliberately: the test asserts on WHICH error the
        // action threw, and an HTTP error status would be indistinguishable
        // from the proxy or the framework rejecting the request first.
        return NextResponse.json({ ok: false, error: (e as Error).message });
    }
}
