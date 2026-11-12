/**
 * The portal shows rich estimate text (overview, notes, terms) through DOMPurify.sanitize(html) with the
 * default configuration (PortalEstimateClient.tsx: TermsAndConditions and PortalRichSection, both via
 * isomorphic-dompurify). The server PDF runs the very same call first, so its parser only ever sees what a
 * browser would display, already well-formed. Loaded lazily so other PDFs do not pay for jsdom.
 * Returns null when the sanitiser cannot run: the caller must then treat the field as lossy (fail closed).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadPurify(): Promise<{ sanitize: (html: string, cfg?: any) => unknown }> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = await import("isomorphic-dompurify");
    return typeof mod.default?.sanitize === "function" ? mod.default : mod;
}

export async function sanitizePortalHtml(html: string): Promise<string | null> {
    try {
        const out = (await loadPurify()).sanitize(html);
        return typeof out === "string" ? out : null;
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------------------------------
// Structural exactness check: DENY BY DEFAULT.
//
// The estimate counts as an EXACT copy of the portal page only when the sanitised markup is made of the
// few elements and attributes below. Each one is something the app's own editors produce in normal use
// (RichTextEditor.tsx and MergeFieldEditor.tsx: TipTap StarterKit, Underline, the mergeField chip; neither
// editor configures a TextAlign extension) AND something the PDF renderer (pdf-richtext.ts) draws with the
// same visible text, order and emphasis as the portal's Tailwind "prose" container. Everything else is
// lossy, so the phone keeps the complete browser screenshot. A false "lossy" only costs a magnified PDF;
// a false "exact" is the defect.
//
// Deliberately NOT allowed (the portal shows something the PDF does not): code and pre (prose adds backticks
// and pre keeps spaces), blockquote (prose adds quote marks), hr (no rule drawn), div, table and all table
// parts, img, details, dialog, sup/sub, and every style, class, hidden, dir, start, value, type, reversed,
// title, id and data-* attribute except the ones named below.
// ---------------------------------------------------------------------------------------------------

export const FAITHFUL_TAGS: ReadonlySet<string> = new Set([
    "p", "br", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li",
    "strong", "b", "em", "i", "u", "s", "strike", "del", "a", "span",
]);

/** Attributes allowed on <a>. Nothing else is allowed on any other element (aria-* is skipped on purpose:
 *  aria-hidden changes nothing a sighted reader sees). */
const LINK_ATTRS: ReadonlySet<string> = new Set(["href", "target", "rel"]);

/** The merge-field chip (MergeFieldEditor.tsx renderHTML): data-merge-field, contenteditable="false" (DOMPurify's
 *  default configuration strips that one, so it is optional here) and one of exactly these two style strings
 *  (data-field blue, or signing-field pink). Any other attribute or style declaration is lossy. */
const CHIP_STYLES: ReadonlySet<string> = new Set([
    "background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe;padding:1px 8px;border-radius:4px;font-size:0.75rem;font-weight:600;white-space:nowrap;font-style:normal;",
    "background:#fff1f2;color:#be185d;border:1px solid #fecdd3;padding:1px 8px;border-radius:4px;font-size:0.75rem;font-weight:600;white-space:nowrap;font-style:normal;",
].map(normalizeStyle));

/** Whitespace around ":" and ";" and a trailing ";" do not matter; the declarations and their order do. */
function normalizeStyle(style: string): string {
    return style.split(";").map((d) => d.trim().replace(/\s*:\s*/, ":").toLowerCase()).filter(Boolean).join(";");
}

const BOUNDARY_TAGS: ReadonlySet<string> = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

interface DomNode { nodeType: number; textContent?: string | null; localName?: string; attributes?: ArrayLike<{ name: string; value: string }>; childNodes: ArrayLike<DomNode> }

const attrsOf = (el: DomNode) => Array.from(el.attributes ?? []).filter((a) => !a.name.toLowerCase().startsWith("aria-"));

/** A span is allowed only as the editor's merge-field chip (exact attributes and style) or with no attributes. */
function spanIsAllowed(el: DomNode): boolean {
    const attrs = attrsOf(el);
    if (attrs.length === 0) return true;
    if (attrs.length < 2 || attrs.length > 3) return false;
    const by = new Map(attrs.map((a) => [a.name.toLowerCase(), a.value]));
    if (by.size !== attrs.length) return false;
    for (const name of by.keys()) if (name !== "data-merge-field" && name !== "style" && name !== "contenteditable") return false;
    if (!by.has("data-merge-field")) return false;
    if (by.has("contenteditable") && by.get("contenteditable") !== "false") return false;
    const style = by.get("style");
    return style !== undefined && CHIP_STYLES.has(normalizeStyle(style));
}

