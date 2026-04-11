"use client";

import { useState } from "react";
import { updateClient, updateLead } from "@/lib/actions";
import { toast } from "sonner";
import { formatCurrency } from "@/lib/utils";
import { useRouter } from "next/navigation";
import LeadStageDropdown from "./LeadStageDropdown";
import EditLeadModal from "./EditLeadModal";
import GoogleMapPreview from "@/components/GoogleMapPreview";
import GoogleMapsAutocomplete from "@/components/GoogleMapsAutocomplete";
import ManagerAssignRow from "@/components/ManagerAssignRow";

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
    managerId?: string | null;
    managerName?: string | null;
}

export default function LeadDetailsSidebar({
    leadId, leadName, leadSource, leadStage, expectedStartDate, targetRevenue, location, projectType,
    clientId, clientName, clientEmail, clientPhone, clientAddress, clientCity, clientState, clientZip,
    initialMessage, managerId, managerName,
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

    // AI Score state
    const [isScoringLead, setIsScoringLead] = useState(false);
    const [showScorePanel, setShowScorePanel] = useState(false);
    const [scoreAnalysis, setScoreAnalysis] = useState<string | null>(null);
    const [scoreProbability, setScoreProbability] = useState<number | null>(null);

    async function handleScoreLead() {
        setIsScoringLead(true);
        try {
            const res = await fetch("/api/ai/lead-score", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ leadId }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || "Scoring failed");
            setScoreAnalysis(data.analysis);
            setScoreProbability(data.probability);
            setShowScorePanel(true);
        } catch (e: any) {
            toast.error(e.message || "Lead scoring failed");
        } finally {
            setIsScoringLead(false);
        }
    }

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
        zipCode: clientZip,
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

    // Normalize a Google formatted_address to strip country suffix before comparing
    const normalizeAddress = (addr: string) =>
        addr.replace(/,\s*(USA|United States|US)$/i, "").trim();

    // True when job site and client contact address are the same (suppress duplicate map)
    const addressesMatch = !!formatAddress() && !!location &&
        normalizeAddress(location) === normalizeAddress(formatAddress()!);

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
                            <div className="flex items-start justify-between mb-2">
                                <span className="text-sm text-slate-600 shrink-0 mr-3">Client Contact Address</span>
                                <span className="text-sm text-hui-textMain flex items-start gap-1.5 min-w-0">
                                    {formatAddress() ? (
                                        <>
                                            <a href={`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(formatAddress()!)}`} target="_blank" rel="noreferrer" className="text-slate-400 hover:text-green-600 transition shrink-0 mt-0.5" title="Directions">
                                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                                            </a>
                                            <span className="break-words">{formatAddress()}</span>
                                        </>
                                    ) : <span className="text-slate-400 italic">Not set</span>}
                                </span>
                            </div>
                            {formatAddress() && !addressesMatch && (
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
                        {/* Manager */}
                        <ManagerAssignRow
                            entityType="lead"
                            entityId={leadId}
                            currentManagerId={managerId || null}
                            currentManagerName={managerName || null}
                        />

                        {/* Lead Stage */}
                        <div className="flex items-center justify-between py-2 border-b border-slate-50">
                            <span className="text-sm text-slate-600">Lead Stage</span>
                            <LeadStageDropdown leadId={leadId} currentStage={leadStage} variant="pill" />
                        </div>

                        <DetailRow label="Lead Source" value={leadSource} fieldKey="source" />
                        <DetailRow label="Tags" value={null} fieldKey="tags" />
                        <DetailRow label="Expected Start Date" value={expectedStartDate ? new Date(expectedStartDate).toLocaleDateString() : null} fieldKey="expectedStartDate" type="date" />
                        <DetailRow label="Estimated Revenue" value={targetRevenue ? formatCurrency(targetRevenue) : null} fieldKey="targetRevenue" type="number" />
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
                            <p className="text-slate-500 text-xs font-medium mb-0.5">Job Site</p>
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
            {/* AI Score Lead */}
            <div className="px-5 pb-5">
                <button
                    onClick={handleScoreLead}
                    disabled={isScoringLead}
                    className="w-full hui-btn bg-gradient-to-r from-purple-50 to-indigo-50 border-purple-200 text-purple-700 hover:from-purple-100 hover:to-indigo-100 text-sm flex items-center justify-center gap-2 disabled:opacity-50"
                >
                    {scoreProbability !== null && !isScoringLead ? (
                        <>✨ AI Score: {scoreProbability}% close</>
                    ) : (
                        <>✨ {isScoringLead ? "Analyzing…" : "AI Score Lead"}</>
                    )}
                </button>
            </div>

            {/* AI Score Panel */}
            {showScorePanel && scoreAnalysis && (
                <div className="fixed inset-0 z-[200] flex items-center justify-center">
                    <div className="fixed inset-0 bg-black/40" onClick={() => setShowScorePanel(false)} />
                    <div className="relative bg-white rounded-xl shadow-2xl max-w-lg w-full mx-4 max-h-[80vh] flex flex-col">
                        <div className="flex items-center justify-between p-5 border-b border-hui-border">
                            <div className="flex items-center gap-2">
                                <span className="text-xl">✨</span>
                                <h2 className="font-bold text-hui-textMain text-lg">Lead Score Analysis</h2>
                                {scoreProbability !== null && (
                                    <span className="text-sm font-bold px-2 py-0.5 rounded-full bg-purple-100 text-purple-700">{scoreProbability}% close</span>
                                )}
                            </div>
                            <button onClick={() => setShowScorePanel(false)} className="text-hui-textMuted hover:text-hui-textMain">
                                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                            </button>
                        </div>
                        <div className="p-5 overflow-y-auto flex-1">
                            <pre className="whitespace-pre-wrap text-sm text-hui-textMain font-sans leading-relaxed">{scoreAnalysis}</pre>
                        </div>
                        <div className="p-4 border-t border-hui-border flex gap-2">
                            <button onClick={() => setShowScorePanel(false)} className="hui-btn hui-btn-secondary text-sm">Close</button>
                            <button onClick={handleScoreLead} disabled={isScoringLead} className="hui-btn text-sm disabled:opacity-50">
                                {isScoringLead ? "Re-scoring…" : "Re-score"}
                            </button>
                        </div>
                    </div>
                </div>
            )}

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
