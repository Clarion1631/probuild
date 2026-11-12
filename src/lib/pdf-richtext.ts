import { PDFDocument, PDFPage, PDFFont, type RGB } from "pdf-lib";
import { cleanPdfText, cleanPdfTextAudited } from "./pdf-text-encoding";

/**
 * Minimal HTML-subset renderer for pdf-lib. Draws the tag set the estimate rich-text editor
 * (TipTap) produces as wrapped, styled text on a pdf-lib document: h1-h6, p, ul/ol/li (including
 * nested lists), strong/b, em/i, s/strike/del (struck through), br, pre (line breaks kept) and a.
 * Container tags (div, table, td, blockquote, ...) only separate blocks, and loose text outside any
 * block starts an implicit paragraph. Used so the Project Overview, Notes & Assumptions and Terms
 * sections render with real formatting in the emailed/attached estimate PDF, matching the portal.
 *
 * The input is sanitized HTML (callers run the portal's DOMPurify call first; estimate path, pdf-sanitize.ts);
 * this renderer additionally ignores any other tag (keeping its text), skips the elements DOMPurify keeps but a
 * browser never displays (style, template, title, ...), and prepares all text through the shared cleaner
 * (pdf-text-encoding.ts: unencodable letters become "?" and are reported through ctx.audit).
 */

export interface RichTextFonts {
    regular: PDFFont;
    bold: PDFFont;
    italic: PDFFont;
    boldItalic: PDFFont;
}

export interface RichTextLayout {
    pageWidth: number;
    pageHeight: number;
    margin: number;
    contentWidth: number;
}

export interface RichTextCtx {
    doc: PDFDocument;
    page: PDFPage;
    y: number;
    fonts: RichTextFonts;
    layout: RichTextLayout;
    color: RGB;
    mutedColor: RGB;
    /** Set to lossy when any printed character had to become "?" (see pdf-text-encoding.ts). */
    audit?: { lossy: boolean };
}

interface Run { text: string; bold: boolean; italic: boolean; strike?: boolean; underline?: boolean; }
type Token = { type: "run"; run: Run } | { type: "br" };

// A Map, not a plain object: "&constructor;" must not resolve through Object.prototype.
const NAMED_ENTITIES = new Map<string, string>(Object.entries({
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
    sect: "\u00a7", rsquo: "\u2019", lsquo: "\u2018", rdquo: "\u201d", ldquo: "\u201c", hellip: "\u2026",
    copy: "\u00a9", reg: "\u00ae", trade: "\u2122", mdash: "\u2014", ndash: "\u2013", bull: "\u2022",
    euro: "\u20ac", middot: "\u00b7", deg: "\u00b0", frac12: "\u00bd", frac14: "\u00bc", frac34: "\u00be", times: "\u00d7",
}));

