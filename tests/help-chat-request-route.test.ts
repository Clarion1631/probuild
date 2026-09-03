/**
 * Request-level test for POST /api/help-chat/request — the crew app's actual
 * bug-report call (apps/mobile/lib/bugReport.ts).
 *
 * tests/help-chat-submission-guard.test.ts pins checkHelpSubmission() and the
 * route's SOURCE TEXT in isolation, but neither proves the wired-together
 * route actually answers 2xx for the app's real payload — a passing regex and
 * a working POST are different claims. That gap is exactly how the previous
 * round's fix (requiring `submissionId` on every Bearer request) shipped
 * without anyone noticing the real mobile payload has no such field: every
 * assertion about it was a grep, never an actual call through POST().
 *
 * THIS FILE MUST NEVER STATICALLY IMPORT `src/lib/help-chat/submission-guard`
 * (or anything else that imports it) AT THE TOP LEVEL. That module's own
 * `import { prisma } from "../prisma"` executes — and is cached — the first
 * time ANY file requires it, including transitively. If this file's top-level
 * imports pulled it in before the require() patch below installs, the patch
 * would have nothing left to intercept: Node's module cache returns the
 * already-loaded (real-prisma) instance on every later require of the same
 * resolved path, regardless of which literal specifier asks for it. (This is
 * exactly what happened when this test first lived inside
 * help-chat-submission-guard.test.ts, which imports from submission-guard.ts
 * at its own top level — the route's DB calls hit a real, unreachable
 * Postgres and every assertion failed with a connection error, not a status
 * mismatch.) Keeping the route's entire dependency chain isolated to the
 * dynamic import inside before() is what makes the patch load-bearing rather
 * than a no-op.
 *
 * HOW THE MOCK IS APPLIED: a manual `Module.prototype.require` patch, not
 * `node:test`'s `mock.module()` — see tests/takeoff-convert-tax.test.ts's
 * header for the full Node-20-vs-22+ story (`mock.module()` corrupts the
 * require chain on Node 20, which is what CI pins; this workstation runs
 * Node 24 and never sees it). The patch is scoped to the two literal
 * specifier strings the route's dependency graph actually uses for its
 * prisma import — confirmed by logging every require() call while loading
 * the route, not guessed: route.ts and mobile-auth.ts both write
 * `from "@/lib/prisma"`; submission-guard.ts (one directory deeper, at
 * src/lib/help-chat/) writes the relative `from "../prisma"`. Both resolve
 * to the same file, but the patch matches on the UNRESOLVED literal text tsx
 * leaves in the compiled require() call, so both have to be listed.
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

process.env.NEXTAUTH_SECRET ??= "test-secret-for-help-chat-request-route-tests";
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test?pgbouncer=true";

// The crew app's exact payload (apps/mobile/lib/bugReport.ts) — no
// submissionId, no conversationId. Mirrors MOBILE_PAYLOAD in
// help-chat-submission-guard.test.ts; if the two drift, that file's
// "the crew app's exact payload validates" test is the one to update first.
const MOBILE_PAYLOAD = {
    title: "Mobile bug: the Save button does nothing",
    description: [
        "**What happened**\nTapped Save and nothing happened",
        "**Reported from the ProBuild crew app**\n- Screen: Time Clock\n- App version: 1.1.1\n- Platform: ios 18.2",
    ].join("\n\n"),
    currentPage: "mobile:Time Clock",
};

const MOBILE_USER = {
    id: "mobile-crew-1",
    role: "FIELD_CREW",
    status: "ACTIVATED",
    email: "crew@example.com",
};

/** What the route reads/writes through prisma for one fresh (non-replay) reservation. */
const fakePrisma = {
    user: {
        findUnique: async ({ where }: { where: { id?: string } }) =>
            where.id === MOBILE_USER.id ? MOBILE_USER : null,
    },
    chatConversation: {
        // MOBILE_PAYLOAD carries no conversationId, so this branch never runs —
        // defined only so an unexpected call fails loudly instead of throwing
        // "findFirst is not a function".
        findFirst: async () => null,
    },
    helpRequest: {
        findUnique: async ({ where }: { where: { id: string } }) => ({
            id: where.id,
            providerState: "pending",
            status: "submitted_no_issue",
        }),
    },
    // reserveHelpRequest's transaction: one fresh INSERT ... RETURNING, then a
    // COUNT that sees no prior reports (quota untouched).
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx = {
            $queryRaw: (strings: TemplateStringsArray) => {
                const text = strings.join("?");
                if (text.includes('INSERT INTO "HelpRequest"')) {
                    return Promise.resolve([{ id: "mobile-req-1" }]);
                }
                if (text.includes("COUNT(*)::int AS count")) {
                    return Promise.resolve([{ count: 0 }]);
                }
                return Promise.resolve([]);
            },
            $executeRaw: () => Promise.resolve(1),
            helpRequest: { findUnique: async () => null },
        };
        return fn(tx);
    },
    // claimProviderLease / completeUnderLease, called on the top-level client.
    $executeRaw: () => Promise.resolve(1),
};

