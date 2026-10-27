/**
 * Project Overview / Vision cover section (Estimate.overviewEnabled / overviewTitle /
 * overviewBody) as written through the MCP connector's update_estimate.
 *
 * Nothing here sanitizes HTML, deliberately: the editor already stores raw TipTap HTML and
 * every renderer sanitizes or allowlists on the way out (the portal via DOMPurify, the
 * emailed PDF via pdf-richtext's tag allowlist), so a connector write is held to the same
 * bar. What this does do is make PLAIN text look like editor HTML. pdf-richtext draws
 * tag-less input as a single run of inline text, so an AI-written overview's paragraphs
 * would otherwise collapse into one block on the PDF cover page.
 */

// Editor HTML starts with one of these block tags. Stricter than the portal's own sniff
// (a bare "<p"/"<h" prefix) on purpose: plain text such as "<phase 1> demo" must stay plain
// text here, and once escaped it starts with "<p>", which the portal then reads correctly.
const BLOCK_TAG_START = /^<(p|h[1-6]|ul|ol|div)(\s[^>]*)?>/i;

export function looksLikeRichHtml(value: string): boolean {
    return BLOCK_TAG_START.test(value.trimStart());
}

function escapeHtml(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

/** Plain text to editor-shaped HTML: blank lines separate paragraphs, a single newline is a <br>. */
export function plainTextToOverviewHtml(text: string): string {
    return text
        .replace(/\r\n?/g, "\n")
        .split(/\n[ \t]*\n/)
        .map(p => p.trim())
        .filter(Boolean)
        .map(p => `<p>${p.split("\n").map(line => escapeHtml(line.trim())).join("<br>")}</p>`)
        .join("");
}

/**
 * overviewBody argument: undefined = leave unchanged; null, blank, or HTML with no text
 * (e.g. the editor's empty "<p></p>") = clear, stored as null like an emptied editor
 * section; editor HTML passes through; anything else is treated as plain text.
 */
export function normalizeOverviewBody(value: string | null | undefined): string | null | undefined {
    if (value === undefined) return undefined;
    if (value === null || !value.trim()) return null;
    if (looksLikeRichHtml(value)) {
        const text = value.replace(/<[^>]*>/g, "").replace(/&nbsp;/gi, " ").trim();
        return text ? value.trim() : null;
    }
    return plainTextToOverviewHtml(value);
}

/** overviewTitle argument: undefined = unchanged; null or blank = the default heading ("Project Overview"). */
export function normalizeOverviewTitle(value: string | null | undefined): string | null | undefined {
    if (value === undefined) return undefined;
    if (value === null || !value.trim()) return null;
    return value.trim();
}

/** Whether the cover page actually renders. pdf.ts and the portal both require the toggle AND text. */
export function overviewOnCoverPage(e: { overviewEnabled: boolean; overviewBody: string | null }): boolean {
    return !!e.overviewEnabled && !!e.overviewBody;
}
