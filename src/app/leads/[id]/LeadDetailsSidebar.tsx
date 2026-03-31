"use client";

import { useState } from "react";
import { updateClient, updateLead } from "@/lib/actions";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import LeadStageDropdown from "./LeadStageDropdown";
import EditLeadModal from "./EditLeadModal";
import GoogleMapPreview from "@/components/GoogleMapPreview";
import GoogleMapsAutocomplete from "@/components/GoogleMapsAutocomplete";

interface LeadDetailsSidebarProps {
    leadId: string;
    leadName: string;
    leadSource: string | null;
    leadStage: string;
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
    initialMessage: string | null;
}

export default function LeadDetailsSidebar({
    leadId, leadName, leadSource, leadStage, expectedStartDate, targetRevenue, location, projectType,
    clientId, clientName, clientEmail, clientPhone, clientAddress, clientCity, clientState, clientZip,
    initialMessage,
}: LeadDetailsSidebarProps) {
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
    const [showLeadDetails, setShowLeadDetails] = useState(true);
    const [showAdditional, setShowAdditional] = useState(true);
    const [lName, setLName] = useState(leadName);
    const [lSource, setLSource] = useState(leadSource || "");
    const [lStartDate, setLStartDate] = useState(expectedStartDate || "");
    const [lRevenue, setLRevenue] = useState(targetRevenue?.toString() || "");
    const [lLocation, setLLocation] = useState(location || "");
    const [lType, setLType] = useState(projectType || "");
    const [savingLead, setSavingLead] = useState(false);

    // Inline field editing
    const [editingField, setEditingField] = useState<string | null>(null);
    const [fieldValue, setFieldValue] = useState("");

    // Modal state
    const [isEditModalOpen, setIsEditModalOpen] = useState(false);

    // Mock full object for the modal based on existing props (usually you'd just pass the full object)
    const mockLead = {
        id: leadId,
        name: leadName,
        source: leadSource,
        stage: leadStage,
        expectedStartDate,
        targetRevenue,
        location,
        projectType,
        message: initialMessage,
    };
    const mockClient = {
        name: clientName,
        email: clientEmail,
        primaryPhone: clientPhone,
        addressLine1: clientAddress,
        city: clientCity,
        state: clientState,
    };

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

    const handleSaveField = async (field: string, value: string) => {
        try {
            const updateData: any = {};
            if (field === "targetRevenue") {
                updateData[field] = value ? parseFloat(value) : null;
            } else if (field === "expectedStartDate") {
                updateData[field] = value || null;
            } else {
                updateData[field] = value || undefined;
            }
            await updateLead(leadId, updateData);
            toast.success("Updated");
            setEditingField(null);
            router.refresh();
        } catch (e: any) { toast.error(e.message || "Failed to save"); }
    };

    const formatAddress = () => {
        const parts = [clientAddress, clientCity, clientState, clientZip].filter(Boolean);
        return parts.length > 0 ? parts.join(", ") : null;
    };

    const maskEmail = (email: string) => {
        const [user, domain] = email.split("@");
        if (!domain) return email;
        return `${user[0]}${"*".repeat(Math.min(user.length - 1, 5))}@${domain}`;
    };

    const DetailRow = ({ label, value, fieldKey, type = "text" }: { label: string; value: string | null; fieldKey?: string; type?: string }) => {
        const isEditing = editingField === fieldKey;
        
        return (
            <div className="flex items-center justify-between py-2 border-b border-slate-50 group min-h-[36px]">
                <span className="text-sm text-slate-600 shrink-0">{label}</span>
                {isEditing && fieldKey ? (
                    <div className="flex items-center gap-1.5">
                        <input
                            type={type}
                            value={fieldValue}
                            onChange={e => setFieldValue(e.target.value)}
                            className="hui-input text-sm py-1 px-2 w-32"
                            step={type === "number" ? "0.01" : undefined}
                            autoFocus
                        />
                        <button
                            onClick={() => setEditingField(null)}
                            className="p-1 text-slate-400 hover:text-slate-600 transition"
                        >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                        </button>
                        <button
                            onClick={() => handleSaveField(fieldKey, fieldValue)}
                            className="p-1 bg-green-600 text-white rounded transition hover:bg-green-700"
                        >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20,6 9,17 4,12"/></svg>
                        </button>
                    </div>
                ) : (
                    <span className="text-sm text-right">
                        {value ? (
                            <span className="text-hui-textMain font-medium">{value}</span>
                        ) : fieldKey ? (
                            <button
                                onClick={() => {
                                    setEditingField(fieldKey);
                                    setFieldValue("");
                                }}
                                className="text-green-600 hover:text-green-700 font-medium hover:underline transition"
                            >
                                Add
                            </button>
                        ) : (
                            <span className="text-slate-400 italic">Not set</span>
                        )}
                    </span>
                )}
            </div>
        );
    };

    return (
        <div className="w-[320px] flex-shrink-0 border-l border-hui-border bg-white overflow-y-auto">
            {/* Client Details */}
            <div className="p-5 border-b border-hui-border">
                <div className="flex items-center justify-between mb-4">
                    <h3 className="text-sm font-bold text-hui-textMain">Client Details</h3>
                    {!editingClient ? (
                        <button onClick={() => setEditingClient(true)} className="text-xs text-green-600 hover:text-green-700 font-semibold hover:underline transition">
                            Edit
                        </button>
                    ) : (
                        <div className="flex gap-2">
                            <button onClick={() => setEditingClient(false)} className="text-xs text-slate-500 hover:text-slate-700 transition font-medium">Cancel</button>
                            <button onClick={handleSaveClient} disabled={savingClient} className="text-xs text-white bg-green-600 hover:bg-green-700 px-2.5 py-1 rounded transition font-medium disabled:opacity-50">
                                {savingClient ? "..." : "Save"}
                            </button>
                        </div>
                    )}
                </div>

                {editingClient ? (
                    <div className="space-y-3">
                        <div>
                            <label className="text-xs text-slate-500 block mb-1">Name</label>
                            <input type="text" value={cName} onChange={e => setCName(e.target.value)} className="hui-input w-full text-sm" />
                        </div>
                        <div>
                            <label className="text-xs text-slate-500 block mb-1">Email</label>
                            <input type="email" value={cEmail} onChange={e => setCEmail(e.target.value)} className="hui-input w-full text-sm" />
                        </div>
                        <div>
                            <label className="text-xs text-slate-500 block mb-1">Phone</label>
                            <input type="tel" value={cPhone} onChange={e => setCPhone(e.target.value)} className="hui-input w-full text-sm" />
                        </div>
                        <div>
                            <label className="text-xs text-slate-500 block mb-1">Address</label>
                            <GoogleMapsAutocomplete 
                                value={cAddr} 
                                onChange={setCAddr} 
                                onPlaceDetails={(details) => {
                                    if (details.address) setCAddr(details.address);
                                    if (details.city) setCCity(details.city);
                                    if (details.state) setCState(details.state);
                                    if (details.zip) setCZip(details.zip);
                                }}
                                className="hui-input w-full text-sm" 
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
                    </div>
                ) : (
                    <div className="space-y-0">
                        <div className="flex items-center justify-between py-2 border-b border-slate-50">
                            <span className="text-sm text-slate-600">Name</span>
                            <span className="text-sm text-hui-textMain font-medium">{clientName}</span>
                        </div>
                        <div className="flex items-center justify-between py-2 border-b border-slate-50">
                            <span className="text-sm text-slate-600">Email</span>
                            <span className="text-sm text-green-600">{clientEmail ? maskEmail(clientEmail) : <span className="text-slate-400 italic">Not set</span>}</span>
                        </div>
                        <div className="flex items-center justify-between py-2 border-b border-slate-50">
                            <span className="text-sm text-slate-600">Phone Number</span>
                            <span className="text-sm text-hui-textMain flex items-center gap-1.5">
                                {clientPhone ? (
                                    <>
                                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z"/></svg>
                                        {clientPhone}
                                    </>
                                ) : <span className="text-slate-400 italic">Not set</span>}
                            </span>
                        </div>
                        <div className="flex flex-col py-2">
                            <div className="flex items-center justify-between mb-2">
                                <span className="text-sm text-slate-600">Client Address</span>
                                <span className="text-sm text-hui-textMain flex items-center justify-end gap-1.5 text-right w-2/3">
                                    {formatAddress() ? (
                                        <>
                                            <a href={`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(formatAddress()!)}`} target="_blank" rel="noreferrer" className="text-slate-400 hover:text-green-600 transition" title="Directions">
                                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                                            </a>
                                            <span className="truncate">{formatAddress()}</span>
                                        </>
                                    ) : <span className="text-slate-400 italic">Not set</span>}
                                </span>
                            </div>
                            {formatAddress() && (
                                <div className="mt-1 w-[280px]">
                                    <GoogleMapPreview address={formatAddress()!} />
                                </div>
                            )}
                        </div>
                    </div>
                )}
            </div>

            {/* Lead Details - Collapsible */}
            <div className="border-b border-hui-border">
                <div className="w-full px-5 py-4 flex items-center justify-between hover:bg-slate-50 transition">
                    <button
                        onClick={() => setShowLeadDetails(!showLeadDetails)}
                        className="flex items-center gap-2 text-sm font-bold text-hui-textMain"
                    >
                        Lead Details
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={`transition-transform ${showLeadDetails ? "" : "-rotate-90"}`}>
                            <path d="M6 9l6 6 6-6"/>
                        </svg>
                    </button>
                    <button onClick={() => setIsEditModalOpen(true)} className="text-xs text-slate-500 hover:text-slate-700 font-semibold transition flex items-center gap-1 group">
                        Edit
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="group-hover:translate-y-px transition"><path d="M6 9l6 6 6-6"/></svg>
                    </button>
                </div>

                {showLeadDetails && (
                    <div className="px-5 pb-4 space-y-0">
                        {/* Team avatars */}
                        <div className="flex items-center justify-between py-2 border-b border-slate-50">
                            <span className="text-sm text-slate-600">Team</span>
                            <div className="flex -space-x-2">
                                {["G", "WB", "R", "SB", "VB"].map((initials, i) => (
                                    <div key={i} className={`w-7 h-7 rounded-full border-2 border-white flex items-center justify-center text-[9px] font-bold text-white ${
                                        ["bg-amber-500", "bg-slate-600", "bg-red-500", "bg-blue-500", "bg-purple-500"][i]
                                    }`}>
                                        {initials}
                                    </div>
                                ))}
                            </div>
                        </div>

                        {/* Managers */}
                        <div className="flex items-center justify-between py-2 border-b border-slate-50">
                            <span className="text-sm text-slate-600">Managers</span>
                            <div className="flex items-center gap-1.5">
                                <div className="w-6 h-6 rounded-full bg-slate-200 flex items-center justify-center">
                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="2"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                                </div>
                                <span className="text-sm text-green-600 font-medium">Assign</span>
                            </div>
                        </div>

                        {/* Lead Stage */}
                        <div className="flex items-center justify-between py-2 border-b border-slate-50">
                            <span className="text-sm text-slate-600">Lead Stage</span>
                            <LeadStageDropdown leadId={leadId} currentStage={leadStage} variant="pill" />
                        </div>

                        <DetailRow label="Lead Source" value={leadSource} fieldKey="source" />
                        <DetailRow label="Tags" value={null} fieldKey="tags" />
                        <DetailRow label="Expected Start Date" value={expectedStartDate ? new Date(expectedStartDate).toLocaleDateString() : null} fieldKey="expectedStartDate" type="date" />
                        <DetailRow label="Estimated Revenue" value={targetRevenue ? `$${targetRevenue.toLocaleString()}` : null} fieldKey="targetRevenue" type="number" />
                        <DetailRow label="Estimated Profit" value={null} fieldKey="estimatedProfit" />
                        <DetailRow label="Estimated Budget" value={null} fieldKey="estimatedBudget" />
                        <DetailRow label="Project Type" value={projectType} fieldKey="projectType" />
                        <DetailRow label="Description" value={null} fieldKey="description" />
                    </div>
                )}
            </div>

            {/* Additional Details */}
            <div>
                <button
                    onClick={() => setShowAdditional(!showAdditional)}
                    className="w-full px-5 py-4 flex items-center justify-between text-sm font-bold text-hui-textMain hover:bg-slate-50 transition"
                >
                    Additional Details from {leadSource || "Source"}
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={`transition-transform ${showAdditional ? "" : "-rotate-90"}`}>
                        <path d="M6 9l6 6 6-6"/>
                    </svg>
                </button>

                {showAdditional && (
                    <div className="px-5 pb-5 space-y-3 text-sm">
                        <div>
                            <p className="text-slate-500 text-xs font-medium mb-0.5">Contact Name</p>
                            <p className="text-green-600 font-medium">{clientName}</p>
                        </div>
                        <div>
                            <p className="text-slate-500 text-xs font-medium mb-0.5">Project Location</p>
                            <p className="text-hui-textMain mb-2">{location || "Not specified"}</p>
                            {location && <GoogleMapPreview address={location} />}
                        </div>
                        <div>
                            <p className="text-slate-500 text-xs font-medium mb-0.5">Message</p>
                            {initialMessage ? (
                                <p className="text-slate-600 leading-relaxed text-xs whitespace-pre-wrap">{initialMessage}</p>
                            ) : (
                                <p className="text-slate-400 italic text-xs">No initial message</p>
                            )}
                        </div>
                    </div>
                )}
            </div>
            {/* Modal Injection */}
            <EditLeadModal 
                isOpen={isEditModalOpen} 
                onClose={() => setIsEditModalOpen(false)} 
                lead={mockLead} 
                client={mockClient} 
            />
        </div>
    );
}
