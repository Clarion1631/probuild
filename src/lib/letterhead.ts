export type LetterheadMode = "built_in" | "custom_image";
export type LogoPosition = "left" | "center" | "right";
export type LetterheadField = "name" | "address" | "phone" | "email" | "license" | "website";

export interface LetterheadConfig {
  mode: LetterheadMode;
  customImageUrl: string | null;
  logoUrl: string | null;
  logoPosition: LogoPosition;
  fields: LetterheadField[];
  accentColor: string;
  showDivider: boolean;
  companyName: string;
  address: string | null;
  phone: string | null;
  email: string | null;
  licenseNumber: string | null;
  website: string | null;
}

const DEFAULT_FIELDS: LetterheadField[] = ["name", "address", "phone", "email", "license"];

export function buildLetterheadConfig(settings: Record<string, unknown> | null | undefined): LetterheadConfig {
  const s = settings ?? {};
  let fields: LetterheadField[] = DEFAULT_FIELDS;
  if (typeof s.letterheadFields === "string") {
    try { fields = JSON.parse(s.letterheadFields); } catch { /* keep default */ }
  }

  return {
    mode: (s.letterheadMode as LetterheadMode) || "built_in",
    customImageUrl: (s.letterheadImageUrl as string) || null,
    logoUrl: (s.logoUrl as string) || null,
    logoPosition: (s.letterheadLogoPosition as LogoPosition) || "left",
    fields,
    accentColor: (s.letterheadAccentColor as string) || "#4F46E5",
    showDivider: s.letterheadDivider !== false,
    companyName: (s.companyName as string) || "My Construction Co.",
    address: (s.address as string) || null,
    phone: (s.phone as string) || null,
    email: (s.email as string) || null,
    licenseNumber: (s.licenseNumber as string) || null,
    website: (s.website as string) || null,
  };
}

function fieldValue(config: LetterheadConfig, field: LetterheadField): string | null {
  switch (field) {
    case "name": return config.companyName;
    case "address": return config.address;
    case "phone": return config.phone;
    case "email": return config.email;
    case "license": return config.licenseNumber ? `Lic# ${config.licenseNumber}` : null;
    case "website": return config.website;
  }
}

export function letterheadToHtml(config: LetterheadConfig): string {
  if (config.mode === "custom_image" && config.customImageUrl) {
    return `<div style="border-bottom:1px solid #e2e8f0;">
      <img src="${config.customImageUrl}" alt="Letterhead" style="width:100%;height:auto;display:block;" />
    </div>`;
  }

  const lines = config.fields
    .map((f) => fieldValue(config, f))
    .filter(Boolean);

  const logoHtml = config.logoUrl
    ? `<img src="${config.logoUrl}" alt="${config.companyName}" style="max-height:56px;width:auto;object-fit:contain;margin-bottom:8px;" />`
    : "";

  const accentBar = config.showDivider
    ? `<div style="height:4px;background:${config.accentColor};margin-bottom:24px;"></div>`
    : "";

  const align = config.logoPosition === "center" ? "center" : "left";

  return `<div style="padding:40px 40px 32px;border-bottom:1px solid #e2e8f0;">
    ${accentBar}
    <div style="text-align:${align};">
      ${logoHtml}
      ${lines.map((l, i) => i === 0
        ? `<div style="font-size:18px;font-weight:700;color:#1e293b;">${l}</div>`
        : `<div style="font-size:14px;color:#64748b;">${l}</div>`
      ).join("\n      ")}
    </div>
  </div>`;
}
