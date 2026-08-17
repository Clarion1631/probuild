import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { APIRequestContext } from "@playwright/test";

/**
 * Invoke a Next.js Server Action over HTTP with no valid session.
 *
 * WHY THIS EXISTS
 * ---------------
 * Most of e2e/financial-action-auth.spec.ts asserts against the SOURCE TEXT of
 * actions.ts — the guard string is present, its index precedes the first
 * `prisma.` call, nothing returns ahead of it. That class of assertion has a
 * hard ceiling, named explicitly by the Codex review of PR #360: it proves the
 * guard is WRITTEN, never that it FIRES. Invert a condition inside a helper and
 * every string match still passes.
 *
 * This module closes that gap by actually calling the action as an anonymous
 * remote caller would, so the spec can assert the only thing that really
 * matters: no row was written.
 *
 * HOW A SERVER ACTION IS ADDRESSED
 * --------------------------------
 * A Server Action is a POST carrying a `Next-Action: <id>` header. The id is a
 * build-time hash, and — this is the part that makes the harness maintainable —
 * `next build` writes a first-class name→id mapping to
 * `.next/server/server-reference-manifest.json`, where each entry records its
 * `exportedName` and source `filename`. So we resolve by NAME and never hand-
 * copy a hash that would rot on the next build.
 *
 * Action ids are GLOBAL, not per-route: any route that reaches the Next runtime
 * will dispatch any id. That is exactly the property an attacker uses, and the
 * property this harness relies on.
 *
 * RELATIONSHIP TO src/app/api/test-only/contract-actions/route.ts (PR #367)
 * ------------------------------------------------------------------------
 * That route solves the same problem from the other side: it imports the
 * actions and calls them inside a request. The two are complementary, not
 * duplicates.
 *
 *   - It can address an action by NAME with no build artifacts, and it can
 *     drive a caller's own identity (portal client, scoped staff) easily.
 *   - This harness exercises the REAL remote surface instead: the actual
 *     `Next-Action` dispatch, and therefore the src/proxy.ts layer in front of
 *     it. That is the path an anonymous attacker actually has, and it is not
 *     reachable through an imported function call. It also ships no production
 *     code.
 *
 * Its header notes that server-component actions have "no stable client
 * reference a test could POST to". That is true of the CLIENT chunks, but the
 * SERVER manifest read below names every action regardless of whether any
 * client component imports it — which is why this works for
 * convertLeadToProject, whose only caller is an inline server action.
 */

const MANIFEST_PATH = join(process.cwd(), ".next", "server", "server-reference-manifest.json");

export const ACTIONS_MODULE = "src/lib/actions.ts";

/**
 * The behavioural cases need a PRODUCTION build to talk to:
 *
 *  - the id must come from the same build the server is running, and
 *  - `npm run dev` bypasses src/proxy.ts entirely, so a dev run would prove
 *    something different from what ships.
 *
 * Playwright serves `npm run start` (rather than `npm run dev`) and pins
 * `workers: 1` off the SAME `CI` variable — see playwright.config.ts — so
 * requiring CI here is what makes both the production-server assumption and
 * the run-alone assumption TRUE rather than merely documented. Several
 * assertions compare row counts and would be racy under the default local
 * worker count. The manifest check stays because CI alone does not guarantee
 * a build happened.
 */
export function behaviouralAuthCasesCanRun(): boolean {
    return !!process.env.CI && existsSync(MANIFEST_PATH);
}

export function productionServerActionManifestExists(): boolean {
    return existsSync(MANIFEST_PATH);
}

/**
 * Refuse to run against a build that predates the code it claims to test.
 *
 * Without this the documented local flow hides a trap: build once, invert a
 * guard in actions.ts, then re-run with CI=1 and no rebuild. `npm run start`,
 * the action ids, and the positive controls would all exercise the OLD, still
 * secure artifact and report green over vulnerable source. CI is immune (its
 * job always builds first), but the local flow is the one a human uses *while
 * editing a guard* — precisely when a false green costs the most.
 *
 * An mtime comparison is a heuristic rather than a proof, but it is
 * deterministic for the case that matters (source edited after the last
 * build) and it fails LOUD instead of silently passing.
 */
export function assertBuildIsNotStalerThanSource(
    sourceFiles: string[] = [ACTIONS_MODULE],
): void {
    if (!existsSync(MANIFEST_PATH)) return;
    const builtAt = statSync(MANIFEST_PATH).mtimeMs;
    for (const relative of sourceFiles) {
        const absolute = join(process.cwd(), relative);
        if (!existsSync(absolute)) continue;
        if (statSync(absolute).mtimeMs > builtAt) {
            throw new Error(
                `[anonymous-server-action] ${relative} is NEWER than the production build. `
                + `These cases would exercise the PREVIOUS build and could report green over changed `
                + `source. Re-run \`npm run build\` before the behavioural auth cases.`
            );
        }
    }
}

