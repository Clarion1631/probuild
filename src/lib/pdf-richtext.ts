import { PDFDocument, PDFPage, PDFFont, type RGB } from "pdf-lib";

/**
 * Minimal HTML-subset renderer for pdf-lib. Draws the exact tag set the estimate
 * rich-text editor (TipTap) produces — h1/h2/h3, p, ul/ol/li (including nested lists),
 * strong/b, em/i, br, a — as wrapped, styled text on a pdf-lib document. Used so the
 * Project Overview and Notes & Assumptions sections render with real formatting in the
 * emailed/attached estimate PDF, matching the online portal and portal-download PDF.
 *
 * The input is sanitized editor HTML; this renderer additionally ignores any tag outside
 * the whitelist (keeping its text) and strips characters the standard PDF fonts cannot
 * encode (CJK, emoji, ...) so unusual content degrades gracefully instead of aborting the
 * whole PDF.
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
}

interface Run { text: string; bold: boolean; italic: boolean; }
type Token = { type: "run"; run: Run } | { type: "br" };

// WinAnsi (cp1252) Unicode extras beyond ASCII + Latin-1 that the standard PDF fonts can encode.
const WINANSI_EXTRA = "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ";

/** Drop characters the standard (WinAnsi) fonts can't encode — pdf-lib throws on them. */
function stripUnencodable(text: string): string {
    let out = "";
    for (const ch of text) {
        const c = ch.codePointAt(0)!;
        if (c === 9 || c === 10 || c === 13 || (c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff) || WINANSI_EXTRA.includes(ch)) {
            out += ch;
        }
    }
    return out;
}

function decodeEntities(s: string): string {
    return s
        .replace(/&#(\d+);/g, (_, d: string) => { const n = parseInt(d, 10); return Number.isFinite(n) && n > 0 ? String.fromCodePoint(n) : ""; })
        .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => { const n = parseInt(h, 16); return Number.isFinite(n) && n > 0 ? String.fromCodePoint(n) : ""; })
        .replace(/&nbsp;/g, " ")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;|&apos;/g, "'")
        .replace(/&mdash;/g, "—")
        .replace(/&ndash;/g, "–")
        .replace(/&amp;/g, "&"); // decode &amp; last to avoid double-decoding
}

function fontFor(fonts: RichTextFonts, bold: boolean, italic: boolean): PDFFont {
    if (bold && italic) return fonts.boldItalic;
    if (bold) return fonts.bold;
    if (italic) return fonts.italic;
    return fonts.regular;
}

/** Parse an inline HTML fragment into styled runs + explicit line breaks. */
function parseInline(html: string, forceBold = false): Token[] {
    const tokens: Token[] = [];
    let bold = 0;
    let italic = 0;
    const re = /<\/?([a-z0-9]+)\b[^>]*>|[^<]+/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
        const chunk = m[0];
        if (chunk[0] === "<") {
            const tag = (m[1] || "").toLowerCase();
            const closing = chunk[1] === "/";
            if (tag === "strong" || tag === "b") bold += closing ? -1 : 1;
            else if (tag === "em" || tag === "i") italic += closing ? -1 : 1;
            else if (tag === "br") tokens.push({ type: "br" });
            // a / span / anything else: ignored styling, text is kept
            if (bold < 0) bold = 0;
            if (italic < 0) italic = 0;
        } else {
            const text = stripUnencodable(decodeEntities(chunk));
            if (text) tokens.push({ type: "run", run: { text, bold: forceBold || bold > 0, italic: italic > 0 } });
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
        if (cur) { blocks.push(cur); cur = null; curHasText = false; }
    };

    const re = /<(\/?)([a-z0-9]+)\b[^>]*>|([^<]+)/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
        const text = m[3];
        if (text !== undefined) {
            if (cur) { cur.inline += text; if (text.trim()) curHasText = true; }
            continue;
        }
        const tag = (m[2] || "").toLowerCase();
        const closing = m[1] === "/";

        if (tag === "h1" || tag === "h2" || tag === "h3") {
            if (!closing) { flush(); cur = { type: "heading", level: parseInt(tag[1], 10), inline: "" }; }
            else flush();
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
            if (cur) cur.inline += "<br>";
        } else if (cur) {
            // inline formatting tag (strong/em/b/i/a/span/...) — keep verbatim for parseInline
            cur.inline += m[0];
        }
    }
    flush();
    return blocks;
}

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
        ensureRoom();
    };
    ensureRoom();

    for (const tok of tokens) {
        if (tok.type === "br") { newline(); continue; }
        const font = fontFor(ctx.fonts, tok.run.bold, tok.run.italic);
        const spaceW = font.widthOfTextAtSize(" ", size);
        const parts = tok.run.text.split(/(\s+)/);
        for (const part of parts) {
            if (part === "") continue;
            if (/^\s+$/.test(part)) {
                if (drewAnythingOnLine) curX += spaceW;
                continue;
            }
            const wordW = font.widthOfTextAtSize(part, size);
            if (wordW <= maxWidth) {
                if (drewAnythingOnLine && curX + wordW > x + maxWidth) newline();
                ctx.page.drawText(part, { x: curX, y: ctx.y, size, font, color });
                curX += wordW;
                drewAnythingOnLine = true;
            } else {
                // Word wider than the column (e.g. a long URL): hard-break by characters.
                if (drewAnythingOnLine) newline();
                let chunk = "";
                for (const ch of part) {
                    if (chunk && font.widthOfTextAtSize(chunk + ch, size) > maxWidth) {
                        ctx.page.drawText(chunk, { x, y: ctx.y, size, font, color });
                        newline();
                        chunk = ch;
                    } else {
                        chunk += ch;
                    }
                }
                if (chunk) {
                    ctx.page.drawText(chunk, { x, y: ctx.y, size, font, color });
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
    const src = stripUnencodable(text || "").replace(/\r\n?/g, "\n");
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
    const src = stripUnencodable(text || "").replace(/\r\n?/g, "\n");
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
        drawTokens(ctx, parseInline(src), { x: margin, maxWidth: contentWidth, size: 10, color: ctx.mutedColor, lineHeight: 14 });
        return { page: ctx.page, y: ctx.y };
    }

    for (const block of blocks) {
        if (block.type === "heading") {
            const size = block.level === 1 ? 15 : block.level === 2 ? 12.5 : 11;
            ctx.y -= 6;
            if (ctx.y < margin + size * 1.4) newPage(ctx);
            drawTokens(ctx, parseInline(block.inline, true), { x: margin, maxWidth: contentWidth, size, color: ctx.color, lineHeight: size * 1.35 });
            ctx.y -= 2;
        } else if (block.type === "listitem") {
            const depth = block.depth ?? 0;
            const indent = depth * 14;
            const bulletX = margin + 6 + indent;
            const textX = margin + 20 + indent;
            if (ctx.y < margin + 14) newPage(ctx);
            const marker = block.ordered ? `${block.index}.` : "•";
            ctx.page.drawText(marker, { x: bulletX, y: ctx.y, size: 10, font: ctx.fonts.regular, color: ctx.mutedColor });
            drawTokens(ctx, parseInline(block.inline), { x: textX, maxWidth: margin + contentWidth - textX, size: 10, color: ctx.mutedColor, lineHeight: 14 });
        } else {
            drawTokens(ctx, parseInline(block.inline), { x: margin, maxWidth: contentWidth, size: 10, color: ctx.mutedColor, lineHeight: 14 });
            ctx.y -= 4;
        }
    }

    return { page: ctx.page, y: ctx.y };
}
