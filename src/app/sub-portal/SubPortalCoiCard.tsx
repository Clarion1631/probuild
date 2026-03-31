"use client";

import { useState, useRef } from "react";
import { toast } from "sonner";
import { subPortalUploadCOI } from "@/lib/actions";

interface Props {
    subId: string;
    coiUploaded: boolean;
    coiExpiresAt: Date | null;
}

export default function SubPortalCoiCard({ subId, coiUploaded, coiExpiresAt }: Props) {
    const [isUploading, setIsUploading] = useState(false);
    const [uploaded, setUploaded] = useState(coiUploaded);
    const fileInputRef = useRef<HTMLInputElement>(null);

    async function handleUploadCOI(e: React.ChangeEvent<HTMLInputElement>) {
        const file = e.target.files?.[0];
        if (!file) return;

        setIsUploading(true);
        try {
            const formData = new FormData();
            formData.append("file", file);
            
            await subPortalUploadCOI(formData);
            
            setUploaded(true);
            toast.success("Certificate of Insurance uploaded successfully");
        } catch (error: any) {
            toast.error(error.message || "Upload failed");
        } finally {
            setIsUploading(false);
            if (fileInputRef.current) fileInputRef.current.value = "";
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
                        {uploaded && coiExpiresAt && ` Your current COI expires on ${new Date(coiExpiresAt).toLocaleDateString()}.`}
                    </p>
                </div>

                <div className="w-full md:w-auto shrink-0">
                    <input 
                        type="file" 
                        ref={fileInputRef} 
                        className="hidden" 
                        accept=".pdf,.png,.jpg,.jpeg" 
                        onChange={handleUploadCOI} 
                    />
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
                                {uploaded ? "Upload New COI" : "Upload COI Document"}
                            </>
                        )}
                    </button>
                </div>
            </div>
        </div>
    );
}
