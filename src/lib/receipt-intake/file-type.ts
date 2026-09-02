/**
 * What the intake endpoint is willing to store, decided on the BYTES.
 *
 * The client-claimed mime is attacker-controlled, so images are identified by
 * their magic bytes the way src/app/api/receipts/parse/route.ts:37 does.
 * PDF and HEIC have signatures too and are checked here; text/plain has none,
 * so it is the only type allowed to arrive on its declared word.
 *
 * Lives in lib/, not in the route: a Next route file may only export the
 * framework's own names, and this is unit-tested on its own.
 */

export const EXT_BY_MIME: Record<string, string> = {
    "application/pdf": "pdf",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/heic": "heic",
    "image/heif": "heic",
    "image/webp": "webp",
    "image/gif": "gif",
    "text/plain": "txt",
};

export const MAX_INTAKE_BYTES = 15 * 1024 * 1024;

/** ISO-BMFF major brands stored as image/heic (still + HEVC sequence brands). */
export const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "msf1"]);
/** The generic HEIF brands — stored under their own content type. */
export const HEIF_BRANDS = new Set(["mif1", "heif"]);

/** Returns the accepted mime, or null when the bytes are not a supported document. */
export function sniffMime(buf: Buffer, declared: string): string | null {
    const essence = declared.split(";")[0].trim().toLowerCase();
    if (buf.length === 0) return null;
    if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
    if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
    if (buf.length >= 4 && buf.subarray(0, 4).toString("ascii") === "GIF8") return "image/gif";
    if (
        buf.length >= 12 &&
        buf.subarray(0, 4).toString("ascii") === "RIFF" &&
        buf.subarray(8, 12).toString("ascii") === "WEBP"
    ) return "image/webp";
    if (buf.length >= 5 && buf.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
    if (buf.length >= 12 && buf.subarray(4, 8).toString("ascii") === "ftyp") {
        // ISO-BMFF major brands, per ISO/IEC 23008-12. iPhones emit `heic`
        // (still) and `heix`; a burst or a Live Photo still can carry the HEVC
        // brands `hevc`/`hevx`, which an earlier `hei` prefix check silently
        // refused — those uploads came back "unsupported-file-type" from a
        // perfectly readable photo. The image-SEQUENCE brands (`hevc`, `hevx`,
        // `msf1`) are grouped with HEIC because Gemini and QBO both accept them
        // under that content type.
        const brand = buf.subarray(8, 12).toString("ascii").toLowerCase();
        if (HEIC_BRANDS.has(brand)) return "image/heic";
        // `mif1`/`heif` are the generic HEIF brands — kept as image/heif so the
        // stored mimeType says what the file actually claims to be.
        if (HEIF_BRANDS.has(brand)) return "image/heif";
    }
    // text/plain is DELIBERATELY not accepted.
    //
    // QuickBooks cannot attach a .txt, so such a row read fine and then parked
    // at booking with unsupported-attachment — stuck mid-pipeline, which is
    // worse than a clear refusal at the door. v1 converted these to PDF using
    // Apps Script's HTML->PDF `getAs`, which has no Node equivalent: a real
    // port means a PDF generator with wrapping, pagination and WinAnsi encoding
    // (pdf-lib's standard fonts THROW on characters they cannot encode). That
    // is a new silent-corruption surface on a money document, for the rarest
    // input in the pipeline. Refused instead — see the 415 in the intake route.
    void essence;
    return null;
}
