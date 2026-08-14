import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import {
    getContract,
    updateContract,
    deleteContract,
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
 * THREE INDEPENDENT ENVIRONMENT/CREDENTIAL GATES, plus an allowlist:
 *  1. E2E_TEST_ROUTES must be exactly "1" — an explicit, positive opt-in whose
 *     ONLY purpose is enabling test routes. Codex's point: deriving "test
 *     routes are on" from an auth secret makes the route a side effect of a
 *     credential rather than a decision, so a secret that leaked into an
 *     environment would silently switch it on. This flag is set nowhere but
 *     the CI Playwright job.
 *  2. PLAYWRIGHT_TEST_SECRET must be set. Production does not set it (it is
 *     also what registers the test-only CredentialsProvider in lib/auth.ts —
 *     see CLAUDE.md).
 *  3. VERCEL_ENV must not be "production". Note this one FAILS OPEN when
 *     VERCEL_ENV is undefined (self-hosted, or a promoted artifact), which is
 *     exactly why it is the belt and gate 1 is the braces — never rely on it
 *     alone.
 *  4. Then: the request must present that secret in `x-e2e-secret`, compared in
 *     constant time, and name one of the eight allowlisted actions.
 *
 * Every rejection is a bare 404, not a 401/403: an enabled-but-unauthorized
 * caller learns nothing about whether the route exists. Thrown errors are
 * mapped through a known-message allowlist rather than returned raw, so a
 * malformed argument cannot surface Prisma model names or source paths the way
 * an unsanitized `Error.message` would.
 *
 * The proxy bypass this route needs (src/proxy.ts) repeats gates 1–3 verbatim
 * and additionally refuses anything carrying a `next-action` header, so
 * bypassing the proxy can never also mean bypassing the Server Action boundary.
 */

export const dynamic = "force-dynamic";

// Exactly the family under test, plus getLead — whose embedded `contracts`
// relation was the Codex round-1 blocker (an anonymous caller holding a lead id
// received every contract field, including the signing accessToken, through an
// action that is not itself part of the contract family).
//
// `getContracts` and `getExecutedContractPdf` were in this allowlist until they
// were DELETED from actions.ts as caller-less dead surface. They had no product
// caller — this dispatcher was the only thing importing them — and a "use
// server" export is a live POST endpoint regardless, so keeping them alive
// purely so this suite could prove their gates behave was backwards. The scope
// rule and the by-id gate they exercised are both still covered here: the list
// side by getLead's embedded contracts relation and the two staff contract
// pages (which query Prisma directly and never went through getContracts), and
// the executed-PDF lookup by the portal page's use of the session-free core.
// See docs/CONTRACTS.md.
const ACTIONS: Record<string, (...args: any[]) => Promise<any>> = {
    getContract,
    updateContract,
    deleteContract,
    getContractSigningHistory,
    getContractSendDefaults,
    // Projected down to the id and the contracts relation. getLead otherwise
    // returns the client record, tasks, manager, room designs and the linked
    // project — none of which this route is here to expose, and all of which
    // would make the dispatcher a strictly wider door than the assertion it
    // supports. The test only ever reads `.contracts`.
    getLead: async (id: string) => {
        const lead: any = await getLead(id);
        if (!lead) return null;
        return { id: lead.id, contracts: lead.contracts ?? [] };
    },
};

/**
 * Errors are reported by an allowlist of the messages the guards themselves
 * raise — the ones a caller can already read off the UI, and the only ones the
 * tests distinguish. Anything else collapses to a generic string rather than
 * echoing a raw `Error.message`, which on a malformed argument can carry Prisma
 * model names, column names and absolute source paths.
 */
const REPORTABLE_ERRORS = new Set([
    "Unauthorized",
    "Forbidden",
]);
// Deliberately just those two. An earlier version also passed through "Contract
// not found" and the ownerless-contract message; Codex pointed out that
// "not found" vs "Forbidden" is an existence oracle for a staff caller who
// holds the `contracts` permission but not the scope — precisely the caller
// assertContractAccess orders its checks to deny that distinction to. Every
// other failure is still fully detectable as `ok: false`; only its wording is
// withheld, and no test needs the wording.

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
 * meant to agree and quietly don't is the exact defect Codex found in the first
 * version of this pair.
 */
// NOT exported: a route module may only export the framework's own names.
function testOnlyRoutesEnabled(): boolean {
    return (
        process.env.E2E_TEST_ROUTES === "1"
        && !!process.env.PLAYWRIGHT_TEST_SECRET
        // The POSITIVE condition. Every other clause here is a negative — an
        // absent variable satisfies it — so on a self-hosted production server
        // with no VERCEL_ENV at all, the earlier version enabled itself. This
        // one has to be affirmatively true: either we are not a production
        // build, or we are the CI Playwright job (which runs `npm run start`,
        // i.e. NODE_ENV=production, with CI=true). A real production server is
        // neither.
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
