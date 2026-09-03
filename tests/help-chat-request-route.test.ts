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

/**
 * A tiny in-memory "HelpRequest" table, honouring the two things the
 * idempotency contract actually rests on: the UNIQUE (userId, submissionId)
 * that makes a replay a replay, and createdAt, which the derived key's 24-hour
 * window is measured against.
 *
 * A stateless stub cannot test idempotency — "did this submission already
 * happen?" is a question about stored rows. The previous fixture always
 * answered "fresh insert", which is why a key that changed at a minute
 * boundary looked fine here.
 */
type FakeRow = {
    id: string;
    userId: string;
    submissionId: string | null;
    type: string;
    question: string;
    response: string;
    currentPage: string | null;
    conversationId: string | null;
    status: string;
    providerState: string | null;
    changeLocation: string | null;
    externalIssueRef: string | null;
    providerIssueRef: string | null;
    createdAt: Date;
};

const store: { rows: FakeRow[]; nextId: number } = { rows: [], nextId: 1 };

/** GitHub issues the fake provider has opened. Reset with the store, or counts leak between tests. */
let issueCounter = 0;

const CONVERSATION_ID = "conv-1";

function resetStore() {
    store.rows = [];
    store.nextId = 1;
    issueCounter = 0;
    filedIssues.length = 0;
}

/**
 * Let time pass, without faking the clock (CI pins Node 20, where
 * `mock.timers.setTime` does not exist). The route's window check compares
 * `Date.now()` against the stored `createdAt`, so pushing the stored rows into
 * the past is the same measurement from the other end.
 */
function ageStoredRowsBy(ms: number) {
    for (const row of store.rows) row.createdAt = new Date(row.createdAt.getTime() - ms);
}

const fakePrisma = {
    user: {
        findUnique: async ({ where }: { where: { id?: string } }) =>
            where.id === MOBILE_USER.id ? MOBILE_USER : null,
    },
    chatConversation: {
        // MOBILE_PAYLOAD carries no conversationId, so the /request tests never
        // reach this. The bug-fix route REQUIRES one, so it answers for the
        // single conversation those tests use and null for anything else — an
        // unexpected id then fails as a 404, loudly.
        findFirst: async ({ where }: { where: { id?: string } }) =>
            where.id === CONVERSATION_ID ? { id: CONVERSATION_ID } : null,
    },
    helpRequest: {
        findUnique: async ({ where }: { where: { id: string } }) =>
            store.rows.find((row) => row.id === where.id) ?? null,
    },
    /** deriveMobileSubmissionId's window lookup: newest generation of one content key. */
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const text = strings.join("?");
        if (text.includes('SELECT "submissionId", "createdAt" FROM "HelpRequest"')) {
            const [userId, likePattern] = values as [string, string];
            const prefix = likePattern.replace(/%$/, "");
            const matches = store.rows
                .filter((row) => row.userId === userId && (row.submissionId ?? "").startsWith(prefix))
                .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
            return matches.slice(0, 1).map((row) => ({ submissionId: row.submissionId, createdAt: row.createdAt }));
        }
        throw new Error(`unexpected top-level $queryRaw: ${text}`);
    },
    // reserveHelpRequest's transaction: INSERT ... ON CONFLICT DO NOTHING over
    // the store, then the rolling-window COUNT.
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx = {
            $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
                const text = strings.join("?");
                if (text.includes('INSERT INTO "HelpRequest"')) {
                    const [userId, type, question, response, currentPage, conversationId, submissionId] =
                        values as [string, string, string, string, string | null, string | null, string | null];
                    const conflict =
                        submissionId != null &&
                        store.rows.some((row) => row.userId === userId && row.submissionId === submissionId);
                    if (conflict) return [];
                    const row: FakeRow = {
                        id: `mobile-req-${store.nextId++}`,
                        userId,
                        submissionId,
                        type,
                        question,
                        response,
                        currentPage,
                        conversationId,
                        status: "submitting",
                        providerState: null,
                        changeLocation: null,
                        externalIssueRef: null,
                        providerIssueRef: null,
                        createdAt: new Date(),
                    };
                    store.rows.push(row);
                    return [{ id: row.id }];
                }
                if (text.includes("COUNT(*)::int AS count")) {
                    const [userId, windowStart, exceptId] = values as [string, Date, string];
                    const count = store.rows.filter(
                        (row) => row.userId === userId && row.createdAt >= windowStart && row.id !== exceptId
                    ).length;
                    return [{ count }];
                }
                throw new Error(`unexpected tx $queryRaw: ${text}`);
            },
            $executeRaw: async () => 1,
            helpRequest: {
                findUnique: async ({ where }: { where: { userId_submissionId: { userId: string; submissionId: string } } }) =>
                    store.rows.find(
                        (row) =>
                            row.userId === where.userId_submissionId.userId &&
                            row.submissionId === where.userId_submissionId.submissionId
                    ) ?? null,
            },
        };
        return fn(tx);
    },
    /** claimProviderLease / renewProviderLease / completeUnderLease. */
    $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const text = strings.join("?");
        if (text.includes(`"providerState" = 'created'`)) {
            const [status, issueUrl, externalRef, providerRef, requestId] = values as [
                string, string, string, string, string,
            ];
            const row = store.rows.find((r) => r.id === requestId);
            if (!row) return 0;
            Object.assign(row, {
                status,
                changeLocation: issueUrl,
                externalIssueRef: externalRef,
                providerIssueRef: providerRef,
                providerState: "created",
            });
            return 1;
        }
        if (text.includes(`"providerState" = 'pending'`)) {
            const [status, requestId] = values as [string, string];
            const row = store.rows.find((r) => r.id === requestId);
            if (!row) return 0;
            Object.assign(row, { status, providerState: "pending" });
            return 1;
        }
        // The lease claim/renewal: always granted in a single-threaded test.
        return 1;
    },
};

