export const MCP_ACTOR_EMAILS = {
    "justin-ai": "gtrsupport@goldentouchremodeling.com",
    "richard-ai": "richard-ai@goldentouchremodeling.com",
    "mac-ai": "mac-ai@goldentouchremodeling.com",
} as const;

export type McpActorLabel = keyof typeof MCP_ACTOR_EMAILS;

export type McpActorContext = {
    actorLabel: McpActorLabel;
    actorUserId: string | null;
};

export function mcpActivityActorName(actorLabel: McpActorLabel): string {
    return `SYSTEM:${actorLabel}`;
}