const LIST_OR_P = new Set(["p", "ul", "ol"]);

/** In a list item, content after a <p> must be another <p> or a list: the renderer does not break the line after
 *  a </p> inside an <li>, so loose text or an inline tag following it would be printed joined to it ("onetwo"). */
function liJoinsNothing(li: DomNode): boolean {
    let seenP = false;
    for (let i = 0; i < li.childNodes.length; i++) {
        const c = li.childNodes[i];
        if (c.nodeType === 3) { if (seenP && /\S/.test(c.textContent ?? "x")) return false; continue; }
        if (c.nodeType !== 1) continue;
        const t = (c.localName || "").toLowerCase();
        if (seenP && !LIST_OR_P.has(t)) return false;
        if (t === "p") seenP = true;
    }
    return true;
}

const BLOCK_TAGS: ReadonlySet<string> = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li"]);
/** Inline elements the renderer styles by run: a block inside one loses that style (e.g. no strike on a struck list). */
const INLINE_WRAPPERS: ReadonlySet<string> = new Set(["strong", "b", "em", "i", "u", "s", "strike", "del", "a", "span"]);
/** Deeper list nesting than this is flagged lossy (the indent grows 14pt a level). */
const MAX_LIST_DEPTH = 6;

function elementsAreFaithful(node: DomNode, insideLi: boolean, insideInline = false, insideHeading = false, listDepth = 0): boolean {
    for (let i = 0; i < node.childNodes.length; i++) {
        const el = node.childNodes[i];
        if (el.nodeType !== 1) continue; // text; comments are not displayed
        const tag = (el.localName || "").toLowerCase();
        if (!FAITHFUL_TAGS.has(tag)) return false;
        // A heading inside a list item: the renderer keeps the item's text on one run or starts a new block
        // with an empty bullet.
        if (insideLi && BOUNDARY_TAGS.has(tag)) return false;
        // A block inside an inline element (<del><ul>...) or a block inside a heading: the renderer drops the styling.
        if (BLOCK_TAGS.has(tag) && (insideInline || insideHeading)) return false;
        const depth = tag === "ul" || tag === "ol" ? listDepth + 1 : listDepth;
        if (depth > MAX_LIST_DEPTH) return false;
        if (tag === "span") {
            if (!spanIsAllowed(el)) return false;
        } else {
            for (const a of attrsOf(el)) {
                if (!(tag === "a" && LINK_ATTRS.has(a.name.toLowerCase()))) return false;
            }
        }
        if (tag === "li" && !liJoinsNothing(el)) return false;
        if (!elementsAreFaithful(el, insideLi || tag === "li", insideInline || INLINE_WRAPPERS.has(tag), insideHeading || BOUNDARY_TAGS.has(tag), depth)) return false;
    }
    return true;
}

/**
 * RULE: deny by default. Only add a tag or an attribute here after checking that the portal prose container
 * (Tailwind typography, including its generated quote marks and backticks) and the PDF renderer
 * (pdf-richtext.ts) show the same text, in the same order, with the same emphasis. When in doubt leave it
 * out: a false "lossy" only keeps the complete browser screenshot, a false "exact" is the defect.
 *
 * True when the SANITISED html (the string the PDF renderer will parse) is made only of the elements and
 * attributes listed above. Fails closed: false when the sanitiser cannot run or re-sanitising would change
 * the string. ol "start", li "value", "reversed" and "type" are not honoured by the renderer (it always
 * numbers from 1), so they are outside the allowlist and make the field lossy.
 */
export async function isPortalHtmlFaithful(sanitizedHtml: string): Promise<boolean> {
    try {
        // Re-parsing already-sanitised markup through the same sanitiser yields its DOM (a fragment) without
        // changing it; the walk below runs on that fragment.
        const purify = await loadPurify();
        // Fail closed if sanitising the final string again would change it: then the DOM below could miss a node
        // the regex renderer still prints.
        if (purify.sanitize(sanitizedHtml) !== sanitizedHtml) return false;
        const frag = purify.sanitize(sanitizedHtml, { RETURN_DOM_FRAGMENT: true }) as DomNode | string;
        if (typeof frag === "string") return false;
        return elementsAreFaithful(frag, false);
    } catch {
        return false;
    }
}