/**
 * The GitHub side, faked at the module boundary so a filed report can exist
 * without a network call. It still honours GITHUB_TOKEN, so the "no token =>
 * saved but not filed" test below reads exactly as it did against the real
 * module.
 */
/** Everything createHelpChatGitHubIssue was asked to file, newest last. */
const filedIssues: Array<{ title: string; description: string; currentPage: string | null; labelPrefix: string }> = [];

const fakeGithub = {
    createHelpChatGitHubIssue: async (args: {
        title: string;
        description: string;
        currentPage: string | null;
        labelPrefix: string;
    }) => {
        filedIssues.push({
            title: args.title,
            description: args.description,
            currentPage: args.currentPage ?? null,
            labelPrefix: args.labelPrefix,
        });
        return process.env.GITHUB_TOKEN
            ? { number: ++issueCounter, url: `https://github.test/probuild/issues/${issueCounter}` }
            : null;
    },
    findIssueByMarker: async () => null,
};

const MODULE_MOCKS = new Map<string, unknown>([
    ["@/lib/prisma", { prisma: fakePrisma }],
    ["../prisma", { prisma: fakePrisma }],
    ["@/lib/help-chat/github", fakeGithub],
]);

let POST: (req: Request) => Promise<Response>;
let BUG_FIX_POST: (req: Request) => Promise<Response>;
let signMobileToken: (user: { id: string; role: string; email: string }, via: "pin" | "google") => Promise<string>;
let HELP_SUBMISSION_ID_MAX: number;

