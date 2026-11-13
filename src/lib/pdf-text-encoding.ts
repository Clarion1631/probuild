// What the standard (WinAnsi) PDF fonts can print, in one dependency-free place (no pdf-lib, prisma or
// React) so the server PDF and a client component read the same rule and cannot drift.
//
// The one place text is prepared for the PDF fonts (plain fields and rich text alike): NFC first, then the
// plain-equivalent mappings (not lossy: "<=", curly quotes, dashes), then every character the fonts still
// cannot encode is handled one way: INVISIBLE characters (control, format, variation selectors, tag
// characters) are removed without a trace and are not lossy; every other character prints as "?" and sets
// lossy (letters, emoji, pictographs, arrows, dingbats, box symbols, all of it), because a signed copy must
// not silently differ from what the customer saw. A skin-tone modifier is removed without its own "?" only
// right after a base character that already became "?" (the pair prints one "?").

// WinAnsi (cp1252) Unicode extras beyond ASCII + Latin-1 that the standard PDF fonts can encode.
const WINANSI_EXTRA = "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ";

/** True when the standard fonts can print this single character (tab, newline and CR count as encodable). */
export function isPdfEncodable(ch: string): boolean {
    const c = ch.codePointAt(0)!;
    return c === 9 || c === 10 || c === 13 || (c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff) || WINANSI_EXTRA.includes(ch);
}

const PDF_TEXT_MAP: Record<string, string> = {
    "≤": "<=", "≥": ">=", "≠": "!=", "≈": "~", "→": "->",
    "′": "'", "″": '"',
    "⅓": "1/3", "⅔": "2/3", "⅛": "1/8", "⅜": "3/8", "⅝": "5/8", "⅞": "7/8",
};

/** Map common un-encodable characters to plain equivalents (spaces, hyphens, <=, 1/3 ...) so meaning survives. */
export function mapPdfPlainEquivalents(s: string): string {
    return s
        .replace(/[ -  ]/g, " ")
        .replace(/[‑‒−]/g, "-")
        .replace(/[≤≥≠≈→′″⅓⅔⅛⅜⅝⅞]/g, (ch) => PDF_TEXT_MAP[ch] ?? ch);
}

// Characters a viewer cannot see: control (Cc), format (Cf: zero-width, bidi marks, soft hyphen, BOM, ZWJ),
// variation selectors and tag characters.
const INVISIBLE = /[\p{Cc}\p{Cf}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}\u{E0020}-\u{E007F}]/u;
// Bidi embeddings, overrides and isolates (U+202A-202E, U+2066-2069) invisibly REORDER the text around them, so
// the PDF (which cannot reproduce that) is not an exact copy: removed, but lossy. LRM/RLM/ALM marks stay harmless.
const BIDI_REORDER = /[\u202a-\u202e\u2066-\u2069]/u;
const SKIN_TONE = /[\u{1F3FB}-\u{1F3FF}]/u;
const SPACE_LIKE = /[\p{Zs}\p{Zl}\p{Zp}]/u;

export interface CleanedPdfText { text: string; lossy: boolean }

/**
 * Prepare text for the standard PDF fonts. Returns the cleaned text and whether it is LOSSY: true when at
 * least one visible character was replaced by "?". Removing invisible characters, mapping a symbol to its
 * plain equivalent (for example "<=") and NFC composition are not lossy. Any other character the fonts
 * cannot encode becomes "?", one per character (a skin-tone modifier directly after one is dropped with it).
 */
export function cleanPdfText(text: string): CleanedPdfText {
    const mapped = mapPdfPlainEquivalents(String(text ?? "").normalize("NFC"));
    let out = "";
    let lossy = false;
    let prevWasQuestion = false; // the previous character became "?" (a skin-tone modifier may join it)
    for (const ch of mapped) {
        // A soft hyphen is invisible in a browser but the standard fonts draw it as a hyphen: remove it
        // (isPdfEncodable still accepts it, other code reads that rule).
        if (ch === "\u00ad") continue;
        if (isPdfEncodable(ch)) { out += ch; prevWasQuestion = false; }
        else if (SKIN_TONE.test(ch) && prevWasQuestion) continue;
        else if (BIDI_REORDER.test(ch)) { lossy = true; continue; }
        else if (INVISIBLE.test(ch)) continue;
        else if (SPACE_LIKE.test(ch)) { out += " "; prevWasQuestion = false; }
        else { out += "?"; lossy = true; prevWasQuestion = true; }
    }
    return { text: out, lossy };
}

/** cleanPdfText that records a lossy result on the audit (when one is given) and returns just the text. */
export function cleanPdfTextAudited(text: string, audit?: { lossy: boolean } | null): string {
    const r = cleanPdfText(text);
    if (r.lossy && audit) audit.lossy = true;
    return r.text;
}
