"use client";

import { useState } from "react";
import { createLead } from "@/lib/actions";
import { useRouter } from "next/navigation";
import ClientCombobox from "@/components/ClientCombobox";
import GoogleMapsAutocomplete from "@/components/GoogleMapsAutocomplete";

export default function AddLeadModal({ onClose }: { onClose: () => void }) {
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [clientEmail, setClientEmail] = useState("");
    const [clientPhone, setClientPhone] = useState("");
    // Address state — cLocation holds the canonical formatted_address from Google Places
    // (or raw typed text), cAddr/cCity/cState/cZip hold the structured breakdown.
    // GoogleMapsAutocomplete fires onChange first with formatted_address, then onPlaceDetails
    // with the per-component breakdown — we keep them in non-overlapping state slots.
    const [cLocation, setCLocation] = useState("");
    const [cAddr, setCAddr] = useState("");
    const [cCity, setCCity] = useState("");
    const [cState, setCState] = useState("");
    const [cZip, setCZip] = useState("");
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
            location: cLocation || undefined,
            addressLine1: cAddr || undefined,
            city: cCity || undefined,
            state: cState || undefined,
            zipCode: cZip || undefined,
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
            <div className="bg-white rounded-lg p-6 w-[500px] shadow-xl max-h-[90vh] overflow-y-auto">
                <h2 className="text-xl font-bold text-hui-textMain mb-4">Add New Lead</h2>
                <form onSubmit={handleSubmit} className="space-y-4">
                    <div>
                        <label className="block text-sm text-hui-textMuted mb-1">Lead Name / Description</label>
                        <input name="name" required type="text" className="hui-input w-full" placeholder="e.g. Master Bath Remodel" />
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <label className="block text-sm text-hui-textMuted mb-1">Client Name</label>
                            <ClientCombobox 
                                name="clientName" 
                                onSelect={(client) => {
                                    if (client.email) setClientEmail(client.email);
                                    if (client.primaryPhone) setClientPhone(client.primaryPhone);
                                }} 
                            />
                        </div>
                        <div>
                            <label className="block text-sm text-hui-textMuted mb-1">Client Email</label>
                            <input name="clientEmail" type="email" value={clientEmail} onChange={e => setClientEmail(e.target.value)} className="hui-input w-full" placeholder="Optional" />
                        </div>
                    </div>
                    <div>
                        <label className="block text-sm text-hui-textMuted mb-1">Client Phone</label>
                        <input name="clientPhone" type="text" value={clientPhone} onChange={e => setClientPhone(e.target.value)} className="hui-input w-full" placeholder="Optional" />
                    </div>
                    <div>
                        <label className="block text-sm text-hui-textMuted mb-1">Project Address</label>
                        <GoogleMapsAutocomplete
                            value={cLocation}
                            onChange={setCLocation}
                            onPlaceDetails={(d) => {
                                setCAddr(d.address || "");
                                setCCity(d.city || "");
                                setCState(d.state || "");
                                setCZip(d.zip || "");
                            }}
                            className="hui-input w-full"
                        />
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                        <div>
                            <label className="text-xs text-slate-500 block mb-1">City</label>
                            <input type="text" value={cCity} onChange={e => setCCity(e.target.value)} className="hui-input w-full text-sm" />
                        </div>
                        <div>
                            <label className="text-xs text-slate-500 block mb-1">State</label>
                            <input type="text" value={cState} onChange={e => setCState(e.target.value)} className="hui-input w-full text-sm" />
                        </div>
                        <div>
                            <label className="text-xs text-slate-500 block mb-1">Zip</label>
                            <input type="text" value={cZip} onChange={e => setCZip(e.target.value)} className="hui-input w-full text-sm" />
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
