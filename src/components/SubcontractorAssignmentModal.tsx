"use client";

import { useState, useTransition } from "react";
import SubcontractorInviteForm from "./SubcontractorInviteForm";
import { toggleSubcontractorProjectAccess, resendSubcontractorInvite } from "@/lib/subcontractor-actions";
import Link from "next/link";

type SubcontractorItem = {
    id: string;
    companyName: string;
    email: string | null;
    phone: string | null;
    isAssigned: boolean;
};

export default function SubcontractorAssignmentModal({
    projectId,
    initialSubcontractors,
    onClose,
}: {
    projectId: string;
    initialSubcontractors: SubcontractorItem[];
    onClose: () => void;
}) {
    const [subs, setSubs] = useState<SubcontractorItem[]>(initialSubcontractors);
    const [searchQuery, setSearchQuery] = useState("");
    const [showInviteForm, setShowInviteForm] = useState(false);
    const [isPending, startTransition] = useTransition();
    const [resendingId, setResendingId] = useState<string | null>(null);

    if (showInviteForm) {
        return (
            <SubcontractorInviteForm 
                projectId={projectId}
                onClose={() => setShowInviteForm(false)} 
                onSuccess={(newSubId: string) => {
                    // Mute/reload logic done via server action revalidatePath
                    onClose(); 
                }}
            />
        );
    }

    const filtered = subs.filter(s => 
        s.companyName.toLowerCase().includes(searchQuery.toLowerCase()) ||
        s.email?.toLowerCase().includes(searchQuery.toLowerCase())
    );

    const handleAssign = (sub: SubcontractorItem, isAssigning: boolean) => {
        // Optimistic toggle
        setSubs(curr => curr.map(s => s.id === sub.id ? { ...s, isAssigned: isAssigning } : s));

        startTransition(async () => {
            await toggleSubcontractorProjectAccess(projectId, sub.id, isAssigning);
        });
    };

    const handleResend = async (sub: SubcontractorItem) => {
        setResendingId(sub.id);
        try {
            await resendSubcontractorInvite(projectId, sub.id);
        } finally {
            setResendingId(null);
            alert(`Invite resent to ${sub.email || sub.companyName}`);
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm">
            <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl overflow-hidden flex flex-col max-h-[90vh]">
                {/* Header */}
                <div className="px-6 py-4 border-b border-border flex items-center justify-between">
                    <h2 className="text-xl font-bold text-foreground">Subcontractors</h2>
                    <button 
                        onClick={onClose}
                        className="p-2 hover:bg-slate-100 rounded-lg text-muted-foreground transition"
                    >
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                    </button>
                </div>

                {/* Body Tools */}
                <div className="p-6 border-b border-border flex items-center gap-4 bg-slate-50">
                    <div className="relative flex-1">
                        <svg className="w-5 h-5 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
                        <input 
                            type="text" 
                            placeholder="Search subcontractors"
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            className="hui-input pl-10"
                        />
                    </div>
                    <button 
                        onClick={() => setShowInviteForm(true)}
                        className="hui-btn bg-slate-900 hover:bg-slate-800 text-white shrink-0 border border-slate-900"
                    >
                        <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
                        Invite Subcontractors
                    </button>
                </div>

                {/* List */}
                <div className="overflow-y-auto flex-1 p-2">
                    {filtered.length === 0 ? (
                        <div className="p-8 text-center text-muted-foreground">No subcontractors found.</div>
                    ) : (
                        <div className="divide-y divide-slate-50">
                            {filtered.map(sub => (
                                <div key={sub.id} className="flex items-center justify-between p-4 hover:bg-slate-50 rounded-lg transition-colors group">
                                    <Link href={`/company/subcontractors/${sub.id}`} className="flex items-center gap-4 min-w-0 flex-1 hover:opacity-80 transition cursor-pointer">
                                        <div className="w-10 h-10 rounded-full bg-slate-200 flex items-center justify-center shrink-0 uppercase font-bold text-slate-500 text-sm">
                                            {sub.companyName.substring(0, 2)}
                                        </div>
                                        <div className="min-w-0">
                                            <p className="font-semibold text-foreground truncate group-hover:text-hui-primary transition-colors">{sub.companyName}</p>
                                            <div className="flex items-center gap-2 text-xs text-muted-foreground truncate">
                                                {sub.email && <span>{sub.email}</span>}
                                                {sub.email && sub.phone && <span>|</span>}
                                                {sub.phone && <span>{sub.phone}</span>}
                                            </div>
                                        </div>
                                    </Link>
                                    <div className="shrink-0 pl-4 flex items-center gap-2">
                                        {sub.isAssigned ? (
                                            <>
                                                <button 
                                                    disabled={resendingId === sub.id}
                                                    onClick={() => handleResend(sub)}
                                                    className="hui-btn bg-white hover:bg-slate-50 text-slate-600 border border-slate-200"
                                                >
                                                    {resendingId === sub.id ? "Sending..." : "Resend Invite"}
                                                </button>
                                                <button 
                                                    disabled={isPending}
                                                    onClick={() => handleAssign(sub, false)}
                                                    className="hui-btn bg-green-50 text-green-700 hover:bg-red-50 hover:text-red-700 hover:border-red-200 border border-green-200 min-w-[100px] justify-center group-hover:block"
                                                >
                                                    <span className="block group-hover:hidden group-focus:hidden group-active:hidden">Assigned ✓</span>
                                                    <span className="hidden group-hover:block group-focus:block group-active:block text-red-600">Remove</span>
                                                </button>
                                            </>
                                        ) : (
                                            <button 
                                                disabled={isPending}
                                                onClick={() => handleAssign(sub, true)}
                                                className="hui-btn hui-btn-secondary min-w-[120px] justify-center"
                                            >
                                                Add to Project
                                            </button>
                                        )}
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
