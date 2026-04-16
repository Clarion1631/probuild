// Meters ↔ feet/inches conversion helpers. Factored out of PropertiesPanel so
// the MeasurementInputBar and any future tooling share one source of truth.

export const M_TO_IN = 39.3701;
export const IN_TO_M = 0.0254;

/** Format meters as `ft' in"` (e.g. 0.9144 → `3' 0"`). */
export function fmtInches(m: number): string {
    const totalIn = m * M_TO_IN;
    const ft = Math.floor(totalIn / 12);
    const inches = Math.round(totalIn - ft * 12);
    if (ft === 0) return `${inches}"`;
    return `${ft}' ${inches}"`;
}

/** Radians → degrees, normalized to 0..360 for display. */
export function radToDeg(r: number): number {
    const d = (r * 180) / Math.PI;
    return ((d % 360) + 360) % 360;
}

export function degToRad(d: number): number {
    return (d * Math.PI) / 180;
}

/**
 * Parse a user-entered string as inches. Accepts plain numbers (inches) or
 * `ft' in"` syntax (`3' 6"`, `3'6`, `3ft 6in`, `3-6`). Returns meters, or
 * `null` if unparseable.
 */
export function parseFeetInches(input: string): number | null {
    const s = input.trim().toLowerCase();
    if (s.length === 0) return null;
    // Plain number → inches.
    const plain = Number(s);
    if (Number.isFinite(plain)) return plain * IN_TO_M;
    // `3'6"` / `3' 6` / `3ft 6in` / `3-6`
    const m = s.match(/^(-?\d+(?:\.\d+)?)\s*(?:'|ft|-)\s*(\d+(?:\.\d+)?)?\s*(?:"|in)?$/);
    if (m) {
        const ft = parseFloat(m[1]);
        const inch = m[2] ? parseFloat(m[2]) : 0;
        if (Number.isFinite(ft) && Number.isFinite(inch)) {
            const totalIn = ft * 12 + (ft < 0 ? -inch : inch);
            return totalIn * IN_TO_M;
        }
    }
    return null;
}