before(async () => {
    const originalRequire = Module.prototype.require;
    let requirePatchHit = false;
    (Module.prototype as unknown as { require: (id: string) => unknown }).require = function (
        this: NodeModule,
        id: string,
    ) {
        if (MODULE_MOCKS.has(id)) {
            requirePatchHit = true;
            return MODULE_MOCKS.get(id);
        }
        // eslint-disable-next-line prefer-rest-params
        return originalRequire.apply(this, arguments as unknown as [string]);
    } as typeof Module.prototype.require;

    let routeModule: { POST?: unknown };
    let bugFixModule: { POST?: unknown } = {};
    let mobileAuthModule: { signMobileToken?: unknown };
    let guardModule: { HELP_SUBMISSION_ID_MAX?: unknown };
    try {
        // route.ts's own load pulls in mobile-auth.ts (imports "@/lib/prisma")
        // and submission-guard.ts (imports "../prisma") transitively — this is
        // the FIRST time either module loads in this process, so both execute
        // — and get faked — inside this one window.
        routeModule = await import("../src/app/api/help-chat/request/route");
        // The sibling route, loaded inside the SAME patch window: it shares
        // reserveHelpRequest and has to answer a reused idempotency key the
        // same way. Its whole dependency chain is already cached and faked by
        // the load above, so this adds no un-mocked prisma.
        bugFixModule = await import("../src/app/api/help-chat/bug-fix/route");
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
                `${requirePatchHit ? "WAS" : "was NOT"} hit for one of ${[...MODULE_MOCKS.keys()].join(", ")}. ` +
                `If this fires, a prisma import in the route's dependency chain is using a ` +
                `different literal specifier string on this Node/tsx combination — update ` +
                `PRISMA_SPECIFIERS to match.`
        );
    }
    if (typeof bugFixModule.POST !== "function") {
        throw new Error("help-chat-request-route.test.ts: the bug-fix route did not load under the prisma mock");
    }
    POST = routeModule.POST as typeof POST;
    BUG_FIX_POST = bugFixModule.POST as typeof BUG_FIX_POST;
    signMobileToken = mobileAuthModule.signMobileToken as typeof signMobileToken;
    HELP_SUBMISSION_ID_MAX = guardModule.HELP_SUBMISSION_ID_MAX as number;
});

/** One crew-app POST with a real Bearer token. */
async function postMobileReport(payload: Record<string, unknown> = MOBILE_PAYLOAD) {
    const token = await signMobileToken(MOBILE_USER, "pin");
    const res = await POST(
        new Request("https://example.test/api/help-chat/request", {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: JSON.stringify(payload),
        })
    );
    return { res, body: await res.json() };
}

test("the crew app's exact payload, posted with a real Bearer token, is accepted (2xx) — not the 400 the old submissionId gate produced", async () => {
    resetStore();
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
        assert.ok(body.submissionId.length <= HELP_SUBMISSION_ID_MAX);
        assert.match(body.submissionId, /^[a-f0-9]{48}-g1$/, "a first report is generation 1 of its content key");
    } finally {
        if (originalGithubToken === undefined) delete process.env.GITHUB_TOKEN;
        else process.env.GITHUB_TOKEN = originalGithubToken;
    }
});

// ── the retry the derived key exists for ───────────────────────────────────
// The crew app retries when a response is LOST, and the gap before the retry
// is whatever the network took. The first version of the derived key hashed
// floor(now/60s) into it, so a retry that happened to land on the far side of
// a minute boundary produced a different key — a second row, a second GitHub
// issue, for one report. The window is now applied as a lookup, so the key
// itself does not move; the "key carries no clock at all" half of that is
// pinned directly on the pure functions in
// tests/help-chat-submission-guard.test.ts.

test("a retry after a LOST response replays onto the original report — one issue, not two", async () => {
    resetStore();
    const originalGithubToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = "test-token";
    try {
        const first = await postMobileReport();
        assert.equal(first.body.status, "filed");
        const issue = first.body.githubIssue;
        assert.ok(issue, "the first attempt files the issue");
        assert.equal(store.rows.length, 1);

        // The app never saw that response, and retries 40 seconds later — the
        // gap that used to be able to straddle the old key's minute boundary.
        ageStoredRowsBy(40_000);
        const retry = await postMobileReport();

        assert.equal(retry.res.status, 200, "a replay of a FILED report is terminal");
        assert.equal(retry.body.duplicate, true);
        assert.equal(retry.body.status, "filed");
        assert.equal(retry.body.request.id, first.body.request.id, "same row, not a second report");
        // The ORIGINAL issue still comes back — through `githubIssue`, the
        // channel the widget reads, rather than by returning the stored row
        // with its provider lease token attached (round 10, finding 5).
        assert.equal(retry.body.githubIssue?.number, issue.number, "the ORIGINAL issue comes back");
        assert.ok(
            !("externalIssueRef" in retry.body.request),
            "and the raw workflow columns do not come with it"
        );
        assert.equal(store.rows.length, 1, "no second HelpRequest row");
        assert.equal(issueCounter, 1, "no second GitHub issue");
    } finally {
        if (originalGithubToken === undefined) delete process.env.GITHUB_TOKEN;
        else process.env.GITHUB_TOKEN = originalGithubToken;
    }
});

