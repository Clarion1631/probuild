import type { RawHeader } from "./authentication";
import type { FallbackPayload } from "./payload";

/**
 * A pure parser for the connect@ Group's forwarded copy of the site's
 * contact-form email (docs/plans/SPEED-TO-LEAD-V1A.md finding 5). The site
 * (gtr-sales-draft's `src/app/api/contact/route.ts`) sends a plain-text body
 * shaped like:
 *
 *   Name: Jane Doe
 *   Email: jane@example.com
 *   Phone: (360) 555-0100
 *   Project city: Vancouver, WA
 *   Project scope: Kitchen remodel
 *   Message:
 *   We want to redo our kitchen...
 *
 * Gmail HTML-entity-encodes the body when it renders as `text/html` (the
 * Group's relay commonly does this) — `&amp;`, `&#39;`, `&quot;` and numeric
 * entities are decoded before the labels are matched. `email` always comes
 * from `Reply-To`, per the V1A addendum, never from a `Email:` label in the
 * body (the label is used only when Reply-To is itself missing or invalid).
 *
 * On any parse failure this returns `parsed: false` and a message body that
 * is never dropped, never thrown — intake.ts's caller falls back to a
 * "Website inquiry" REVIEW lead when `parsed` is false.
 */

const NAMED_ENTITIES: Record<string, string> = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'",
};

export function decodeHtmlEntities(text: string): string {
    return text
        .replace(/&(#\d+);/g, (_m, dec: string) => String.fromCharCode(Number(dec.slice(1))))
        .replace(/&(#x[0-9a-f]+);/gi, (_m, hex: string) => String.fromCharCode(parseInt(hex.slice(2), 16)))
        .replace(/&([a-z]+|#\d+);/gi, (m, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
}

function extractReplyTo(headers: RawHeader[]): string | null {
    const raw = headers.find(h => h.name.toLowerCase() === "reply-to")?.value ?? null;
    if (!raw) return null;
    const angled = /<([^>]+)>/.exec(raw)?.[1];
    const candidate = (angled ?? raw).trim().toLowerCase();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate) ? candidate : null;
}

/** One `Label: value` line — case-insensitive label, value trimmed, entities decoded. Multi-line "Message:" is handled separately (it is always last). */
function extractLabel(body: string, label: string): string | null {
    const pattern = new RegExp(`^[ \\t]*${label}[ \\t]*:[ \\t]*(.+)$`, "im");
    const match = pattern.exec(body);
    if (!match) return null;
    const value = decodeHtmlEntities(match[1]).trim();
    return value.length > 0 ? value : null;
}

/** Everything after a `Message:` label line, to the end of the body. */
function extractMessageBody(body: string): string | null {
    const match = /^[ \t]*Message[ \t]*:[ \t]*\r?\n?([\s\S]*)$/im.exec(body);
    if (!match) return null;
    const value = decodeHtmlEntities(match[1]).trim();
    return value.length > 0 ? value : null;
}

export function parseFallbackEmail(input: { headers: RawHeader[]; bodyText: string; submissionId: string | null }): FallbackPayload {
    const decodedBody = decodeHtmlEntities(input.bodyText);
    const name = extractLabel(decodedBody, "Name");
    const emailFromReplyTo = extractReplyTo(input.headers);
    const email = emailFromReplyTo ?? extractLabel(decodedBody, "Email");
    const phone = extractLabel(decodedBody, "Phone");
    const city = extractLabel(decodedBody, "Project city") ?? extractLabel(decodedBody, "City");
    const scope = extractLabel(decodedBody, "Project scope") ?? extractLabel(decodedBody, "Scope");
    const message = extractMessageBody(decodedBody);

    // "parsed" requires the labelled fields that make this a real,
    // structured submission — Name, an email, and a Message body. Phone/
    // city/scope are optional on the site's own form.
    const parsed = !!name && !!email && !!message;

    return {
        name,
        email,
        phone,
        city,
        scope,
        // A malformed body still keeps its raw (decoded) text, truncated to
        // the schema's own cap, so a REVIEW lead built from it is never
        // empty — just unstructured.
        message: (message ?? decodedBody.trim()).slice(0, 10_000),
        submissionId: input.submissionId,
        parsed,
        matchedRule: "website-group-relay",
    };
}
