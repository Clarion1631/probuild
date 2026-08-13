// Server-side job-site address normalization via the Google Geocoding API.
//
// The lead/project forms use the Places autocomplete widget, but selecting a
// suggestion is optional (raw keystrokes save verbatim) and the mobile intake
// API takes free text, so hand-typed strings reach the DB. Normalizing at save
// time gives every entry path a verified formatted address — which also
// upgrades the WA DOR tax lookup (wa-tax.ts) from zip-level to exact-address
// matches.
//
// Fail-soft: any miss (no key, denied key, timeout, ambiguous/partial match)
// returns null and callers keep the raw user string. NEXT_PUBLIC_GOOGLE_MAPS_
// API_KEY is browser-referrer-restricted (verified live: REQUEST_DENIED from
// a server) — server calls need GOOGLE_MAPS_SERVER_API_KEY.

const GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json";
const GEOCODE_TIMEOUT_MS = 3000;

export type GeocodedAddress = {
    formattedAddress: string;
    // Set only for precise matches (ROOFTOP / RANGE_INTERPOLATED). A city-level
    // geocode must never place a time-clock geofence at a city center, so
    // coarse results normalize the string but leave coordinates untouched.
    lat: number | null;
    lng: number | null;
};

let warnedDenied = false;

// Exported for tests. Positive recognition, not a label denylist: a 5-digit
// group counts as a zip only when it directly follows US-address zip context —
// a two-letter token (state abbreviation, "WA 98665") or a comma ("Vancouver,
// 98661"). Labelled numbers ("PO Box 98665", "Unit 20500", "Site: 12345") and
// 5-digit house numbers never qualify. The last qualifying group wins, so a
// trailing unit ("…, WA 98661, Unit 205") still yields the zip. Zip+4 keeps
// the first five digits. US-only by design, matching region=us below.
const ZIP_CONTEXT_RE = /(?:\b[A-Za-z]{2}[.,]?|,)\s*(\d{5})(?:-\d{4})?\b/g;

export function extractZip(text: string): string | null {
    let zip: string | null = null;
    for (const m of text.matchAll(ZIP_CONTEXT_RE)) zip = m[1];
    return zip;
}

function googlePostalCode(result: any): string | null {
    if (!Array.isArray(result?.address_components)) return null;
    const comp = result.address_components.find(
        (c: any) => Array.isArray(c?.types) && c.types.includes("postal_code")
    );
    const code = comp?.short_name || comp?.long_name;
    return typeof code === "string" && /^\d{5}/.test(code) ? code.slice(0, 5) : null;
}

export async function geocodeJobSiteAddress(raw: string | null | undefined): Promise<GeocodedAddress | null> {
    const address = raw?.trim();
    if (!address) return null;
    const key = process.env.GOOGLE_MAPS_SERVER_API_KEY || process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
    if (!key) return null;
    try {
        const params = new URLSearchParams({ address, region: "us", key });
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), GEOCODE_TIMEOUT_MS);
        let payload: any;
        try {
            const res = await fetch(`${GEOCODE_URL}?${params.toString()}`, { signal: controller.signal });
            if (!res.ok) return null;
            payload = await res.json();
        } finally {
            clearTimeout(timeoutId);
        }
        if (payload?.status === "REQUEST_DENIED" && !warnedDenied) {
            warnedDenied = true;
            console.warn(
                `[geocode] Google Geocoding request denied: ${payload.error_message ?? "(no message)"} — ` +
                `set GOOGLE_MAPS_SERVER_API_KEY (the NEXT_PUBLIC key is referrer-restricted).`
            );
        }
        // Exactly one candidate required: multiple results mean the input was
        // ambiguous, and storing Google's first guess could change the meaning.
        if (payload?.status !== "OK" || !Array.isArray(payload.results) || payload.results.length !== 1) return null;
        const result = payload.results[0];
        // partial_match means Google changed/guessed part of the input; keep the
        // user's raw string rather than risk normalizing to a different place.
        if (result.partial_match === true) return null;
        const formattedAddress = typeof result.formatted_address === "string" ? result.formatted_address.trim() : "";
        if (!formattedAddress) return null;
        const geometry = result.geometry ?? {};
        const precise = geometry.location_type === "ROOFTOP" || geometry.location_type === "RANGE_INTERPOLATED";
        let lat: number | null = null;
        let lng: number | null = null;
        if (precise && typeof geometry.location?.lat === "number" && typeof geometry.location?.lng === "number") {
            lat = geometry.location.lat;
            lng = geometry.location.lng;
        }
        // Google silently "corrects" a zip it disagrees with — without setting
        // partial_match — which reverted hand-fixed zips on every save (EST-00508,
        // Aug 2026). A zip the user typed wins over Google's (or over a result
        // that dropped it); the coordinates still apply since the street itself
        // resolved. Google's zip comes from address_components, not string parsing.
        const inputZip = extractZip(address);
        const googleZip = googlePostalCode(result) ?? extractZip(formattedAddress);
        const zipOverridden = inputZip != null && inputZip !== googleZip;
        return { formattedAddress: zipOverridden ? address : formattedAddress, lat, lng };
    } catch {
        return null;
    }
}
