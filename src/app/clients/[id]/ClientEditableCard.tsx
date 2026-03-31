"use client";

import { useState } from "react";
import { updateClient } from "@/lib/actions";
import { useRouter } from "next/navigation";
import Avatar from "@/components/Avatar";

export default function ClientEditableCard({ client }: { client: any }) {
    const [isEditing, setIsEditing] = useState(false);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const router = useRouter();

    async function handleSave(e: React.FormEvent<HTMLFormElement>) {
        e.preventDefault();
        setIsSubmitting(true);
        const fd = new FormData(e.currentTarget);
        
        await updateClient(client.id, {
            name: fd.get("name") as string,
            email: fd.get("email") as string,
            primaryPhone: fd.get("primaryPhone") as string,
            addressLine1: fd.get("addressLine1") as string,
            city: fd.get("city") as string,
            state: fd.get("state") as string,
            zipCode: fd.get("zipCode") as string,
        });

        // Normally we'd also update the server action to accept companyName and internalNotes.
        // For now, we update the existing fields the action supports.

        setIsSubmitting(false);
        setIsEditing(false);
        router.refresh();
    }

    if (!isEditing) {
        return (
            <div className="bg-white rounded-lg border border-hui-border p-6 shadow-sm">
                <div className="flex items-center gap-4 mb-6">
                    <Avatar initials={client.initials} size="xl" />
                    <div>
                        <h2 className="text-xl font-bold text-hui-textMain leading-tight">{client.name}</h2>
                        {client.companyName && <p className="text-sm text-hui-textMuted">{client.companyName}</p>}
                    </div>
                </div>

                <div className="space-y-4">
                    <div>
                        <h3 className="text-xs font-semibold uppercase text-hui-textMuted tracking-wider mb-1">Contact Info</h3>
                        <div className="text-sm text-hui-textMain space-y-1">
                            {client.email && <div><a href={`mailto:${client.email}`} className="text-hui-primary hover:underline">{client.email}</a></div>}
                            {client.primaryPhone && <div><a href={`tel:${client.primaryPhone}`} className="text-hui-textMain hover:underline">{client.primaryPhone}</a></div>}
                            {!client.email && !client.primaryPhone && <span className="text-slate-400 italic">No contact info</span>}
                        </div>
                    </div>

                    <div>
                        <h3 className="text-xs font-semibold uppercase text-hui-textMuted tracking-wider mb-1">Address</h3>
                        <div className="text-sm text-hui-textMain">
                            {client.addressLine1 ? (
                                <>
                                    <div>{client.addressLine1}</div>
                                    <div>{client.city}, {client.state} {client.zipCode}</div>
                                </>
                            ) : (
                                <span className="text-slate-400 italic">No address provided</span>
                            )}
                        </div>
                    </div>

                    {client.internalNotes && (
                        <div>
                            <h3 className="text-xs font-semibold uppercase text-hui-textMuted tracking-wider mb-1">Internal Notes</h3>
                            <div className="text-sm text-hui-textMain bg-slate-50 p-3 rounded border border-slate-100 whitespace-pre-wrap">
                                {client.internalNotes}
                            </div>
                        </div>
                    )}
                </div>

                <div className="mt-8 pt-4 border-t border-hui-border">
                    <button onClick={() => setIsEditing(true)} className="hui-btn hui-btn-secondary w-full text-sm">Edit Details</button>
                </div>
            </div>
        );
    }

    return (
        <div className="bg-white rounded-lg border border-hui-border p-6 shadow-xl relative z-10">
            <h2 className="font-bold text-hui-textMain mb-4">Edit Client</h2>
            <form onSubmit={handleSave} className="space-y-4">
                <div>
                    <label className="text-xs font-medium text-hui-textMuted mb-1 block">Full Name</label>
                    <input name="name" defaultValue={client.name} required className="hui-input w-full text-sm" />
                </div>
                <div>
                    <label className="text-xs font-medium text-hui-textMuted mb-1 block">Email</label>
                    <input name="email" type="email" defaultValue={client.email || ""} className="hui-input w-full text-sm" />
                </div>
                <div>
                    <label className="text-xs font-medium text-hui-textMuted mb-1 block">Phone</label>
                    <input name="primaryPhone" defaultValue={client.primaryPhone || ""} className="hui-input w-full text-sm" />
                </div>
                <div className="pt-2">
                    <label className="text-xs font-medium text-hui-textMuted mb-1 block">Address</label>
                    <input name="addressLine1" defaultValue={client.addressLine1 || ""} className="hui-input w-full text-sm mb-2" placeholder="Street" />
                    <div className="grid grid-cols-2 gap-2 mb-2">
                        <input name="city" defaultValue={client.city || ""} className="hui-input w-full text-sm" placeholder="City" />
                        <input name="state" defaultValue={client.state || ""} className="hui-input w-full text-sm" placeholder="State" />
                    </div>
                    <input name="zipCode" defaultValue={client.zipCode || ""} className="hui-input w-full text-sm" placeholder="ZIP" />
                </div>

                <div className="flex justify-end gap-2 pt-4 mt-6 border-t border-hui-border">
                    <button type="button" onClick={() => setIsEditing(false)} className="px-3 py-1.5 text-sm font-medium text-slate-600 hover:text-slate-800 transition">Cancel</button>
                    <button type="submit" disabled={isSubmitting} className="hui-btn hui-btn-primary py-1.5 px-4 text-sm">
                        {isSubmitting ? "Saving..." : "Save Changes"}
                    </button>
                </div>
            </form>
        </div>
    );
}
