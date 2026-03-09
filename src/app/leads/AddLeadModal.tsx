"use client";

import { useState } from "react";
import { createLead } from "@/lib/actions";
import { useRouter } from "next/navigation";

export default function AddLeadModal({ onClose }: { onClose: () => void }) {
    const [isSubmitting, setIsSubmitting] = useState(false);
    const router = useRouter();

    async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
        e.preventDefault();
        setIsSubmitting(true);
        const formData = new FormData(e.currentTarget);
        const data = {
            name: formData.get("name") as string,
            clientName: formData.get("clientName") as string,
            clientEmail: formData.get("clientEmail") as string,
            clientPhone: formData.get("clientPhone") as string,
            location: formData.get("location") as string,
            source: formData.get("source") as string,
            projectType: formData.get("projectType") as string,
        };

        const result = await createLead(data);
        if (result.id) {
            router.push(`/leads/${result.id}`);
            onClose();
        }
        setIsSubmitting(false);
    }

    return (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
            <div className="bg-white rounded-lg p-6 w-[500px]">
                <h2 className="text-xl font-bold text-hui-textMain mb-4">Add New Lead</h2>
                <form onSubmit={handleSubmit} className="space-y-4">
                    <div>
                        <label className="block text-sm text-hui-textMuted mb-1">Lead Name / Description</label>
                        <input name="name" required type="text" className="hui-input w-full" placeholder="e.g. Master Bath Remodel" />
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <label className="block text-sm text-hui-textMuted mb-1">Client Name</label>
                            <input name="clientName" required type="text" className="hui-input w-full" />
                        </div>
                        <div>
                            <label className="block text-sm text-hui-textMuted mb-1">Client Email</label>
                            <input name="clientEmail" type="email" className="hui-input w-full" />
                        </div>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <label className="block text-sm text-hui-textMuted mb-1">Client Phone</label>
                            <input name="clientPhone" type="text" className="hui-input w-full" />
                        </div>
                        <div>
                            <label className="block text-sm text-hui-textMuted mb-1">Project Location</label>
                            <input name="location" type="text" className="hui-input w-full" />
                        </div>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <label className="block text-sm text-hui-textMuted mb-1">Lead Source</label>
                            <select name="source" className="hui-input w-full">
                                <option value="">Select source...</option>
                                <option value="My Website">My Website</option>
                                <option value="Houzz">Houzz</option>
                                <option value="Referral">Referral</option>
                                <option value="Manually Created">Manually Created</option>
                            </select>
                        </div>
                        <div>
                            <label className="block text-sm text-hui-textMuted mb-1">Project Type</label>
                            <input name="projectType" type="text" className="hui-input w-full" placeholder="e.g. Kitchen" />
                        </div>
                    </div>
                    <div className="flex justify-end gap-3 mt-6 pt-4 border-t border-hui-border">
                        <button type="button" onClick={onClose} className="hui-btn hui-btn-secondary border-hui-border">Cancel</button>
                        <button type="submit" disabled={isSubmitting} className="hui-btn hui-btn-primary">
                            {isSubmitting ? "Saving..." : "Create Lead"}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}
