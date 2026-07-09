// Address-based sales tax defaulting for new estimates (WA-only).
//
// Washington is destination-based: the combined sales tax rate comes from the
// job-site address, not a company-wide default. On estimate creation we ask
// the WA DOR rate-lookup service for the rate at the project/lead address and
// persist it as the estimate's taxRateName/taxRatePercent. The editor's rate
// dropdown still lets the user override. Every miss (no usable address,
// out-of-state, service down) returns null so creation falls back to the
// existing company-default behavior — null must never be treated as exempt.
//
// Service contract (verified live 2026-07):
//   GET https://webgis.dor.wa.gov/webapi/AddressRates.aspx?output=xml&addr=&city=&zip=
//   - zip is required; addr+city refine the match from county-level to exact address
//   - hit:  <response ... rate=".080" code="0"><rate name="WINLOCK" .../></response>
//   - miss: rate="-1" (e.g. code="9" for a non-WA zip) — no <rate> element

import { prisma } from "./prisma";

const DOR_LOOKUP_URL = "https://webgis.dor.wa.gov/webapi/AddressRates.aspx";
const LOOKUP_TIMEOUT_MS = 3000;

type AddressQuery = { addr: string; city: string; zip: string };

type ClientAddress = {
    addressLine1: string | null;
    city: string | null;
    state: string | null;
    zipCode: string | null;
};

// "204 SW Kerron St, Winlock, WA 98596" → parts the DOR service understands.
// Null without a WA-shaped 5-digit zip (the service rejects zip-less queries).
function parseLocationText(text: string | null | undefined): AddressQuery | null {
    if (!text) return null;
    // Last WA-shaped zip (980xx–994xx live in 98/99): house numbers can be five
    // digits too, so first-match breaks "12345 NE 8th St Bellevue WA 98005".
    const zipMatches = [...text.matchAll(/\b(9[89]\d{3})(?:-\d{4})?\b/g)];
    const zipMatch = zipMatches[zipMatches.length - 1];
    if (!zipMatch) return null;
    const zip = zipMatch[1];
    const parts = text.split(",").map(p => p.trim()).filter(Boolean);
    if (parts.length === 1) {
        // Comma-less free text ("709 w 32 st Vancouver Washington 98660"): the
        // DOR geocoder tolerates trailing city text inside addr (verified live),
        // so send everything before the zip/state as one addr string. Only the
        // matched zip token and a TRAILING/LONE state token are stripped —
        // "123 Washington Ave" keeps its street name.
        const single = parts[0];
        const zipStart = single.lastIndexOf(zipMatch[0]);
        const withoutZip = zipStart >= 0 ? single.slice(0, zipStart) + single.slice(zipStart + zipMatch[0].length) : single;
        const stripped = withoutZip
            .replace(/[.,]/g, " ")
            .replace(/(?:^|\s)(WA|Washington)\s*$/i, " ")
            .replace(/\s+/g, " ")
            .trim();
        return /^\d/.test(stripped) ? { addr: stripped, city: "", zip } : { addr: "", city: stripped, zip };
    }
    const street = /^\d/.test(parts[0]) ? parts[0] : "";
    let city = "";
    for (const part of street ? parts.slice(1) : parts) {
        const cleaned = part
            .replace(/\b\d{5}(?:-\d{4})?\b/g, "")
            .replace(/\b(WA|Washington)\b/gi, "")
            .replace(/[.,]/g, "")
            .trim();
        if (cleaned && !/\d/.test(cleaned)) {
            city = cleaned;
            break;
        }
    }
    return { addr: street, city, zip };
}

function titleCase(name: string): string {
    return name
        .toLowerCase()
        .replace(/(^|[\s-])[a-z]/g, c => c.toUpperCase())
        // DOR jurisdiction acronyms (e.g. "CLARK PTBA") should stay uppercase.
        .replace(/\b(Ptba|Rta|Cez)\b/g, s => s.toUpperCase());
}

