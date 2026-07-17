"use client";

import { useState, useCallback } from "react";
import {
  type LetterheadMode,
  type LogoPosition,
  type LetterheadField,
  type LetterheadConfig,
  buildLetterheadConfig,
} from "@/lib/letterhead";
import DocumentLetterhead from "@/components/DocumentLetterhead";

const FIELD_LABELS: Record<LetterheadField, string> = {
  name: "Company Name",
  address: "Address",
  phone: "Phone",
  email: "Email",
  license: "License #",
  website: "Website",
};

const COLOR_PRESETS = [
  "#4F46E5", "#0891B2", "#059669", "#D97706", "#DC2626",
  "#7C3AED", "#BE185D", "#1E293B", "#475569",
];

interface Props {
  initialData: Record<string, unknown>;
  onSave: (data: Record<string, unknown>) => Promise<void>;
}

export default function LetterheadConfigurator({ initialData, onSave }: Props) {
  const [mode, setMode] = useState<LetterheadMode>(
    (initialData?.letterheadMode as LetterheadMode) || "built_in"
  );
  const [imageUrl, setImageUrl] = useState<string>(
    (initialData?.letterheadImageUrl as string) || ""
  );
  const [logoPosition, setLogoPosition] = useState<LogoPosition>(
    (initialData?.letterheadLogoPosition as LogoPosition) || "left"
  );
  const [fields, setFields] = useState<LetterheadField[]>(() => {
    if (typeof initialData?.letterheadFields === "string") {
      try { return JSON.parse(initialData.letterheadFields as string); } catch { /* fall through */ }
    }
    return ["name", "address", "phone", "email", "license"];
  });
  const [accentColor, setAccentColor] = useState(
    (initialData?.letterheadAccentColor as string) || "#4F46E5"
  );
  const [showDivider, setShowDivider] = useState(
    initialData?.letterheadDivider !== false
  );
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState({ type: "", text: "" });

  const toggleField = (f: LetterheadField) => {
    setFields((prev) =>
      prev.includes(f) ? prev.filter((x) => x !== f) : [...prev, f]
    );
  };

  const handleUpload = useCallback(async (file: File) => {
    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/letterhead-upload", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Upload failed");
      setImageUrl(data.url);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Upload failed";
      setMessage({ type: "error", text: msg });
    } finally {
      setUploading(false);
    }
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const file = e.dataTransfer.files[0];
      if (file) handleUpload(file);
    },
    [handleUpload]
  );

  const handleSave = async () => {
    setSaving(true);
    setMessage({ type: "", text: "" });
    try {
      await onSave({
        letterheadMode: mode,
        letterheadImageUrl: imageUrl || null,
        letterheadLogoPosition: logoPosition,
        letterheadFields: JSON.stringify(fields),
        letterheadAccentColor: accentColor,
        letterheadDivider: showDivider,
      });
      setMessage({ type: "success", text: "Letterhead saved." });
      setTimeout(() => setMessage({ type: "", text: "" }), 3000);
    } catch {
      setMessage({ type: "error", text: "Failed to save." });
    } finally {
      setSaving(false);
    }
  };

  const previewConfig: LetterheadConfig = {
    mode,
    customImageUrl: imageUrl || null,
    logoUrl: (initialData?.logoUrl as string) || null,
    logoPosition,
    fields,
    accentColor,
    showDivider,
    companyName: (initialData?.companyName as string) || "My Construction Co.",
    address: (initialData?.address as string) || null,
    phone: (initialData?.phone as string) || null,
    email: (initialData?.email as string) || null,
    licenseNumber: (initialData?.licenseNumber as string) || null,
    website: (initialData?.website as string) || null,
  };

  return (
    <div className="space-y-8">
      {/* Mode Toggle */}
      <div className="hui-card p-6">
        <h2 className="text-lg font-bold text-hui-textMain mb-4">Letterhead Mode</h2>
        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => setMode("built_in")}
            className={`flex-1 px-4 py-3 rounded-lg border text-sm font-medium transition-colors ${
              mode === "built_in"
                ? "border-indigo-500 bg-indigo-50 text-indigo-700"
                : "border-hui-border text-hui-textMuted hover:border-slate-300"
            }`}
          >
            <div className="font-semibold">Built-in Layout</div>
            <div className="text-xs mt-1 opacity-75">Configure from your logo &amp; company info</div>
          </button>
          <button
            type="button"
            onClick={() => setMode("custom_image")}
            className={`flex-1 px-4 py-3 rounded-lg border text-sm font-medium transition-colors ${
              mode === "custom_image"
                ? "border-indigo-500 bg-indigo-50 text-indigo-700"
                : "border-hui-border text-hui-textMuted hover:border-slate-300"
            }`}
          >
            <div className="font-semibold">Custom Image</div>
            <div className="text-xs mt-1 opacity-75">Upload a designed header banner</div>
          </button>
        </div>
      </div>

      {/* Mode-specific settings */}
      {mode === "custom_image" ? (
        <div className="hui-card p-6">
          <h2 className="text-lg font-bold text-hui-textMain mb-4">Header Image</h2>
          <p className="text-sm text-hui-textMuted mb-4">
            Recommended size: 2100 &times; 300 pixels (7:1 ratio). PNG or JPG only, max 2 MB.
          </p>
          {imageUrl ? (
            <div className="space-y-3">
              <div className="border border-hui-border rounded-lg overflow-hidden bg-slate-50">
                <img src={imageUrl} alt="Letterhead preview" className="w-full h-auto max-h-[200px] object-contain" />
              </div>
              <button
                type="button"
                onClick={() => setImageUrl("")}
                className="text-sm text-red-600 hover:text-red-700 font-medium"
              >
                Remove image
              </button>
            </div>
          ) : (
            <div
              onDragOver={(e) => e.preventDefault()}
              onDrop={handleDrop}
              className="border-2 border-dashed border-hui-border rounded-lg p-8 text-center hover:border-indigo-300 transition-colors cursor-pointer"
              onClick={() => {
                const input = document.createElement("input");
                input.type = "file";
                input.accept = "image/png,image/jpeg";
                input.onchange = (e) => {
                  const f = (e.target as HTMLInputElement).files?.[0];
                  if (f) handleUpload(f);
                };
                input.click();
              }}
            >
              {uploading ? (
                <p className="text-sm text-hui-textMuted">Uploading...</p>
              ) : (
                <>
                  <svg className="mx-auto h-10 w-10 text-slate-300 mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                  </svg>
                  <p className="text-sm text-hui-textMuted">
                    Drag &amp; drop an image here, or <span className="text-indigo-600 font-medium">click to browse</span>
                  </p>
                </>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="hui-card p-6 space-y-6">
          <div>
            <h2 className="text-lg font-bold text-hui-textMain mb-4">Layout Options</h2>
            <label className="text-sm font-medium text-hui-textMain block mb-2">Logo Position</label>
            <div className="flex gap-2">
              {(["left", "center", "right"] as LogoPosition[]).map((pos) => (
                <button
                  key={pos}
                  type="button"
                  onClick={() => setLogoPosition(pos)}
                  className={`px-4 py-2 rounded-md text-sm font-medium border transition-colors capitalize ${
                    logoPosition === pos
                      ? "border-indigo-500 bg-indigo-50 text-indigo-700"
                      : "border-hui-border text-hui-textMuted hover:border-slate-300"
                  }`}
                >
                  {pos}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="text-sm font-medium text-hui-textMain block mb-2">Visible Fields</label>
            <div className="grid grid-cols-2 gap-2">
              {(Object.keys(FIELD_LABELS) as LetterheadField[]).map((f) => (
                <label key={f} className="flex items-center gap-2 text-sm text-hui-textMain cursor-pointer">
                  <input
                    type="checkbox"
                    checked={fields.includes(f)}
                    onChange={() => toggleField(f)}
                    className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                  />
                  {FIELD_LABELS[f]}
                </label>
              ))}
            </div>
          </div>

          <div>
            <label className="text-sm font-medium text-hui-textMain block mb-2">Accent Color</label>
            <div className="flex items-center gap-2 flex-wrap">
              {COLOR_PRESETS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setAccentColor(c)}
                  className={`w-8 h-8 rounded-full border-2 transition-all ${
                    accentColor === c ? "border-slate-800 scale-110" : "border-transparent"
                  }`}
                  style={{ backgroundColor: c }}
                />
              ))}
              <input
                type="text"
                value={accentColor}
                onChange={(e) => setAccentColor(e.target.value)}
                className="hui-input w-24 text-sm"
                maxLength={7}
                placeholder="#4F46E5"
              />
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm text-hui-textMain cursor-pointer">
            <input
              type="checkbox"
              checked={showDivider}
              onChange={(e) => setShowDivider(e.target.checked)}
              className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
            />
            Show accent bar at top of documents
          </label>
        </div>
      )}

      {/* Live Preview */}
      <div className="hui-card overflow-hidden">
        <div className="px-6 py-3 border-b border-hui-border bg-slate-50">
          <h3 className="text-sm font-semibold text-hui-textMuted uppercase tracking-wider">Preview</h3>
        </div>
        <div className="bg-white">
          <DocumentLetterhead
            config={previewConfig}
            rightContent={
              <div className="text-right">
                <h1 className="text-2xl font-bold text-slate-800 tracking-tight">ESTIMATE</h1>
                <div className="mt-2 space-y-1 text-sm">
                  <p className="text-slate-500">Estimate # <span className="font-semibold text-slate-700">EST-001</span></p>
                  <p className="text-slate-500">Date: <span className="text-slate-700">{new Date().toLocaleDateString()}</span></p>
                </div>
              </div>
            }
          />
        </div>
      </div>

      {/* Save */}
      <div className="flex items-center gap-4">
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="hui-btn hui-btn-primary"
        >
          {saving ? "Saving..." : "Save Letterhead"}
        </button>
        {message.text && (
          <p className={`text-sm font-medium ${message.type === "success" ? "text-green-600" : "text-red-600"}`}>
            {message.text}
          </p>
        )}
      </div>
    </div>
  );
}
