// Room Studio — unit helpers.
// The document stores meters everywhere; the UI speaks feet & inches.

export const M_PER_IN = 0.0254;
export const M_PER_FT = 0.3048;

export const inches = (n: number) => n * M_PER_IN;
export const feet = (n: number) => n * M_PER_FT;

export const toInches = (m: number) => m / M_PER_IN;
export const toFeet = (m: number) => m / M_PER_FT;

/** 2.4384 → `8'0"` ; 0.6096 → `2'0"` ; 0.0762 → `3"` */
export function formatFtIn(meters: number): string {
  const totalIn = Math.round(toInches(Math.abs(meters)) * 4) / 4; // nearest 1/4"
  const ft = Math.floor(totalIn / 12);
  const inch = Math.round((totalIn - ft * 12) * 4) / 4;
  const sign = meters < 0 ? "-" : "";
  if (ft === 0) return `${sign}${trimFrac(inch)}"`;
  return `${sign}${ft}'${trimFrac(inch)}"`;
}

/** Compact inches-only form used for cabinet widths: 0.6096 → `24"` */
export function formatIn(meters: number): string {
  return `${trimFrac(Math.round(toInches(meters) * 4) / 4)}"`;
}

function trimFrac(n: number): string {
  return Number.isInteger(n) ? String(n) : String(n);
}

/** Parse `8'6"`, `8.5'`, `102"`, `8 6`, `8`, → meters. Returns null if unparseable. */
export function parseFtIn(input: string): number | null {
  const s = input.trim().replace(/”|″/g, '"').replace(/’|′/g, "'");
  if (!s) return null;
  // 8'6" or 8' 6 or 8'6
  let m = s.match(/^(\d+(?:\.\d+)?)\s*'\s*(\d+(?:\.\d+)?)?\s*"?$/);
  if (m) return feet(parseFloat(m[1])) + inches(m[2] ? parseFloat(m[2]) : 0);
  // 24" pure inches
  m = s.match(/^(\d+(?:\.\d+)?)\s*"$/);
  if (m) return inches(parseFloat(m[1]));
  // "8 6" → ft in
  m = s.match(/^(\d+)\s+(\d+(?:\.\d+)?)$/);
  if (m) return feet(parseInt(m[1], 10)) + inches(parseFloat(m[2]));
  // bare number: treat ≤ 30 as feet, otherwise inches (nobody types a 40-foot wall in this tool)
  m = s.match(/^(\d+(?:\.\d+)?)$/);
  if (m) {
    const n = parseFloat(m[1]);
    return n <= 30 ? feet(n) : inches(n);
  }
  return null;
}
