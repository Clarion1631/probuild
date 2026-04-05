"use client";

import { useState } from "react";
import { updateClient, updateLead } from "@/lib/actions";
import { toast } from "sonner";
import { formatCurrency } from "@/lib/utils";
import { useRouter } from "next/navigation";

interface LeadDetailsCardsProps {
    leadId: string;
    leadName: string;
    leadSource: string | null;
    expectedStartDate: string | null;
    targetRevenue: number | null;
    location: string | null;
    projectType: string | null;
    clientId: string;
    clientName: string;
    clientEmail: string | null;
    clientPhone: string | null;
    clientAddress: string | null;
    clientCity: string | null;
    clientState: string | null;
    clientZip: string | null;
}

export default function LeadDetailsCards({
    leadId, leadName, leadSource, expectedStartDate, targetRevenue, location, projectType,
    clientId, clientName, clientEmail, clientPhone, clientAddress, clientCity, clientState, clientZip,
}: LeadDetailsCardsProps) {
    const router = useRouter();

    // ── Client editing ───
    const [editingClient, setEditingClient] = useState(false);
    const [cName, setCName] = useState(clientName);
    const [cEmail, setCEmail] = useState(clientEmail || "");
    const [cPhone, setCPhone] = useState(clientPhone || "");
    const [cAddr, setCAddr] = useState(clientAddress || "");
    const [cCity, setCCity] = useState(clientCity || "");
    const [cState, setCState] = useState(clientState || "");
    const [cZip, setCZip] = useState(clientZip || "");
    const [savingClient, setSavingClient] = useState(false);

    // ── Lead editing ───
    const [editingLead, setEditingLead] = useState(false);
    const [lName, setLName] = useState(leadName);
    const [lSource, setLSource] = useState(leadSource || "");
    const [lStartDate, setLStartDate] = useState(expectedStartDate || "");
    const [lRevenue, setLRevenue] = useState(targetRevenue?.toString() || "");
    const [lLocation, setLLocation] = useState(location || "");
    const [lType, setLType] = useState(projectType || "");
    const [savingLead, setSavingLead] = useState(false);

    const handleSaveClient = async () => {
        setSavingClient(true);
        try {
            await updateClient(clientId, {
                name: cName,
                email: cEmail || undefined,
                primaryPhone: cPhone || undefined,
                addressLine1: cAddr || undefined,
                city: cCity || undefined,
                state: cState || undefined,
                zipCode: cZip || undefined,
            });
            toast.success("Client details updated");
            setEditingClient(false);
            router.refresh();
        } catch (e: any) { toast.error(e.message || "Failed to save"); }
        finally { setSavingClient(false); }
    };

    const handleSaveLead = async () => {
        setSavingLead(true);
        try {
            await updateLead(leadId, {
                name: lName,
                source: lSource || undefined,
                expectedStartDate: lStartDate || null,
                targetRevenue: lRevenue ? parseFloat(lRevenue) : null,
                location: lLocation || undefined,
                projectType: lType || undefined,
            });
            toast.success("Lead details updated");
            setEditingLead(false);
            router.refresh();
        } catch (e: any) { toast.error(e.message || "Failed to save"); }
        finally { setSavingLead(false); }
    };

    const formatAddress = () => {
        const parts = [clientAddress, clientCity, clientState, clientZip].filter(Boolean);
        return parts.length > 0 ? parts.join(", ") : null;
    };

    return (
        <div className="grid grid-cols-2 gap-6">
            {/* ── Client Details Card ── */}
            <div className="hui-card p-6">
                <h3 className="font-semibold text-hui-textMain text-sm mb-4 flex justify-between items-center">
                    Client Details
                    {!editingClient ? (
                        <button onClick={() => setEditingClient(true)} className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium text-hui-textMain bg-white border border-hui-border rounded-md hover:bg-slate-50 transition shadow-sm">
                            Edit
                        </button>
                    ) : (
                        <div className="flex gap-2">
                            <button onClick={() => setEditingClient(false)} className="px-3 py-1 text-xs font-medium text-slate-500 border border-slate-200 rounded-md hover:bg-slate-50 transition">Cancel</button>
                            <button onClick={handleSaveClient} disabled={savingClient} className="px-3 py-1 text-xs font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 transition disabled:opacity-50">
                                {savingClient ? "Saving..." : "Save"}
                            </button>
                        </div>
                    )}
                </h3>

                {editingClient ? (
                    <div className="space-y-3">
                        <div>
                            <label className="text-xs text-hui-textMuted block mb-1">Name</label>
                            <input type="text" value={cName} onChange={e => setCName(e.target.value)} className="hui-input w-full text-sm" />
                        </div>
                        <div>
                            <label className="text-xs text-hui-textMuted block mb-1">Email</label>
                            <input type="email" value={cEmail} onChange={e => setCEmail(e.target.value)} className="hui-input w-full text-sm" placeholder="email@example.com" />
                        </div>
                        <div>
                            <label className="text-xs text-hui-textMuted block mb-1">Phone</label>
                            <input type="tel" value={cPhone} onChange={e => setCPhone(e.target.value)} className="hui-input w-full text-sm" placeholder="(555) 123-4567" />
                        </div>
                        <div>
                            <label className="text-xs text-hui-textMuted block mb-1">Address</label>
                            <input type="text" value={cAddr} onChange={e => setCAddr(e.target.value)} className="hui-input w-full text-sm" placeholder="123 Main St" />
                        </div>
                        <div className="grid grid-cols-3 gap-2">
                            <div>
                                <label className="text-xs text-hui-textMuted block mb-1">City</label>
                                <input type="text" value={cCity} onChange={e => setCCity(e.target.value)} className="hui-input w-full text-sm" placeholder="City" />
                            </div>
                            <div>
                                <label className="text-xs text-hui-textMuted block mb-1">State</label>
                                <input type="text" value={cState} onChange={e => setCState(e.target.value)} className="hui-input w-full text-sm" placeholder="ST" />
                            </div>
                            <div>
                                <label className="text-xs text-hui-textMuted block mb-1">Zip</label>
                                <input type="text" value={cZip} onChange={e => setCZip(e.target.value)} className="hui-input w-full text-sm" placeholder="12345" />
                            </div>
                        </div>
                    </div>
                ) : (
                    <div className="space-y-3 text-sm">
                        <div className="flex justify-between"><span className="text-hui-textMuted">Name</span><span className="text-hui-textMain font-medium">{clientName}</span></div>
                        <div className="flex justify-between"><span className="text-hui-textMuted">Email</span><span className="text-hui-textMain">{clientEmail || <span className="text-slate-400 italic">Not set</span>}</span></div>
                        <div className="flex justify-between"><span className="text-hui-textMuted">Phone</span><span className="text-hui-textMain">{clientPhone || <span className="text-slate-400 italic">Not set</span>}</span></div>
                        <div className="flex justify-between"><span className="text-hui-textMuted">Address</span><span className="text-hui-textMain text-right max-w-[60%]">{formatAddress() || <span className="text-slate-400 italic">Not set</span>}</span></div>
                    </div>
                )}
            </div>

            {/* ── Lead Details Card ── */}
            <div className="hui-card p-6">
                <h3 className="font-semibold text-hui-textMain text-sm mb-4 flex justify-between items-center">
                    Lead Details
                    {!editingLead ? (
                        <button onClick={() => setEditingLead(true)} className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium text-hui-textMain bg-white border border-hui-border rounded-md hover:bg-slate-50 transition shadow-sm">
                            Edit
                        </button>
                    ) : (
                        <div className="flex gap-2">
                            <button onClick={() => setEditingLead(false)} className="px-3 py-1 text-xs font-medium text-slate-500 border border-slate-200 rounded-md hover:bg-slate-50 transition">Cancel</button>
                            <button onClick={handleSaveLead} disabled={savingLead} className="px-3 py-1 text-xs font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 transition disabled:opacity-50">
                                {savingLead ? "Saving..." : "Save"}
                            </button>
                        </div>
                    )}
                </h3>

                {editingLead ? (
                    <div className="space-y-3">
                        <div>
                            <label className="text-xs text-hui-textMuted block mb-1">Lead Name</label>
                            <input type="text" value={lName} onChange={e => setLName(e.target.value)} className="hui-input w-full text-sm" />
                        </div>
                        <div>
                            <label className="text-xs text-hui-textMuted block mb-1">Lead Source</label>
                            <select value={lSource} onChange={e => setLSource(e.target.value)} className="hui-input w-full text-sm">
                                <option value="">Select source...</option>
                                <option value="Houzz">Houzz</option>
                                <option value="My website">My website</option>
                                <option value="Referral">Referral</option>
                                <option value="Google">Google</option>
                                <option value="Social Media">Social Media</option>
                                <option value="Other">Other</option>
                            </select>
                        </div>
                        <div>
                            <label className="text-xs text-hui-textMuted block mb-1">Project Type</label>
                            <input type="text" value={lType} onChange={e => setLType(e.target.value)} className="hui-input w-full text-sm" placeholder="e.g. Kitchen Remodel" />
                        </div>
                        <div>
                            <label className="text-xs text-hui-textMuted block mb-1">Location</label>
                            <input type="text" value={lLocation} onChange={e => setLLocation(e.target.value)} className="hui-input w-full text-sm" placeholder="City, State" />
                        </div>
                        <div>
                            <label className="text-xs text-hui-textMuted block mb-1">Expected Start Date</label>
                            <input type="date" value={lStartDate} onChange={e => setLStartDate(e.target.value)} className="hui-input w-full text-sm" />
                        </div>
                        <div>
                            <label className="text-xs text-hui-textMuted block mb-1">Target Revenue</label>
                            <div className="relative">
                                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm">$</span>
                                <input type="number" value={lRevenue} onChange={e => setLRevenue(e.target.value)} className="hui-input w-full text-sm pl-7" placeholder="0.00" step="0.01" />
                            </div>
                        </div>
                    </div>
                ) : (
                    <div className="space-y-3 text-sm">
                        <div className="flex justify-between"><span className="text-hui-textMuted">Lead Name</span><span className="text-hui-textMain font-medium">{leadName}</span></div>
                        <div className="flex justify-between"><span className="text-hui-textMuted">Lead Source</span><span className="text-hui-textMain">{leadSource || <span className="text-slate-400 italic">Not set</span>}</span></div>
                        <div className="flex justify-between"><span className="text-hui-textMuted">Project Type</span><span className="text-hui-textMain">{projectType || <span className="text-slate-400 italic">Not set</span>}</span></div>
                        <div className="flex justify-between"><span className="text-hui-textMuted">Location</span><span className="text-hui-textMain">{location || <span className="text-slate-400 italic">Not set</span>}</span></div>
                        <div className="flex justify-between">
                            <span className="text-hui-textMuted">Expected Start Date</span>
                            <span className="text-hui-textMain">{expectedStartDate ? new Date(expectedStartDate).toLocaleDateString() : <span className="text-slate-400 italic">Not set</span>}</span>
                        </div>
                        <div className="flex justify-between">
                            <span className="text-hui-textMuted">Target Revenue</span>
                            <span className="text-hui-textMain">{targetRevenue ? formatCurrency(targetRevenue) : <span className="text-slate-400 italic">Not set</span>}</span>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
