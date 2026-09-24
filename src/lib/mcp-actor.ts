export const MCP_ACTOR_EMAILS = {
    "justin-ai": "gtrsupport@goldentouchremodeling.com",
    "richard-ai": "richard-ai@goldentouchremodeling.com",
    // Never actually looked up: read-only mode never registers a WRITE_TOOLS
    // entry except read_file/get_file_link, whose audit path only needs a
    // label, not a resolved user — kept here so McpActorLabel stays one type.
    "readonly-ai": "readonly-ai@goldentouchremodeling.com",
} as const;

export type McpActorLabel = keyof typeof MCP_ACTOR_EMAILS;

export type McpActorContext = {
    actorLabel: McpActorLabel;
    actorUserId: string | null;
};

export function mcpActivityActorName(actorLabel: McpActorLabel): string {
    return `SYSTEM:${actorLabel}`;
}
