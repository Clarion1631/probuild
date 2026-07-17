// Extract a single JSON object from an LLM text response. Models sometimes
// wrap JSON in markdown fences or append prose (which can itself contain
// braces), so a greedy first-{-to-last-} regex is not safe. Strategy:
// 1. straight parse, 2. fenced ```json block, 3. string-aware balanced-brace
// scan that stops at the FIRST complete top-level object.
export function extractJsonObject<T = unknown>(raw: string): T | null {
    const text = raw.trim();

    try { return JSON.parse(text) as T; } catch { /* keep going */ }

    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) {
        try { return JSON.parse(fence[1].trim()) as T; } catch { /* keep going */ }
    }

    const start = text.indexOf("{");
    if (start === -1) return null;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (inStr) {
            if (esc) esc = false;
            else if (ch === "\\") esc = true;
            else if (ch === '"') inStr = false;
            continue;
        }
        if (ch === '"') inStr = true;
        else if (ch === "{") depth++;
        else if (ch === "}") {
            depth--;
            if (depth === 0) {
                try { return JSON.parse(text.slice(start, i + 1)) as T; } catch { return null; }
            }
        }
    }
    return null;
}
