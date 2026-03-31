"use client";

import { useState, useRef } from "react";
import { toast } from "sonner";
import { subPortalUploadCOI } from "@/lib/actions";

interface Props {
    subId: string;
    coiUploaded: boolean;
    coiExpiresAt: Date | null;
    coiFileUrl: string | null;
}

export default function SubPortalCoiCard({ subId, coiUploaded, coiExpiresAt: initialExpires, coiFileUrl: initialFileUrl }: Props) {
    const [isUploading, setIsUploading] = useState(false);
    const [isDeleting, setIsDeleting] = useState(false);
    const [uploaded, setUploaded] = useState(coiUploaded);
    const [localExpiresAt, setLocalExpiresAt] = useState<Date | null>(initialExpires);
    const [localFileUrl, setLocalFileUrl] = useState<string | null>(initialFileUrl);
    const fileInputRef = useRef<HTMLInputElement>(null);

    async function handleUploadCOI(e: React.ChangeEvent<HTMLInputElement>) {
        const file = e.target.files?.[0];
        if (!file) return;

        setIsUploading(true);
        try {
            const formData = new FormData();
            formData.append("file", file);
            
            const res = await subPortalUploadCOI(formData);
            
            setUploaded(true);
            setLocalFileUrl(res.url || null);
            if (res.coiExpiresAt) {
                setLocalExpiresAt(new Date(res.coiExpiresAt));
                toast.success(`AI Extracted Expiration: ${new Date(res.coiExpiresAt).toLocaleDateString()}`);
            } else {
                toast.success("Certificate of Insurance uploaded successfully");
            }
        } catch (error: any) {
            toast.error(error.message || "Upload failed");
        } finally {
            setIsUploading(false);
            if (fileInputRef.current) fileInputRef.current.value = "";
        }
    }

    async function handleDeleteCOI() {
        if (!confirm("Are you sure you want to remove your Certificate of Insurance?")) return;
        setIsDeleting(true);
        try {
            const { subPortalDeleteCOI } = await import("@/lib/actions");
            await subPortalDeleteCOI();
            setUploaded(false);
            setLocalExpiresAt(null);
            setLocalFileUrl(null);
            toast.success("Certificate removed");
        } catch (error: any) {
            toast.error(error.message || "Failed to remove certificate");
        } finally {
            setIsDeleting(false);
        }
    }

    return (
        <div className="bg-white rounded-xl shadow-sm border border-hui-border overflow-hidden mb-8">
            <div className="p-4 border-b border-hui-border bg-slate-50/50 flex justify-between items-center">
                <h2 className="text-sm font-bold text-hui-textMain uppercase tracking-wider">Compliance Settings</h2>
                <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider ${uploaded ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"}`}>
                    {uploaded ? "Compliant" : "Missing COI"}
                </span>
            </div>
            <div className="p-5 flex flex-col md:flex-row gap-5 items-center justify-between">
                <div>
                    <h3 className="text-base font-semibold text-hui-textMain mb-1">Certificate of Insurance (COI)</h3>
                    <p className="text-sm text-slate-500 max-w-lg">
                        You must maintain an active Certificate of Insurance on file to be assigned to new projects.
                        {uploaded && localExpiresAt && ` Your current COI expires on ${new Date(localExpiresAt).toLocaleDateString()}.`}
                    </p>
                </div>

                <div className="w-full md:w-auto shrink-0 flex items-center gap-3">
                    <input 
                        type="file" 
                        ref={fileInputRef} 
                        className="hidden" 
                        accept=".pdf,.png,.jpg,.jpeg" 
                        onChange={handleUploadCOI} 
                    />
                    
                    {uploaded ? (
                        <div className="flex flex-col gap-2 w-full md:w-auto">
                            <div className="flex gap-2 w-full">
                                {localFileUrl && (
                                    <a 
                                        href={localFileUrl} 
                                        target="_blank" 
                                        rel="noreferrer" 
                                        className="flex-1 px-4 py-2 border border-slate-300 rounded-lg text-sm font-medium text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50 transition flex items-center justify-center gap-2 bg-white shadow-sm"
                                    >
                                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
                                        View
                                    </a>
                                )}
                                <button 
                                    onClick={handleDeleteCOI}
                                    disabled={isDeleting || isUploading}
                                    className="flex-1 px-4 py-2 border border-slate-300 rounded-lg text-sm font-medium text-red-600 hover:text-red-700 hover:bg-red-50 transition disabled:opacity-50 flex items-center justify-center gap-2 bg-white shadow-sm"
                                >
                                    {isDeleting ? (
                                        <svg className="animate-spin w-4 h-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                                    ) : (
                                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                                    )}
                                    Delete
                                </button>
                            </div>
                            <button 
                                onClick={() => fileInputRef.current?.click()}
                                disabled={isUploading || isDeleting}
                                className="w-full px-4 py-2 text-sm font-medium text-hui-primary hover:underline transition disabled:opacity-50 text-center"
                            >
                                {isUploading ? "Uploading..." : "Upload Replacement"}
                            </button>
                        </div>
                    ) : (
                        <button 
                            onClick={() => fileInputRef.current?.click()}
                            disabled={isUploading}
                            className="w-full md:w-auto px-6 py-2 border border-dashed border-slate-300 rounded-lg text-sm font-medium text-slate-600 hover:text-hui-primary hover:border-hui-primary hover:bg-indigo-50 transition disabled:opacity-50 flex items-center justify-center gap-2 bg-white shadow-sm"
                        >
                            {isUploading ? (
                                <>
                                    <svg className="animate-spin w-4 h-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                                    Uploading...
                                </>
                            ) : (
                                <>
                                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>
                                    Upload COI Document
                                </>
                            )}
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}