const PRISMA_SPECIFIERS = new Set(["@/lib/prisma", "../prisma"]);

let POST: (req: Request) => Promise<Response>;
let signMobileToken: (user: { id: string; role: string; email: string }, via: "pin" | "google") => Promise<string>;
let HELP_SUBMISSION_ID_MAX: number;

before(async () => {
    const originalRequire = Module.prototype.require;
    let requirePatchHit = false;
    (Module.prototype as unknown as { require: (id: string) => unknown }).require = function (
        this: NodeModule,
        id: string,
    ) {
        if (PRISMA_SPECIFIERS.has(id)) {
            requirePatchHit = true;
            return { prisma: fakePrisma };
        }
        // eslint-disable-next-line prefer-rest-params
        return originalRequire.apply(this, arguments as unknown as [string]);
    } as typeof Module.prototype.require;

    let routeModule: { POST?: unknown };
    let mobileAuthModule: { signMobileToken?: unknown };
    let guardModule: { HELP_SUBMISSION_ID_MAX?: unknown };
    try {
        // route.ts's own load pulls in mobile-auth.ts (imports "@/lib/prisma")
        // and submission-guard.ts (imports "../prisma") transitively — this is
        // the FIRST time either module loads in this process, so both execute
        // — and get faked — inside this one window.
        routeModule = await import("../src/app/api/help-chat/request/route");
        // Both already sit in Node's require cache from the load above (keyed
        // by resolved absolute path, not by which literal specifier asked for
        // it) — these just retrieve the same faked instances to read exports
        // this file needs directly.
        mobileAuthModule = await import("../src/lib/mobile-auth");
        guardModule = await import("../src/lib/help-chat/submission-guard");
    } finally {
        Module.prototype.require = originalRequire;
    }

    if (
        typeof routeModule.POST !== "function" ||
        typeof mobileAuthModule.signMobileToken !== "function" ||
        typeof guardModule.HELP_SUBMISSION_ID_MAX !== "number"
    ) {
        throw new Error(
            `help-chat-request-route.test.ts: prisma mock did not apply — ` +
                `route POST is ${typeof routeModule.POST}, signMobileToken is ` +
                `${typeof mobileAuthModule.signMobileToken}, HELP_SUBMISSION_ID_MAX is ` +
                `${typeof guardModule.HELP_SUBMISSION_ID_MAX}. The require() patch ` +
                `${requirePatchHit ? "WAS" : "was NOT"} hit for one of ${[...PRISMA_SPECIFIERS].join(", ")}. ` +
                `If this fires, a prisma import in the route's dependency chain is using a ` +
                `different literal specifier string on this Node/tsx combination — update ` +
                `PRISMA_SPECIFIERS to match.`
        );
    }
    POST = routeModule.POST as typeof POST;
    signMobileToken = mobileAuthModule.signMobileToken as typeof signMobileToken;
    HELP_SUBMISSION_ID_MAX = guardModule.HELP_SUBMISSION_ID_MAX as number;
});

test("the crew app's exact payload, posted with a real Bearer token, is accepted (2xx) — not the 400 the old submissionId gate produced", async () => {
    const originalGithubToken = process.env.GITHUB_TOKEN;
    // createHelpChatGitHubIssue returns null (no network call) without one —
    // the intended path for this fixture, and the one that keeps this test
    // hermetic.
    delete process.env.GITHUB_TOKEN;
    try {
        const token = await signMobileToken(MOBILE_USER, "pin");
        const req = new Request("https://example.test/api/help-chat/request", {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: JSON.stringify(MOBILE_PAYLOAD),
        });

        const res = await POST(req);
        const body = await res.json();

        assert.ok(
            res.status >= 200 && res.status < 300,
            `expected 2xx, got ${res.status}: ${JSON.stringify(body)}`
        );
        // 202 "pending" is the correct outcome here: no GITHUB_TOKEN means the
        // report is saved but not yet filed (see helpChatResponse) — the old
        // bug never got this far at all, it 400'd before touching the DB.
        assert.equal(body.status, "pending");
        assert.equal(typeof body.submissionId, "string", "a derived key must be handed back for a future retry");
        assert.equal(body.submissionId.length, HELP_SUBMISSION_ID_MAX);
    } finally {
        if (originalGithubToken === undefined) delete process.env.GITHUB_TOKEN;
        else process.env.GITHUB_TOKEN = originalGithubToken;
    }
});