/** Single pass, so "&amp;lt;" decodes to the literal text "&lt;" and never twice. Unknown entities stay as typed. */
function decodeEntities(s: string): string {
    return s.replace(/&(#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/gi, (whole, body: string) => {
        if (body[0] === "#") {
            const n = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
            if (!Number.isFinite(n) || n <= 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return "";
            return n === 160 ? " " : String.fromCodePoint(n);
        }
        const v = NAMED_ENTITIES.get(body);
        return v === undefined ? whole : v;
    });
}

function fontFor(fonts: RichTextFonts, bold: boolean, italic: boolean): PDFFont {
    if (bold && italic) return fonts.boldItalic;
    if (bold) return fonts.bold;
    if (italic) return fonts.italic;
    return fonts.regular;
}

// The input is DOMPurify output (see pdf-sanitize.ts), so attribute values are always quoted; a ">" inside a
// quoted value must not end the tag.
const TAG_OR_TEXT_INLINE = /<\/?([a-z0-9]+)\b(?:"[^"]*"|'[^']*'|[^>"'])*>|[^<]+/;
const TAG_OR_TEXT_BLOCK = /<(\/?)([a-z0-9]+)\b(?:"[^"]*"|'[^']*'|[^>"'])*>|([^<]+)/;

/** Elements DOMPurify leaves in place but a browser never displays: their content is skipped, nesting counted. */
const HIDDEN_ELEMENTS = new Set(["style", "template", "title", "datalist", "noscript", "script", "dialog"]);

/** Parse an inline HTML fragment into styled runs + explicit line breaks. */
function parseInline(html: string, forceBold = false, audit?: { lossy: boolean }): Token[] {
    const tokens: Token[] = [];
    let bold = 0;
    let italic = 0;
    let strike = 0;
    let underline = 0; // u and a: the portal's prose container underlines both
    let hidden = 0;
    const re = new RegExp(TAG_OR_TEXT_INLINE.source, "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
        const chunk = m[0];
        if (chunk[0] === "<") {
            const tag = (m[1] || "").toLowerCase();
            const closing = chunk[1] === "/";
            if (HIDDEN_ELEMENTS.has(tag)) { hidden = Math.max(0, hidden + (closing ? -1 : 1)); continue; }
            if (hidden) continue;
            if (tag === "strong" || tag === "b") bold += closing ? -1 : 1;
            else if (tag === "em" || tag === "i") italic += closing ? -1 : 1;
            else if (tag === "s" || tag === "strike" || tag === "del") strike += closing ? -1 : 1;
            else if (tag === "u" || tag === "a") underline += closing ? -1 : 1;
            else if (tag === "br") tokens.push({ type: "br" });
            // span / anything else: ignored styling, text is kept
            if (bold < 0) bold = 0;
            if (italic < 0) italic = 0;
            if (strike < 0) strike = 0;
            if (underline < 0) underline = 0;
        } else if (!hidden) {
            const text = cleanPdfTextAudited(decodeEntities(chunk), audit);
            if (text) tokens.push({ type: "run", run: { text, bold: forceBold || bold > 0, italic: italic > 0, strike: strike > 0, underline: underline > 0 } });
        }
    }
    return tokens;
}

interface Block {
    type: "heading" | "paragraph" | "listitem";
    level?: number;
    ordered?: boolean;
    index?: number;
    depth?: number;
    inline: string;
    /** Started by loose text, not a tag: dropped again if it ends up with no text. */
    implicit?: boolean;
}

/**
 * Tag-aware block parser. Unlike a flat regex it correctly handles nested <ul>/<ol>
 * (no dropped items) and multiple <p> inside one <li> (joined with a line break).
 */
function parseBlocks(html: string): Block[] {
    const blocks: Block[] = [];
    const listStack: { ordered: boolean; counter: number }[] = [];
    let cur: Block | null = null;
    let curHasText = false;

    const flush = () => {
        if (cur && !(cur.implicit && !curHasText && !cur.inline.includes("<br>"))) blocks.push(cur);
        cur = null; curHasText = false;
    };
    let hidden = 0; // depth inside an element a browser never displays
    let inPre = false;
    let preStart = false; // right after <pre>: browsers drop one leading newline
    const BOUNDARY = new Set(["div", "table", "thead", "tbody", "tfoot", "tr", "td", "th", "blockquote", "section", "article", "header", "footer", "main", "aside", "nav", "figure", "figcaption", "hr", "dl", "dt", "dd", "details", "summary", "caption", "address", "fieldset", "form"]);

    const re = new RegExp(TAG_OR_TEXT_BLOCK.source, "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
        let text = m[3];
        if (text === undefined && HIDDEN_ELEMENTS.has((m[2] || "").toLowerCase())) {
            hidden = Math.max(0, hidden + (m[1] === "/" ? -1 : 1));
            continue;
        }
        if (hidden) continue;
        if (text !== undefined) {
            if (inPre && preStart) text = text.replace(/^(?:\r\n|\r|\n)/, "");
            preStart = false;
            if (text === "") continue;
            if (!cur && text.trim()) cur = { type: "paragraph", inline: "", implicit: true };
            if (cur) {
                cur.inline += inPre ? text.replace(/\r\n?|\n/g, "<br>") : text;
                if (text.trim()) curHasText = true;
            }
            continue;
        }
        const tag = (m[2] || "").toLowerCase();
        const closing = m[1] === "/";
        preStart = false;

        if (/^h[1-6]$/.test(tag)) {
            if (!closing) { flush(); cur = { type: "heading", level: parseInt(tag[1], 10), inline: "" }; }
            else flush();
        } else if (tag === "pre") {
            flush();
            inPre = !closing;
            if (!closing) { cur = { type: "paragraph", inline: "" }; preStart = true; }
        } else if (BOUNDARY.has(tag)) {
            if (!cur || cur.type !== "listitem") flush();
        } else if (tag === "p") {
            if (!closing) {
                if (cur && cur.type === "listitem") { if (curHasText) cur.inline += "<br>"; }
                else { flush(); cur = { type: "paragraph", inline: "" }; }
            } else if (cur && cur.type !== "listitem") {
                flush();
            }
        } else if (tag === "ul" || tag === "ol") {
            if (!closing) { flush(); listStack.push({ ordered: tag === "ol", counter: 0 }); }
            else listStack.pop();
        } else if (tag === "li") {
            if (!closing) {
                flush();
                const top = listStack[listStack.length - 1];
                if (top) top.counter++;
                cur = { type: "listitem", ordered: top ? top.ordered : false, index: top ? top.counter : 1, depth: Math.max(0, listStack.length - 1), inline: "" };
            } else {
                flush();
            }
        } else if (tag === "br") {
            if (!cur) cur = { type: "paragraph", inline: "", implicit: true };
            cur.inline += "<br>";
        } else {
            // inline formatting tag (strong/em/b/i/a/span/s/del/unknown...) - keep verbatim for parseInline.
            // Opening one with no open block starts an implicit paragraph so its text is not lost.
            if (!cur && !closing) cur = { type: "paragraph", inline: "", implicit: true };
            if (cur) cur.inline += m[0];
        }
    }
    flush();
    return blocks;
}

/** Narrowest text column a nested list item may be squeezed to. */
const MIN_LIST_TEXT_WIDTH = 120;

function newPage(ctx: RichTextCtx) {
    ctx.page = ctx.doc.addPage([ctx.layout.pageWidth, ctx.layout.pageHeight]);
    ctx.y = ctx.layout.pageHeight - ctx.layout.margin;
}

/** Flow styled tokens with word wrapping (and hard-breaking of over-long words), breaking to a new page when out of room. */
function drawTokens(
    ctx: RichTextCtx,
    tokens: Token[],
    opts: { x: number; maxWidth: number; size: number; color: RGB; lineHeight: number },
) {
    const { x, maxWidth, size, color, lineHeight } = opts;
    let curX = x;
    let drewAnythingOnLine = false;

    const ensureRoom = () => {
        if (ctx.y < ctx.layout.margin + lineHeight) newPage(ctx);
    };
    const newline = () => {
        ctx.y -= lineHeight;
        curX = x;
        drewAnythingOnLine = false;
        pendingSpaceStrikes = [];
        ensureRoom();
    };
    ensureRoom();
    // A struck or underlined space is only drawn when the next word stays on the same line, so a wrapped line ends clean.
    let pendingSpaceStrikes: Array<{ x: number; w: number; strike: boolean; underline: boolean }> = [];
    const decorate = (sx: number, w: number, strike: boolean, underline: boolean) => {
        const thickness = Math.max(0.5, size * 0.06);
        if (strike) {
            const yy = ctx.y + size * 0.3;
            ctx.page.drawLine({ start: { x: sx, y: yy }, end: { x: sx + w, y: yy }, thickness, color });
        }
        if (underline) {
            const yy = ctx.y - size * 0.12;
            ctx.page.drawLine({ start: { x: sx, y: yy }, end: { x: sx + w, y: yy }, thickness, color });
        }
    };

    for (const tok of tokens) {
        if (tok.type === "br") { newline(); continue; }
        const font = fontFor(ctx.fonts, tok.run.bold, tok.run.italic);
        const spaceW = font.widthOfTextAtSize(" ", size);
        const parts = tok.run.text.split(/(\s+)/);
        for (const part of parts) {
            if (part === "") continue;
            if (/^\s+$/.test(part)) {
                if (drewAnythingOnLine) { if (tok.run.strike || tok.run.underline) pendingSpaceStrikes.push({ x: curX, w: spaceW, strike: !!tok.run.strike, underline: !!tok.run.underline }); curX += spaceW; }
                continue;
            }
            const wordW = font.widthOfTextAtSize(part, size);
            if (wordW <= maxWidth) {
                if (drewAnythingOnLine && curX + wordW > x + maxWidth) newline();
                for (const sp of pendingSpaceStrikes) decorate(sp.x, sp.w, sp.strike, sp.underline);
                pendingSpaceStrikes = [];
                ctx.page.drawText(part, { x: curX, y: ctx.y, size, font, color });
                decorate(curX, wordW, !!tok.run.strike, !!tok.run.underline);
                curX += wordW;
                drewAnythingOnLine = true;
            } else {
                // Word wider than the column (e.g. a long URL): hard-break by characters.
                if (drewAnythingOnLine) newline();
                let chunk = "";
                for (const ch of part) {
                    if (chunk && font.widthOfTextAtSize(chunk + ch, size) > maxWidth) {
                        ctx.page.drawText(chunk, { x, y: ctx.y, size, font, color });
                        decorate(x, font.widthOfTextAtSize(chunk, size), !!tok.run.strike, !!tok.run.underline);
                        newline();
                        chunk = ch;
                    } else {
                        chunk += ch;
                    }
                }
                if (chunk) {
                    ctx.page.drawText(chunk, { x, y: ctx.y, size, font, color });
                    decorate(x, font.widthOfTextAtSize(chunk, size), !!tok.run.strike, !!tok.run.underline);
                    curX = x + font.widthOfTextAtSize(chunk, size);
                    drewAnythingOnLine = true;
                }
            }
        }
    }
    ctx.y -= lineHeight;
}

/**
 * Flow PLAIN text (not HTML) onto the pdf-lib context with word wrapping and
 * pagination, preserving typed line breaks. Used for fields users enter as
 * free text (e.g. change-order descriptions) where "<" or "&" must render
 * literally rather than being parsed as markup. Mutates ctx.page/ctx.y.
 */
export function drawWrappedText(
    text: string,
    ctx: RichTextCtx,
    opts: { x: number; maxWidth: number; size: number; color: RGB; lineHeight: number },
): { page: PDFPage; y: number } {
    const src = cleanPdfTextAudited(text || "", ctx.audit).replace(/\r\n?/g, "\n");
    if (!src.trim()) return { page: ctx.page, y: ctx.y };

    const tokens: Token[] = [];
    const lines = src.split("\n");
    lines.forEach((line, i) => {
        if (i > 0) tokens.push({ type: "br" });
        if (line) tokens.push({ type: "run", run: { text: line, bold: false, italic: false } });
    });

    drawTokens(ctx, tokens, opts);
    return { page: ctx.page, y: ctx.y };
}

/**
 * Number of wrapped lines drawWrappedText would emit for the given text/width —
 * lets callers estimate block height for page-break decisions without drawing.
 */
export function measureWrappedLines(text: string, font: PDFFont, size: number, maxWidth: number): number {
    const src = cleanPdfText(text || "").text.replace(/\r\n?/g, "\n");
    if (!src.trim()) return 0;
    // Mirrors drawTokens exactly (a line per newline() call, +1 for the first
    // row of each source line) so preflight height estimates match what draws.
    const spaceW = font.widthOfTextAtSize(" ", size);
    let lines = 0;
    for (const line of src.split("\n")) {
        lines += 1;
        if (!line.trim()) continue;
        let curW = 0;
        let drewOnLine = false;
        for (const part of line.split(/(\s+)/)) {
            if (part === "") continue;
            if (/^\s+$/.test(part)) { if (drewOnLine) curW += spaceW; continue; }
            const wordW = font.widthOfTextAtSize(part, size);
            if (wordW <= maxWidth) {
                if (drewOnLine && curW + wordW > maxWidth) { lines += 1; curW = 0; }
                curW += wordW;
                drewOnLine = true;
            } else {
                // Over-long word: same character-greedy hard-break as drawTokens.
                if (drewOnLine) { lines += 1; curW = 0; }
                let chunk = "";
                for (const ch of part) {
                    if (chunk && font.widthOfTextAtSize(chunk + ch, size) > maxWidth) {
                        lines += 1;
                        chunk = ch;
                    } else {
                        chunk += ch;
                    }
                }
                curW = font.widthOfTextAtSize(chunk, size);
                drewOnLine = true;
            }
        }
    }
    return lines;
}

/**
 * Render a sanitized HTML fragment onto the pdf-lib context, mutating ctx.page/ctx.y
 * as it flows and paginates. Returns the final { page, y } so the caller can continue.
 */
export function drawRichHtml(html: string, ctx: RichTextCtx): { page: PDFPage; y: number } {
    const { margin, contentWidth } = ctx.layout;
    const src = (html || "").trim();
    if (!src) return { page: ctx.page, y: ctx.y };

    const blocks = parseBlocks(src);
    // No recognized block tags — treat the whole thing as one paragraph of inline text.
    if (blocks.length === 0) {
        drawTokens(ctx, parseInline(src, false, ctx.audit), { x: margin, maxWidth: contentWidth, size: 10, color: ctx.mutedColor, lineHeight: 14 });
        return { page: ctx.page, y: ctx.y };
    }

    for (const block of blocks) {
        if (block.type === "heading") {
            const size = block.level === 1 ? 15 : block.level === 2 ? 12.5 : 11; // h3-h6 share the smallest size
            ctx.y -= 6;
            if (ctx.y < margin + size * 1.4) newPage(ctx);
            drawTokens(ctx, parseInline(block.inline, true, ctx.audit), { x: margin, maxWidth: contentWidth, size, color: ctx.color, lineHeight: size * 1.35 });
            ctx.y -= 2;
        } else if (block.type === "listitem") {
            const depth = block.depth ?? 0;
            // Clamp so a very deep list (also flagged lossy by the allowlist) never pushes text off the page.
            const indent = Math.max(0, Math.min(depth * 14, contentWidth - 20 - MIN_LIST_TEXT_WIDTH));
            const bulletX = margin + 6 + indent;
            const textX = margin + 20 + indent;
            if (ctx.y < margin + 14) newPage(ctx);
            const marker = block.ordered ? `${block.index}.` : "•";
            // A marker wider than the gutter (e.g. "100.") would run into the item text: not an exact copy.
            if (ctx.audit && ctx.fonts.regular.widthOfTextAtSize(marker, 10) > textX - bulletX) ctx.audit.lossy = true;
            ctx.page.drawText(marker, { x: bulletX, y: ctx.y, size: 10, font: ctx.fonts.regular, color: ctx.mutedColor });
            drawTokens(ctx, parseInline(block.inline, false, ctx.audit), { x: textX, maxWidth: margin + contentWidth - textX, size: 10, color: ctx.mutedColor, lineHeight: 14 });
        } else {
            drawTokens(ctx, parseInline(block.inline, false, ctx.audit), { x: margin, maxWidth: contentWidth, size: 10, color: ctx.mutedColor, lineHeight: 14 });
            ctx.y -= 4;
        }
    }

    return { page: ctx.page, y: ctx.y };
}
