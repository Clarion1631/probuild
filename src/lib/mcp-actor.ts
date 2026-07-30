import { createHash, timingSafeEqual } from "crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { prisma } from "@/lib/prisma";

// Per-request identity for the MCP connector. A presented `?key=` is looked
// up against McpKey first (per-person keys minted via scripts/mint-mcp-key.mjs);
// if that misses, it falls back to the legacy shared MCP_SECRET so the
// existing ChatGPT connector URL keeps working unchanged.

export interface McpActor {
    userId: string | null;
    name: string;
    role: string | null;
    keyId: string | null;
}

// Same semantics as route.ts's `authorized()`: hash both sides to a fixed
// length before the timing-safe compare so neither content nor length leaks.
function timingSafeKeyMatches(key: string, secret: string): boolean {
    const a = createHash("sha256").update(key).digest();
    const b = createHash("sha256").update(secret).digest();
    return timingSafeEqual(a, b);
}

function lookupMcpKey(keyHash: string) {
    return prisma.mcpKey.findFirst({
        where: { keyHash, revokedAt: null },
        include: { user: { select: { id: true, name: true, email: true, role: true, status: true } } },
    });
}

export async function resolveMcpActor(req: Request): Promise<McpActor | null> {
    const key = new URL(req.url).searchParams.get("key") ?? "";
    if (!key) return null;

    const keyHash = createHash("sha256").update(key).digest("hex");
    // Fail SOFT: this lookup runs on every request, including ones using the
    // legacy shared secret. If the McpKey table isn't there yet (build deployed
    // ahead of scripts/apply-mcp-audit-schema.mjs) or the DB hiccups, fall
    // through to the shared-secret compare rather than 401-ing the whole
    // connector. A personal key that can't be looked up simply won't match the
    // shared secret either, so this doesn't weaken the gate.
    let mcpKey: Awaited<ReturnType<typeof lookupMcpKey>> = null;
    try {
        mcpKey = await lookupMcpKey(keyHash);
    } catch (err) {
        console.error("[resolveMcpActor] McpKey lookup failed, falling back to shared secret:", err);
    }

    // ACTIVATED only — a PENDING invite must not carry connector access.
    if (mcpKey && mcpKey.user.status === "ACTIVATED") {
        // Fire-and-forget — never let a lastUsedAt bump fail or slow the request.
        try {
            void prisma.mcpKey
                .update({ where: { id: mcpKey.id }, data: { lastUsedAt: new Date() } })
                .catch(() => {});
        } catch {
            // ignore
        }
        return {
            userId: mcpKey.user.id,
            name: mcpKey.user.name ?? mcpKey.user.email,
            role: mcpKey.user.role,
            keyId: mcpKey.id,
        };
    }

    // The shared secret authenticates anonymously and predates per-person keys,
    // so while it is live nobody's access can truly be revoked — revoking a
    // personal key still leaves the shared URL working. Once everyone is moved
    // onto personal keys, set MCP_DISABLE_SHARED_KEY=1 in Vercel to retire it;
    // MCP_SECRET itself must stay set because it also signs the two-step send
    // confirmation tokens (mintPreviewToken in the MCP route).
    if (process.env.MCP_DISABLE_SHARED_KEY === "1") return null;

    const secret = process.env.MCP_SECRET;
    if (secret && timingSafeKeyMatches(key, secret)) {
        return { userId: null, name: "ChatGPT connector (shared key)", role: null, keyId: null };
    }

    return null;
}

// Request-scoped actor, set once per request in route.ts's `guarded()` via
// mcpActorStore.run(...) so any tool handler (or the wrapper around it) can
// read who is calling without threading the actor through every function.
export const mcpActorStore = new AsyncLocalStorage<McpActor>();

export function currentMcpActor(): McpActor {
    return mcpActorStore.getStore() ?? { userId: null, name: "unknown", role: null, keyId: null };
}
