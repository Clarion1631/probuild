"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { saveClientTaxExemptCert, removeClientTaxExemptCert } from "@/lib/actions";
import { getTaxCertStatus, formatCertExpiry } from "@/lib/tax-cert";

interface TaxExemptCertCardProps {
    clientId: string;
    certUrl: string | null;
    certExpiresAt: string | null; // ISO string
    certNote: string | null;
    onSaved?: (cert: { taxExemptCertUrl: string | null; taxExemptCertExpiresAt: string | null; taxExemptCertNote: string | null }) => void;
}

const STATUS_PILL: Record<string, { label: string; className: string }> = {
    valid: { label: "On File", className: "bg-green-100 text-green-700" },
    expired: { label: "Expired", className: "bg-red-100 text-red-700" },
    missing: { label: "None on File", className: "bg-slate-100 text-slate-700" },
};

/** Upload / view / remove a client's reseller permit or tax-exemption
 *  certificate (WA DOR requires one on file for every tax-exempt sale).
 *  Used on the lead detail sidebar and the Settings → Contacts list. */
export default function TaxExemptCertCard({ clientId, certUrl, certExpiresAt, certNote, onSaved }: TaxExemptCertCardProps) {
    const router = useRouter();
    const [editing, setEditing] = useState(false);
    const [file, setFile] = useState<File | null>(null);
    const [expiresAt, setExpiresAt] = useState("");
    const [note, setNote] = useState("");
    const [saving, setSaving] = useState(false);
    const [removing, setRemoving] = useState(false);

    const status = getTaxCertStatus({ url: certUrl, expiresAt: certExpiresAt });
    const pill = STATUS_PILL[status];

    const startEdit = () => {
        setFile(null);
        setExpiresAt(certExpiresAt ? certExpiresAt.split("T")[0] : "");
        setNote(certNote || "");
        setEditing(true);
    };

    const handleSave = async () => {
        if (!certUrl && !file) {
            toast.error("Choose a certificate file to upload");
            return;
        }
        setSaving(true);
        try {
            const fd = new FormData();
            if (file) fd.append("file", file);
            fd.append("expiresAt", expiresAt);
            fd.append("note", note);
            const updated = await saveClientTaxExemptCert(clientId, fd);
            toast.success("Certificate saved");
            setEditing(false);
            onSaved?.(updated);
            router.refresh();
        } catch (e: any) {
            toast.error(e.message || "Failed to save certificate");
        } finally {
            setSaving(false);
        }
    };

    const handleRemove = async () => {
        if (!window.confirm("Remove this certificate from the client record?")) return;
        setRemoving(true);
        try {
            const updated = await removeClientTaxExemptCert(clientId);
            toast.success("Certificate removed");
            setEditing(false);
            onSaved?.(updated);
            router.refresh();
        } catch (e: any) {
            toast.error(e.message || "Failed to remove certificate");
        } finally {
            setRemoving(false);
        }
    };

    return (
        <div>
            <div className="flex items-center justify-between mb-1.5">
                <h3 className="text-sm font-bold text-hui-textMain">Tax Exemption Certificate</h3>
                <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${pill.className}`}>{pill.label}</span>
            </div>
            <p className="text-xs text-hui-textMuted mb-3">
                WA DOR requires a reseller permit or exemption certificate on file for every tax-exempt sale.
            </p>

            {!editing ? (
                <div className="space-y-2 text-sm">
                    {certUrl ? (
                        <>
                            <a
                                href={certUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1.5 text-green-600 hover:text-green-700 font-medium hover:underline transition"
                            >
                                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                                View certificate
                            </a>
                            <div className="flex items-center justify-between">
                                <span className="text-hui-textMuted">Expires</span>
                                <span className={status === "expired" ? "text-red-600 font-semibold" : "text-hui-textMain font-medium"}>
                                    {certExpiresAt ? formatCertExpiry(certExpiresAt) : "No expiry set"}
                                </span>
                            </div>
                            {certNote && <p className="text-xs text-hui-textMuted break-words">{certNote}</p>}
                        </>
                    ) : (
                        <p className="text-slate-400 italic">No certificate uploaded.</p>
                    )}
                    <button onClick={startEdit} className="hui-btn hui-btn-secondary text-xs w-full">
                        {certUrl ? "Update Certificate" : "Upload Certificate"}
                    </button>
                </div>
            ) : (
                <div className="space-y-3">
                    <div>
                        <label className="text-xs text-slate-500 block mb-1">Certificate file (PDF or image)</label>
                        <input
                            type="file"
                            accept=".pdf,image/*"
                            onChange={e => setFile(e.target.files?.[0] || null)}
                            className="block w-full text-xs text-hui-textMuted file:mr-2 file:py-1.5 file:px-3 file:rounded-md file:border file:border-hui-border file:bg-white file:text-xs file:font-medium file:text-hui-textMain hover:file:bg-slate-50 file:cursor-pointer"
                        />
                        {certUrl && !file && (
                            <p className="text-[11px] text-hui-textMuted mt-1">Leave empty to keep the current file.</p>
                        )}
                    </div>
                    <div>
                        <label className="text-xs text-slate-500 block mb-1">Expiration date</label>
                        <input type="date" value={expiresAt} onChange={e => setExpiresAt(e.target.value)} className="hui-input w-full text-sm" />
                    </div>
                    <div>
                        <label className="text-xs text-slate-500 block mb-1">Note</label>
                        <input
                            type="text"
                            value={note}
                            onChange={e => setNote(e.target.value)}
                            placeholder="e.g. Reseller permit #600-123-456"
                            className="hui-input w-full text-sm"
                        />
                    </div>
                    <div className="flex items-center gap-2">
                        <button onClick={handleSave} disabled={saving} className="hui-btn hui-btn-green text-xs disabled:opacity-50">
                            {saving ? "Saving..." : "Save"}
                        </button>
                        <button onClick={() => setEditing(false)} className="hui-btn hui-btn-secondary text-xs">Cancel</button>
                        {certUrl && (
                            <button
                                onClick={handleRemove}
                                disabled={removing}
                                className="ml-auto text-xs text-red-600 hover:text-red-700 font-medium hover:underline transition disabled:opacity-50"
                            >
                                {removing ? "Removing..." : "Remove"}
                            </button>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
