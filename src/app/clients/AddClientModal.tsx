"use client";

import { useState } from "react";
import { createClient } from "@/lib/actions";
import { useRouter } from "next/navigation";

export default function AddClientModal({ onClose }: { onClose: () => void }) {
    const [isSubmitting, setIsSubmitting] = useState(false);
    const router = useRouter();

    async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
        e.preventDefault();
        setIsSubmitting(true);
        const formData = new FormData(e.currentTarget);
        const data = {
            name: formData.get("name") as string,
            email: formData.get("email") as string,
            companyName: formData.get("companyName") as string,
            primaryPhone: formData.get("primaryPhone") as string,
            addressLine1: formData.get("addressLine1") as string,
            city: formData.get("city") as string,
            state: formData.get("state") as string,
            zipCode: formData.get("zipCode") as string,
            internalNotes: formData.get("internalNotes") as string,
        };

        const result = await createClient(data);
        if (result.id) {
            router.push(`/clients/${result.id}`);
            onClose();
        }
        setIsSubmitting(false);
    }

    return (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-lg p-6 w-[550px] shadow-xl max-h-[90vh] overflow-y-auto">
                <h2 className="text-xl font-bold text-hui-textMain mb-4">Add New Client</h2>
                <form onSubmit={handleSubmit} className="space-y-4">
                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <label className="block text-sm text-hui-textMuted mb-1">Full Name *</label>
                            <input name="name" required type="text" className="hui-input w-full" placeholder="e.g. John Doe" />
                        </div>
                        <div>
                            <label className="block text-sm text-hui-textMuted mb-1">Company (Optional)</label>
                            <input name="companyName" type="text" className="hui-input w-full" placeholder="e.g. Acme Corp" />
                        </div>
                    </div>
                    <div className="grid grid-cols-2 gap-4 border-b border-hui-border pb-4">
                        <div>
                            <label className="block text-sm text-hui-textMuted mb-1">Email</label>
                            <input name="email" type="email" className="hui-input w-full" placeholder="john@example.com" />
                        </div>
                        <div>
                            <label className="block text-sm text-hui-textMuted mb-1">Primary Phone</label>
                            <input name="primaryPhone" type="text" className="hui-input w-full" placeholder="(555) 123-4567" />
                        </div>
                    </div>

                    <h3 className="text-sm font-semibold text-hui-textMain">Address</h3>
                    <div>
                        <label className="block text-sm text-hui-textMuted mb-1">Address Line 1</label>
                        <input name="addressLine1" type="text" className="hui-input w-full" placeholder="123 Main St" />
                    </div>
                    <div className="grid grid-cols-3 gap-4 border-b border-hui-border pb-4">
                        <div className="col-span-1">
                            <label className="block text-sm text-hui-textMuted mb-1">City</label>
                            <input name="city" type="text" className="hui-input w-full" placeholder="City" />
                        </div>
                        <div>
                            <label className="block text-sm text-hui-textMuted mb-1">State</label>
                            <input name="state" type="text" className="hui-input w-full" placeholder="CA" />
                        </div>
                        <div>
                            <label className="block text-sm text-hui-textMuted mb-1">ZIP</label>
                            <input name="zipCode" type="text" className="hui-input w-full" placeholder="12345" />
                        </div>
                    </div>

                    <div>
                        <label className="block text-sm text-hui-textMuted mb-1">Internal Notes</label>
                        <textarea name="internalNotes" rows={3} className="hui-input w-full resize-none" placeholder="Notes about this client..." />
                    </div>

                    <div className="flex justify-end gap-3 mt-6 pt-4 border-t border-hui-border">
                        <button type="button" onClick={onClose} className="hui-btn hui-btn-secondary border-hui-border">Cancel</button>
                        <button type="submit" disabled={isSubmitting} className="hui-btn hui-btn-primary">
                            {isSubmitting ? "Creating..." : "Create Client"}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}