test("a retry hours later, still inside the 24h window, is the same replay", async () => {
    resetStore();
    const originalGithubToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = "test-token";
    try {
        const first = await postMobileReport();
        ageStoredRowsBy(21 * 60 * 60 * 1000);
        const retry = await postMobileReport();
        assert.equal(retry.body.request.id, first.body.request.id);
        assert.equal(store.rows.length, 1);
        assert.equal(issueCounter, 1);
    } finally {
        if (originalGithubToken === undefined) delete process.env.GITHUB_TOKEN;
        else process.env.GITHUB_TOKEN = originalGithubToken;
    }
});

test("the same report filed again 25 hours later is a NEW report — the window is generous, not permanent", async () => {
    resetStore();
    const originalGithubToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = "test-token";
    try {
        const first = await postMobileReport();
        ageStoredRowsBy(25 * 60 * 60 * 1000);
        const again = await postMobileReport();

        assert.notEqual(again.body.request.id, first.body.request.id, "a recurrence files its own report");
        assert.equal(again.body.duplicate, undefined);
        assert.equal(store.rows.length, 2);
        assert.equal(issueCounter, 2, "the bug came back — that is a second issue, on purpose");
        assert.match(String(store.rows[0].submissionId), /-g1$/);
        assert.match(String(store.rows[1].submissionId), /-g2$/);
    } finally {
        if (originalGithubToken === undefined) delete process.env.GITHUB_TOKEN;
        else process.env.GITHUB_TOKEN = originalGithubToken;
    }
});

test("a DIFFERENT report from the same crew member is never collapsed onto the first", async () => {
    resetStore();
    const originalGithubToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = "test-token";
    try {
        await postMobileReport();
        const other = await postMobileReport({ ...MOBILE_PAYLOAD, title: "Mobile bug: photos will not upload" });
        assert.equal(other.body.duplicate, undefined);
        assert.equal(store.rows.length, 2);
        assert.equal(issueCounter, 2);
    } finally {
        if (originalGithubToken === undefined) delete process.env.GITHUB_TOKEN;
        else process.env.GITHUB_TOKEN = originalGithubToken;
    }
});

// ── an idempotency key is bound to its payload (round 33, finding 3) ────────
//
// The gap: the conflict branch of reserveHelpRequest returned status metadata
// only. A second request could reuse a key with entirely different content,
// attach itself to the FIRST report's row, and open a GitHub issue describing
// text that row does not contain — so the saved report and the issue raised
// from it disagreed, and whichever one you read was the wrong one.

/** A crew-app POST carrying an EXPLICIT idempotency key. */
async function postWithKey(submissionId: string, payload: Record<string, unknown>) {
    const token = await signMobileToken(MOBILE_USER, "pin");
    const res = await POST(
        new Request("https://example.test/api/help-chat/request", {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: JSON.stringify({ ...payload, submissionId }),
        })
    );
    return { res, body: await res.json() };
}

async function postBugFix(submissionId: string, payload: Record<string, unknown>) {
    const token = await signMobileToken(MOBILE_USER, "pin");
    const res = await BUG_FIX_POST(
        new Request("https://example.test/api/help-chat/bug-fix", {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: JSON.stringify({ ...payload, submissionId, conversationId: CONVERSATION_ID }),
        })
    );
    return { res, body: await res.json() };
}

