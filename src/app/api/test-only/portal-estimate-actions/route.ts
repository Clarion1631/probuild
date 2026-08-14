import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { markEstimateViewed, getEstimateForPortal } from "@/lib/actions";

/**
 * TEST-ONLY dispatcher for the portal estimate-viewing server-action family.
 *
 * WHY THIS EXISTS
 * ---------------
 * markEstimateViewed's gate (same ownership + shared-ness predicate as
 * getEstimateForPortal, src/lib/actions.ts) is only reachable from a browser
 * test through /portal/estimates/[id], and that page 404s BEFORE it ever
 * renders PortalEstimateClient — which is the component that calls
 * markEstimateViewed. A blocked page never invokes the action, so a Playwright
 * spec driving the browser can prove the PAGE is blocked (e2e/portal-estimate-
 * access.spec.ts already does) but can never prove the ACTION's own gate holds
 * if something else ever came to call it directly. This is the same gap
 * contract-actions/route.ts closes for the contract family — see that file's
 * docstring for the full argument.
 *
 * WHY IT IS NOT A PRIVILEGE ESCALATION
 * ------------------------------------
 * It grants nothing. It does not construct a session, does not impersonate,
 * and does not bypass a single guard — it forwards the request's own cookies
 * (the client_portal_token, in this case) into the action and reports what the
 * action decided. A caller can already trigger markEstimateViewed by opening a
 * shared estimate in the portal; this route only makes the invocation
 * addressable by name so a test can assert on the DB row afterward instead of
 * inferring it from a side-effect email or activity post.
 *
 * THREE INDEPENDENT ENVIRONMENT/CREDENTIAL GATES, plus an allowlist:
 *  1. E2E_TEST_ROUTES must be exactly "1" — an explicit, positive opt-in whose
 *     ONLY purpose is enabling test routes. Deriving "test routes are on" from
 *     an auth secret would make the route a side effect of a credential rather
 *     than a decision, so a secret that leaked into an environment would
 *     silently switch it on. This flag is set nowhere but the CI Playwright job.
 *  2. PLAYWRIGHT_TEST_SECRET must be set. Production does not set it (it is
 *     also what registers the test-only CredentialsProvider in lib/auth.ts —
 *     see CLAUDE.md).
 *  3. VERCEL_ENV must not be "production". This one FAILS OPEN when VERCEL_ENV
 *     is undefined (self-hosted, or a promoted artifact), which is exactly why
 *     it is the belt and gate 1 is the braces — never rely on it alone.
 *  4. Then: the request must present that secret in `x-e2e-secret`, compared in
 *     constant time, and name one of the two allowlisted actions.
 *
 * Every rejection is a bare 404, not a 401/403: an enabled-but-unauthorized
 * caller learns nothing about whether the route exists. Thrown errors are
 * mapped through a known-message allowlist rather than returned raw.
 *
 * The proxy bypass this route needs (src/proxy.ts) repeats gates 1–3 verbatim
 * and additionally refuses anything carrying a `next-action` header, so
 * bypassing the proxy can never also mean bypassing the Server Action boundary.
 */

export const dynamic = "force-dynamic";

// getEstimateForPortal is projected down to { id, code, status } ONLY. The
// gate under test exists specifically so pricing does not leak to a client who
// hasn't been shared the estimate — returning the action's full result (items,
// paymentSchedules, invoices, client records, files) here would make this
// dispatcher a strictly wider door than the assertion it supports. The tests
// only need to distinguish "reachable" from "null".
const ACTIONS: Record<string, (...args: any[]) => Promise<any>> = {
    markEstimateViewed,
    getEstimateForPortal: async (id: string) => {
        const estimate: any = await getEstimateForPortal(id);
        if (!estimate) return null;
        return { id: estimate.id, code: estimate.code, status: estimate.status };
    },
};

/**
 * Errors are reported by an allowlist of the messages the guards themselves
 * raise. Neither action in this family currently throws on an authorization
 * failure — both fail closed by returning null/void — so this allowlist stays
 * empty for now; it exists so a future guard change that starts throwing
 * doesn't leak a raw Error.message by default.
 */
const REPORTABLE_ERRORS = new Set<string>([]);

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

/**
 * Keep IDENTICAL to the matching condition in src/proxy.ts. Two gates that are
 * meant to agree and quietly don't is the exact defect the contract-actions
 * pair (Codex round-1) found.
 */
// NOT exported: a route module may only export the framework's own names.
function testOnlyRoutesEnabled(): boolean {
    return (
        process.env.E2E_TEST_ROUTES === "1"
        && !!process.env.PLAYWRIGHT_TEST_SECRET
        // The POSITIVE condition. Every other clause here is a negative — an
        // absent variable satisfies it — so on a self-hosted production server
        // with no VERCEL_ENV at all, a "not production" clause alone would
        // enable itself. This one has to be affirmatively true: either we are
        // not a production build, or we are the CI Playwright job (which runs
        // `npm run start`, i.e. NODE_ENV=production, with CI=true). A real
        // production server is neither.
        && (process.env.NODE_ENV !== "production" || process.env.CI === "true")
        && process.env.VERCEL_ENV !== "production"
    );
}

const NOT_FOUND = () => new NextResponse("Not Found", { status: 404 });

export async function POST(req: Request) {
    if (!testOnlyRoutesEnabled()) return NOT_FOUND();
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
        const message = (e as Error)?.message ?? "";
        return NextResponse.json({
            ok: false,
            error: REPORTABLE_ERRORS.has(message) ? message : "Internal error",
        });
    }
}
