import { NextResponse } from "next/server";
import { hasCronSecret } from "@/lib/cron-auth";
import { isValidChatWebhookUrl, parseOwnerChatUsers } from "@/lib/receipt-request-cards";
import {
    ON_DEMAND_MAX_BODY_BYTES,
    ON_DEMAND_OWNER,
    decodeOnDemandInput,
    parseAllowedTargets,
    runOnDemand,
    type OnDemandDeps,
    type OnDemandResult,
    type OwnerCardView,
} from "@/lib/receipt-on-demand";
import { createOnDemandDeps } from "@/lib/receipt-on-demand-store";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const NO_STORE = { "Cache-Control": "no-store" } as const;

function json(body: unknown, status: number): NextResponse {
    return NextResponse.json(body, { status, headers: NO_STORE });
}

/**
 * Read at most ON_DEMAND_MAX_BODY_BYTES of the request body, enforcing the
 * cap on ACTUAL UTF-8 bytes as they arrive. `Content-Length` is never
 * trusted — a chunked or lying request is rejected on the bytes we read.
 */
async function readBoundedBody(request: Request): Promise<string | null> {
    const body = request.body;
    if (!body) return "";
    const reader = body.getReader();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('body-timeout')), 5_000); });
    try {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await Promise.race([reader.read(), expired]);
        if (done) break;
        if (value) {
            total += value.byteLength;
            if (total > ON_DEMAND_MAX_BODY_BYTES) {
                void reader.cancel().catch(() => {});
                return null;
            }
            chunks.push(value);
        }
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(merged);
    } finally { clearTimeout(timer); void reader.cancel().catch(() => {}); }
}

export interface OnDemandHandlerConfig {
    authorized?: (request: Request) => boolean;
    makeDeps?: (env: NodeJS.ProcessEnv) => OnDemandDeps;
    allowedTargets?: readonly string[];
    env?: NodeJS.ProcessEnv;
}

/**
 * Handler factory. Production wires the real clock, the real auth, the real
 * store and the env's allowlist; tests may substitute any of them. Auth and
 * the allowlist can NEVER be overridden by the request — only by this config.
 */
export function makeOnDemandHandler(config: OnDemandHandlerConfig = {}) {
    const env = config.env ?? process.env;
    const authorized = config.authorized ?? ((request: Request) => hasCronSecret(request));
    const makeDeps = config.makeDeps ?? ((e: NodeJS.ProcessEnv) => {
        if (!isValidChatWebhookUrl(e.RECEIPTS_CHAT_WEBHOOK ?? '') || !/^users\/[A-Za-z0-9_-]+$/.test(parseOwnerChatUsers(e.RECEIPT_OWNER_CHAT_USERS).Justin ?? '')) throw Error('config-unavailable');
        return createOnDemandDeps({ config: { allowedTargets: parseTargetsEnv(e), ownerChatUsers: e.RECEIPT_OWNER_CHAT_USERS, webhookUrl: e.RECEIPTS_CHAT_WEBHOOK, env: e } });
    });

    return async function handler(request: Request): Promise<NextResponse> {
        if (!authorized(request)) return json({ error: "unauthorized" }, 401);
        if (new URL(request.url).search) return json({ error: "query-not-allowed" }, 400);

        const allowed = config.allowedTargets ?? parseAllowedTargets(parseTargetsEnv(env));
        if (allowed.length !== 1) return json({ error: "no-configured-target" }, 503);

        const raw = await readBoundedBody(request).catch(() => null);
        if (raw === null) return json({ error: "payload-too-large" }, 413);

        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch {
            return json({ error: "invalid-json" }, 400);
        }
        const input = decodeOnDemandInput(parsed);
        if (!input) return json({ error: "invalid-input" }, 400);

        let deps: OnDemandDeps;
        try {
            deps = makeDeps(env);
        } catch {
            return json({ error: "config-unavailable" }, 503);
        }

        const result: OnDemandResult = await runOnDemand(input, deps, {
            allowedTargets: allowed,
        }).catch(() => ({ kind: "unknown", reason: "internal" } as const));

        return respond(result);
    };
}

function parseTargetsEnv(env: NodeJS.ProcessEnv): unknown {
    const raw = env.RECEIPT_ON_DEMAND_TARGETS;
    if (!raw) return undefined;
    try {
        return JSON.parse(raw);
    } catch {
        return undefined;
    }
}

function respond(result: OnDemandResult): NextResponse {
    switch (result.kind) {
        case "ready": {
            const card: OwnerCardView = result.card;
            return json({ status: "ready", digest: result.digest, card }, 200);
        }
        case "posted":
            return json({ status: "posted", threadName: result.threadName, messageName: result.messageName }, 200);
        case "blocked":
            return json({ status: "blocked", reason: result.reason }, 409);
        case "unknown":
            return json({ status: "unknown", reason: result.reason }, 503);
        case "incomplete":
            return json({ status: "incomplete", reason: result.reason }, 503);
    }
}

export const POST = makeOnDemandHandler();