test("/request: a key reused for a DIFFERENT report is 409 — nothing filed, nothing attached", async () => {
    resetStore();
    const originalGithubToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = "test-token";
    try {
        const first = await postWithKey("key-1", MOBILE_PAYLOAD);
        assert.equal(first.body.status, "filed");
        assert.equal(store.rows.length, 1);
        assert.equal(filedIssues.length, 1);

        const second = await postWithKey("key-1", {
            ...MOBILE_PAYLOAD,
            title: "Totally different bug: the schedule is blank",
        });
        assert.equal(second.res.status, 409);
        assert.equal(second.body.code, "submission-key-conflict");
        assert.equal(store.rows.length, 1, "no row for the rejected report");
        assert.equal(filedIssues.length, 1, "and above all: no issue filed against the first report's row");
        assert.equal(store.rows[0].question, MOBILE_PAYLOAD.title, "the stored report is untouched");
    } finally {
        if (originalGithubToken === undefined) delete process.env.GITHUB_TOKEN;
        else process.env.GITHUB_TOKEN = originalGithubToken;
    }
});

test("/request: a RESUMED attempt files the STORED report, not the request that woke it", async () => {
    resetStore();
    const originalGithubToken = process.env.GITHUB_TOKEN;
    // No token: the first attempt saves the report and fails to file it — the
    // exact state a resume exists for.
    delete process.env.GITHUB_TOKEN;
    try {
        const first = await postWithKey("key-2", MOBILE_PAYLOAD);
        assert.equal(first.body.status, "pending");
        assert.equal(store.rows.length, 1);

        // Older than HELP_SUBMITTING_STALE_MS, so the retry RESUMES rather than
        // returning early.
        ageStoredRowsBy(5 * 60 * 1000);
        process.env.GITHUB_TOKEN = "test-token";

        // The same report, differing only in ways the fingerprint normalises
        // away (surrounding whitespace, absent vs empty). Still a resume — and
        // what gets filed is the row's own copy.
        const resumed = await postWithKey("key-2", {
            title: MOBILE_PAYLOAD.title,
            description: MOBILE_PAYLOAD.description,
            currentPage: MOBILE_PAYLOAD.currentPage,
        });
        assert.equal(resumed.res.status, 200);
        assert.equal(store.rows.length, 1, "still one report");
        // The first attempt CALLED GitHub and got nothing back (no token), so
        // there are two attempts on record and exactly one issue.
        assert.equal(issueCounter, 1, "one issue exists for one report");
        const filed = filedIssues[filedIssues.length - 1];
        assert.equal(filed.title, store.rows[0].question, "the issue title is the STORED title");
        assert.equal(filed.description, store.rows[0].response);
        assert.equal(filed.currentPage, store.rows[0].currentPage);
        assert.equal(filed.labelPrefix, "Bug Fix", "and the label follows the STORED type");
    } finally {
        if (originalGithubToken === undefined) delete process.env.GITHUB_TOKEN;
        else process.env.GITHUB_TOKEN = originalGithubToken;
    }
});

test("/bug-fix: the same key rule, on the other route", async () => {
    resetStore();
    const originalGithubToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = "test-token";
    try {
        const first = await postBugFix("bug-key-1", {
            title: "Save does nothing",
            description: "Tapped Save and nothing happened",
        });
        assert.equal(first.res.status, 200);
        assert.equal(store.rows.length, 1);
        assert.equal(filedIssues.length, 1);

        const conflicting = await postBugFix("bug-key-1", {
            title: "Save does nothing",
            description: "A completely different description",
        });
        assert.equal(conflicting.res.status, 409);
        assert.equal(conflicting.body.code, "submission-key-conflict");
        assert.equal(store.rows.length, 1);
        assert.equal(filedIssues.length, 1, "no second issue on the first report's row");

        // And an identical replay is still absorbed the way it always was.
        const replay = await postBugFix("bug-key-1", {
            title: "Save does nothing",
            description: "Tapped Save and nothing happened",
        });
        assert.equal(replay.res.status, 200);
        assert.equal(replay.body.duplicate, true);
        assert.equal(filedIssues.length, 1);
    } finally {
        if (originalGithubToken === undefined) delete process.env.GITHUB_TOKEN;
        else process.env.GITHUB_TOKEN = originalGithubToken;
    }
});
