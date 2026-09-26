/**
 * Never logs a raw error message — only an allowlisted category name and
 * status code. Some SDKs (the Google API client among them) copy response
 * body content into `.message` on failure, so an unfiltered `error.message`
 * risks leaking token/response data into logs (finding: "PII/log-safety gap
 * versus the spec's own finding 7"). The same shape
 * `src/app/api/gmail/callback/route.ts`'s `safeOAuthErrorCategory` used
 * first, factored out here so every speed-to-lead catch goes through the
 * same formatter instead of a raw `error.message`.
 */
const ALLOWED_ERROR_CATEGORIES = new Set(["Error", "TypeError", "RangeError", "SyntaxError", "GaxiosError", "AggregateError"]);

export function safeErrorCategory(error: unknown): { category: string; status: number | null } {
    const status = (error as { code?: number })?.code ?? (error as { response?: { status?: number } })?.response?.status ?? null;
    const name = error instanceof Error ? error.name : null;
    const category = name && ALLOWED_ERROR_CATEGORIES.has(name) ? name : "UnknownError";
    return { category, status: typeof status === "number" ? status : null };
}
