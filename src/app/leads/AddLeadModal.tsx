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

    // Job site address — writes to lead.location
    const [jobSiteLocation, setJobSiteLocation] = useState("");
    const [jobSiteAddr, setJobSiteAddr] = useState("");
    const [jobSiteCity, setJobSiteCity] = useState("");
    const [jobSiteState, setJobSiteState] = useState("");
    const [jobSiteZip, setJobSiteZip] = useState("");

    // "Client lives at a different address" — unchecked by default (homeowner case)
    const [clientAddressDiffers, setClientAddressDiffers] = useState(false);

    // Client contact address — only used when checkbox is checked
    const [clientAddr, setClientAddr] = useState("");
    const [clientCity, setClientCity] = useState("");
    const [clientState, setClientState] = useState("");
    const [clientZip, setClientZip] = useState("");
    const [clientLocation, setClientLocation] = useState("");

    const router = useRouter();

    async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
        e.preventDefault();
        setIsSubmitting(true);
        const formData = new FormData(e.currentTarget);

        // When checkbox unchecked: client address = job site structured breakdown
        // (only for new clients — returning-client guard in createLead preserves existing addresses)
        const resolvedAddr = clientAddressDiffers ? clientAddr : jobSiteAddr;
        const resolvedCity = clientAddressDiffers ? clientCity : jobSiteCity;
        const resolvedState = clientAddressDiffers ? clientState : jobSiteState;
        const resolvedZip = clientAddressDiffers ? clientZip : jobSiteZip;

        const data = {
            name: formData.get("name") as string,
            clientName: formData.get("clientName") as string,
            clientEmail: formData.get("clientEmail") as string,
            clientPhone: formData.get("clientPhone") as string,
            location: jobSiteLocation || undefined,
            addressLine1: resolvedAddr || undefined,
            city: resolvedCity || undefined,
            state: resolvedState || undefined,
            zipCode: resolvedZip || undefined,
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

                    {/* Job Site Address */}
                    <div>
                        <label className="block text-sm text-hui-textMuted mb-1">Job Site Address</label>
                        <GoogleMapsAutocomplete
                            value={jobSiteLocation}
                            onChange={(val) => {
                                setJobSiteLocation(val);
                                // Clear structured fields when user types (prevent stale mix)
                                setJobSiteAddr(""); setJobSiteCity(""); setJobSiteState(""); setJobSiteZip("");
                            }}
                            onPlaceDetails={(d) => {
                                setJobSiteAddr(d.address || "");
                                setJobSiteCity(d.city || "");
                                setJobSiteState(d.state || "");
                                setJobSiteZip(d.zip || "");
                            }}
                            className="hui-input w-full"
                        />
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                        <div>
                            <label className="text-xs text-slate-500 block mb-1">City</label>
                            <input type="text" value={jobSiteCity} onChange={e => setJobSiteCity(e.target.value)} className="hui-input w-full text-sm" />
                        </div>
                        <div>
                            <label className="text-xs text-slate-500 block mb-1">State</label>
                            <input type="text" value={jobSiteState} onChange={e => setJobSiteState(e.target.value)} className="hui-input w-full text-sm" />
                        </div>
                        <div>
                            <label className="text-xs text-slate-500 block mb-1">Zip</label>
                            <input type="text" value={jobSiteZip} onChange={e => setJobSiteZip(e.target.value)} className="hui-input w-full text-sm" />
                        </div>
                    </div>

                    {/* Text link to reveal client contact address — hidden by default (90% homeowner case) */}
                    {!clientAddressDiffers && (
                        <button
                            type="button"
                            onClick={() => setClientAddressDiffers(true)}
                            className="text-xs text-slate-400 hover:text-hui-primary transition flex items-center gap-1"
                        >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>
                            Client lives at a different address
                        </button>
                    )}

                    {/* Client Contact Address — only shown when link is clicked */}
                    {clientAddressDiffers && (
                        <div className="space-y-2 border-l-2 border-slate-200 pl-3">
                            <div className="flex items-center justify-between">
                                <label className="block text-sm text-hui-textMuted">Client Contact Address</label>
                                <button
                                    type="button"
                                    onClick={() => setClientAddressDiffers(false)}
                                    className="text-xs text-slate-400 hover:text-slate-600 transition"
                                >
                                    Remove
                                </button>
                            </div>
                            <GoogleMapsAutocomplete
                                value={clientLocation}
                                onChange={(val) => {
                                    setClientLocation(val);
                                    setClientAddr(""); setClientCity(""); setClientState(""); setClientZip("");
                                }}
                                onPlaceDetails={(d) => {
                                    setClientAddr(d.address || "");
                                    setClientCity(d.city || "");
                                    setClientState(d.state || "");
                                    setClientZip(d.zip || "");
                                }}
                                className="hui-input w-full"
                            />
                            <div className="grid grid-cols-3 gap-2">
                                <div>
                                    <label className="text-xs text-slate-500 block mb-1">City</label>
                                    <input type="text" value={clientCity} onChange={e => setClientCity(e.target.value)} className="hui-input w-full text-sm" />
                                </div>
                                <div>
                                    <label className="text-xs text-slate-500 block mb-1">State</label>
                                    <input type="text" value={clientState} onChange={e => setClientState(e.target.value)} className="hui-input w-full text-sm" />
                                </div>
                                <div>
                                    <label className="text-xs text-slate-500 block mb-1">Zip</label>
                                    <input type="text" value={clientZip} onChange={e => setClientZip(e.target.value)} className="hui-input w-full text-sm" />
                                </div>
                            </div>
                        </div>
                    )}

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