async function lookupWaTaxRate(query: AddressQuery): Promise<{ name: string; ratePercent: number } | null> {
    const params = new URLSearchParams({ output: "xml", addr: query.addr, city: query.city, zip: query.zip });
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
    let xml: string;
    try {
        const res = await fetch(`${DOR_LOOKUP_URL}?${params.toString()}`, { signal: controller.signal });
        if (!res.ok) return null;
        xml = await res.text();
    } catch {
        return null;
    } finally {
        clearTimeout(timeoutId);
    }
    // `rate` on <response> is the combined state+local rate as a decimal (".080").
    // `\brate=` can't match inside `localrate=` (no word boundary mid-word).
    const rate = Number(xml.match(/<response[^>]*\brate="([^"]+)"/)?.[1]);
    const name = xml.match(/<rate\b[^>]*\bname="([^"]*)"/)?.[1]?.trim();
    if (!name || !Number.isFinite(rate) || rate <= 0 || rate >= 0.25) return null;
    // Store as a percent (8.0, 10.35) to match CompanySettings.salesTaxes rates.
    return { name: titleCase(name), ratePercent: Math.round(rate * 10000) / 100 };
}

// Resolve the default tax fields for a new estimate from its owner's job-site
// address: the project/lead free-text location first, then the client's
// billing address as a proxy. Fail-soft: null means "keep current defaulting".
export async function defaultTaxForNewEstimate(owner: {
    projectId?: string | null;
    leadId?: string | null;
}): Promise<{ taxRateName: string; taxRatePercent: number } | null> {
    try {
        const clientSelect = { select: { addressLine1: true, city: true, state: true, zipCode: true } };
        let location: string | null = null;
        let client: ClientAddress | null = null;
        if (owner.projectId) {
            const project = await prisma.project.findUnique({
                where: { id: owner.projectId },
                select: { location: true, client: clientSelect },
            });
            location = project?.location ?? null;
            client = project?.client ?? null;
        } else if (owner.leadId) {
            const lead = await prisma.lead.findUnique({
                where: { id: owner.leadId },
                select: { location: true, client: clientSelect },
            });
            location = lead?.location ?? null;
            client = lead?.client ?? null;
        }

        const candidates: AddressQuery[] = [];
        const fromLocation = parseLocationText(location);
        if (fromLocation) candidates.push(fromLocation);

        const clientState = client?.state?.trim().toUpperCase() ?? "";
        const clientZip = client?.zipCode?.match(/\b(9[89]\d{3})\b/)?.[1];
        const clientInWa = clientState === "" || clientState === "WA" || clientState === "WASHINGTON";
        if (clientZip && clientInWa) {
            const clientCandidate = {
                addr: client?.addressLine1?.trim() ?? "",
                city: client?.city?.trim() ?? "",
                zip: clientZip,
            };
            if (!fromLocation) {
                candidates.push(clientCandidate);
            } else if (clientCandidate.zip === fromLocation.zip) {
                // Same zip: the billing address only helps if it adds the street
                // the free text lacked — then it refines a coarse zip-level match,
                // so it goes first. Otherwise it would just repeat the lookup.
                if (!fromLocation.addr && clientCandidate.addr) candidates.unshift(clientCandidate);
            } else {
                // Different zip: the job-site location stays first — the billing
                // address may be a different destination, so it's only a backup.
                candidates.push(clientCandidate);
            }
        }

        // Fire lookups together (bounds worst-case latency to one timeout) but
        // honor candidate priority when picking the winner. allSettled so one
        // unexpected rejection can't discard another candidate's hit.
        const settled = await Promise.allSettled(candidates.map(lookupWaTaxRate));
        for (const s of settled) {
            if (s.status === "fulfilled" && s.value) {
                return { taxRateName: s.value.name, taxRatePercent: s.value.ratePercent };
            }
        }
        return null;
    } catch {
        return null;
    }
}