type ManifestWorker = { exportedName?: string; filename?: string };
type Manifest = { node?: Record<string, { workers?: Record<string, ManifestWorker> }> };

/**
 * Resolve the action id for an exported Server Action by name.
 *
 * Throws rather than returning undefined: a silently unresolvable id would turn
 * every behavioural assertion below it into a request that hits no action at
 * all, and "no row was written" would then pass for entirely the wrong reason.
 */
export function resolveServerActionId(exportedName: string, filename: string = ACTIONS_MODULE): string {
    if (!productionServerActionManifestExists()) {
        throw new Error(
            `[anonymous-server-action] ${MANIFEST_PATH} is missing. `
            + `The behavioural auth cases need a production build — run \`npm run build\` first, `
            + `and run Playwright with CI=1 so it serves \`npm run start\`.`
        );
    }
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Manifest;
    const ids = new Set<string>();
    for (const [id, entry] of Object.entries(manifest.node ?? {})) {
        for (const worker of Object.values(entry.workers ?? {})) {
            // Match on BOTH name and source file. `exportedName` alone is not
            // unique across the app — a same-named export in another module
            // would resolve to the wrong action and silently test nothing.
            if (worker.exportedName === exportedName && worker.filename === filename) {
                ids.add(id);
                break;
            }
        }
    }
    if (ids.size !== 1) {
        throw new Error(
            `[anonymous-server-action] expected exactly one action id for ${filename}#${exportedName}, `
            + `found ${ids.size} (${[...ids].join(", ") || "none"}). `
            + `If the export was renamed or moved, update the caller.`
        );
    }
    return [...ids][0];
}

/**
 * A syntactically plausible but undecodable session token.
 *
 * It must not be empty: the point is that the cookie is PRESENT (so nothing
 * treats the caller as cookie-less) while failing JWT decryption. PR #347
 * established this as the way to defeat `canUseDevAuthFallback`
 * (src/lib/permissions.ts), which silently authenticates a cookie-less caller
 * in development and would otherwise HIDE the very hole under test. Against
 * the PRODUCTION server it is stopped earlier — src/proxy.ts interrogates any
 * request that presents a NextAuth cookie — which is a different layer and
 * worth pinning separately, so both variants run.
 *
 * The cookie-LESS variant is the one that reaches the action in production,
 * precisely because the proxy only interrogates cookie-bearing requests. That
 * is the variant which proves the in-action guard fires.
 */
export const BOGUS_SESSION_COOKIE =
    "next-auth.session-token=not-a-real-session-token.forged-by-e2e.0000000000";

export type ServerActionInvocation = { status: number; body: string };

/**
 * POST an action id with plain JSON arguments.
 *
 * Authentication comes from whatever `request` context is passed in — the
 * default `request` fixture carries the admin storage state (used for the
 * positive control, which proves this transport really does dispatch), while a
 * context from `playwright.request.newContext()` carries nothing.
 *
 * The default path is `/portal`, which src/proxy.ts lets through
 * (PUBLIC_PROXY_BYPASS_PATTERN) — deliberately, so that an anonymous
 * invocation actually reaches the Next runtime and dispatches the action
 * instead of being turned away at the edge. A test that only ever collected a
 * login redirect would pass with the in-action guard deleted.
 */
export async function invokeServerAction(
    request: APIRequestContext,
    options: {
        actionId: string;
        args: unknown[];
        /** Attach a forged, undecodable NextAuth session cookie. */
        forgedCookie?: boolean;
        path?: string;
        baseURL?: string;
    }
): Promise<ServerActionInvocation> {
    const { actionId, args, forgedCookie = false, path = "/portal", baseURL = "http://localhost:3000" } = options;

    const headers: Record<string, string> = {
        "next-action": actionId,
        // React serialises a plain argument list as a JSON array sent with this
        // content type. Anything richer (files, callbacks) would need a real
        // multipart reply encoding — every action exercised here takes plain
        // strings and object literals.
        "content-type": "text/plain;charset=UTF-8",
        // Next rejects a Server Action whose Origin disagrees with its Host.
        // Send a matching Origin so the request is refused (or accepted) on
        // AUTHORIZATION grounds rather than on CSRF grounds — otherwise "no row
        // was written" would again be true for the wrong reason.
        origin: baseURL,
    };
    if (forgedCookie) headers.cookie = BOGUS_SESSION_COOKIE;

    const response = await request.post(`${baseURL}${path}`, {
        headers,
        data: JSON.stringify(args),
        maxRedirects: 0,
        failOnStatusCode: false,
    });

    return { status: response.status(), body: await response.text() };
}
