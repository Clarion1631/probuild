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
        const brand = buf.subarray(8, 12).toString("ascii").toLowerCase();
        if (brand.startsWith("hei") || brand.startsWith("mif1") || brand.startsWith("msf1")) return "image/heic";
    }
    return essence === "text/plain" ? "text/plain" : null;
}
