"use client";

import { type LetterheadConfig } from "@/lib/letterhead";
import { type ReactNode } from "react";

interface DocumentLetterheadProps {
  config: LetterheadConfig;
  rightContent?: ReactNode;
}

function CompanyInfoLines({ config }: { config: LetterheadConfig }) {
  const lines: { key: string; value: string }[] = [];
  for (const f of config.fields) {
    let v: string | null = null;
    switch (f) {
      case "name": v = config.companyName; break;
      case "address": v = config.address; break;
      case "phone": v = config.phone; break;
      case "email": v = config.email; break;
      case "license": v = config.licenseNumber ? `Lic# ${config.licenseNumber}` : null; break;
      case "website": v = config.website; break;
    }
    if (v) lines.push({ key: f, value: v });
  }

  return (
    <>
      {lines.map(({ key, value }, i) =>
        i === 0 ? (
          <h2 key={key} className="text-lg font-bold text-slate-800">{value}</h2>
        ) : (
          <p key={key} className="text-sm text-slate-500">{value}</p>
        )
      )}
    </>
  );
}

export default function DocumentLetterhead({ config, rightContent }: DocumentLetterheadProps) {
  if (config.mode === "custom_image" && config.customImageUrl) {
    return (
      <div className="border-b border-slate-200">
        <img
          src={config.customImageUrl}
          alt="Letterhead"
          className="w-full h-auto block max-h-[200px] object-contain object-left"
        />
        {rightContent && (
          <div className="px-10 pb-6 flex justify-between items-start">
            <div />
            {rightContent}
          </div>
        )}
      </div>
    );
  }

  const logo = config.logoUrl ? (
    <img
      src={config.logoUrl}
      alt={config.companyName}
      className="h-14 w-auto object-contain mb-3"
    />
  ) : null;

  const isCenter = config.logoPosition === "center";

  return (
    <div className="px-10 pt-10 pb-8 border-b border-slate-200 print:px-6">
      {config.showDivider && (
        <div
          className="h-1 -mt-10 -mx-10 mb-8 print:-mx-6"
          style={{ backgroundColor: config.accentColor }}
        />
      )}
      <div className={`flex ${isCenter ? "flex-col items-center text-center" : "justify-between items-start"}`}>
        <div className={isCenter ? "flex flex-col items-center" : ""}>
          {logo}
          <CompanyInfoLines config={config} />
        </div>
        {!isCenter && rightContent}
      </div>
      {isCenter && rightContent && (
        <div className="mt-6 text-center">{rightContent}</div>
      )}
    </div>
  );
}
