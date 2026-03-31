"use client";

import { useState, useTransition } from "react";
import { inviteNewSubcontractor } from "@/lib/subcontractor-actions";

export default function SubcontractorInviteForm({
    projectId,
    onClose,
    onSuccess,
}: {
    projectId: string;
    onClose: () => void;
    onSuccess: (subId: string) => void;
}) {
    const [isPending, startTransition] = useTransition();
    const [formData, setFormData] = useState({
        firstName: "",
        lastName: "",
        company: "",
        website: "",
        email: "",
        phone: "",
        sendEmail: true,
        sendText: false,
    });
    
    const [error, setError] = useState("");

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!formData.company || !formData.email) {
            setError("Company and Email are required.");
            return;
        }

        setError("");
        startTransition(async () => {
            try {
                const res = await inviteNewSubcontractor(projectId, formData);
                if (res.success && res.subId) {
                    onSuccess(res.subId);
                }
            } catch (err: any) {
                setError(err.message || "Something went wrong.");
            }
        });
    };

    return (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm">
            <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl overflow-hidden flex flex-col max-h-[90vh]">
                
                <div className="px-6 py-4 border-b border-border flex items-center justify-between bg-slate-50">
                    <h2 className="text-xl font-bold text-foreground">Add Subcontractor</h2>
                    <button 
                        onClick={onClose}
                        className="p-2 hover:bg-slate-200 rounded-lg text-muted-foreground transition"
                    >
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                    </button>
                </div>

                <div className="p-6 overflow-y-auto flex-1">
                    <p className="text-sm text-muted-foreground mb-6">Enter Subcontractor's contact information here:</p>

                    <form id="invite-sub-form" onSubmit={handleSubmit} className="space-y-8">
                        
                        <div className="space-y-4">
                            <h3 className="font-semibold text-sm flex items-center gap-1">
                                Contact Info
                                <svg className="w-4 h-4 text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7"/></svg>
                            </h3>
                            
                            <div className="grid grid-cols-2 gap-4">
                                <input 
                                    type="text" 
                                    placeholder="First Name" 
                                    className="hui-input"
                                    value={formData.firstName}
                                    onChange={e => setFormData({ ...formData, firstName: e.target.value })}
                                />
                                <input 
                                    type="text" 
                                    placeholder="Last Name" 
                                    className="hui-input"
                                    value={formData.lastName}
                                    onChange={e => setFormData({ ...formData, lastName: e.target.value })}
                                />
                                <input 
                                    type="text" 
                                    placeholder="Company*" 
                                    className="hui-input"
                                    required
                                    value={formData.company}
                                    onChange={e => setFormData({ ...formData, company: e.target.value })}
                                />
                                <input 
                                    type="text" 
                                    placeholder="Website" 
                                    className="hui-input"
                                    value={formData.website}
                                    onChange={e => setFormData({ ...formData, website: e.target.value })}
                                />
                                <input 
                                    type="email" 
                                    placeholder="Email*" 
                                    className="hui-input"
                                    required
                                    value={formData.email}
                                    onChange={e => setFormData({ ...formData, email: e.target.value })}
                                />
                                <input 
                                    type="tel" 
                                    placeholder="Phone Number" 
                                    className="hui-input"
                                    value={formData.phone}
                                    onChange={e => setFormData({ ...formData, phone: e.target.value })}
                                />
                            </div>
                        </div>

                        <div className="space-y-4 pt-4 border-t border-border">
                            <h3 className="font-semibold text-sm flex items-center gap-1">
                                Invite to Project
                                <svg className="w-4 h-4 text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7"/></svg>
                            </h3>

                            <div className="flex items-center gap-6 mt-4">
                                <span className="text-sm font-medium text-foreground">Send invite through:</span>
                                
                                <label className="flex items-center gap-2 cursor-pointer group">
                                    <div className={`w-4 h-4 rounded flex items-center justify-center border transition ${formData.sendEmail ? 'bg-hui-primary border-hui-primary' : 'border-slate-300'}`}>
                                        {formData.sendEmail && <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" strokeWidth="3" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7"/></svg>}
                                    </div>
                                    <input type="checkbox" className="hidden" checked={formData.sendEmail} onChange={e => setFormData({ ...formData, sendEmail: e.target.checked })} />
                                    <span className="text-sm text-foreground group-hover:text-black">Email</span>
                                </label>

                                <label className="flex items-center gap-2 cursor-pointer group">
                                    <div className={`w-4 h-4 rounded flex items-center justify-center border transition ${formData.sendText ? 'bg-hui-primary border-hui-primary' : 'border-slate-300'}`}>
                                        {formData.sendText && <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" strokeWidth="3" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7"/></svg>}
                                    </div>
                                    <input type="checkbox" className="hidden" checked={formData.sendText} onChange={e => setFormData({ ...formData, sendText: e.target.checked })} />
                                    <span className="text-sm text-foreground group-hover:text-black">Text message</span>
                                </label>
                            </div>
                        </div>

                    </form>
                </div>

                <div className="px-6 py-4 border-t border-border flex items-center justify-between">
                    <div className="text-red-500 text-sm font-medium">{error}</div>
                    <div className="flex items-center gap-3">
                        <button type="button" onClick={onClose} className="text-sm font-semibold text-muted-foreground hover:text-foreground">Cancel</button>
                        <button 
                            type="submit" 
                            form="invite-sub-form"
                            disabled={isPending} 
                            className="bg-slate-900 hover:bg-slate-800 text-white font-medium text-sm px-6 py-2 rounded-lg transition disabled:opacity-50 inline-flex items-center"
                        >
                            {isPending ? "Adding..." : "Add"}
                        </button>
                    </div>
                </div>

            </div>
        </div>
    );
}
