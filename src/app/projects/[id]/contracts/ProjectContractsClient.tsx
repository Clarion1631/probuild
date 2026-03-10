"use client";

import { useState } from "react";
import { createContractFromTemplate, sendContractToClient, deleteContract, getContractSigningHistory } from "@/lib/actions";
import { toast } from "sonner";

interface Template { id: string; name: string; type: string; }
interface SigningRecord {
    id: string; signedBy: string; signedAt: string;
    periodStart?: string | null; periodEnd?: string | null;
    signatureUrl?: string | null;
}

export default function ProjectContractsClient({ projectId, projectName, clientName, contracts: initialContracts, templates }: {
    projectId: string;
    projectName: string;
    clientName: string;
    contracts: any[];
    templates: Template[];
}) {
    const [showModal, setShowModal] = useState(false);
    const [selectedTemplate, setSelectedTemplate] = useState("");
    const [isCreating, setIsCreating] = useState(false);
    const [isRecurring, setIsRecurring] = useState(false);
    const [recurringDays, setRecurringDays] = useState(30);
    const [historyModal, setHistoryModal] = useState<string | null>(null);
    const [signingHistory, setSigningHistory] = useState<SigningRecord[]>([]);
    const [loadingHistory, setLoadingHistory] = useState(false);

    const contractTemplates = templates.filter(t => t.type === "contract" || t.type === "lien_release");

    const handleCreate = async () => {
        if (!selectedTemplate) return;
        setIsCreating(true);
        try {
            await createContractFromTemplate(
                selectedTemplate,
                { type: "project", id: projectId },
                undefined,
                isRecurring ? recurringDays : undefined
            );
            toast.success("Contract created!");
            setShowModal(false);
            setSelectedTemplate("");
            setIsRecurring(false);
            window.location.reload();
        } catch (e: any) {
            toast.error(e.message || "Failed to create contract");
        } finally { setIsCreating(false); }
    };

    const handleSend = async (contractId: string) => {
        try {
            const result = await sendContractToClient(contractId);
            toast.success(`Sent to ${result.sentTo}`);
            window.location.reload();
        } catch (e: any) { toast.error(e.message || "Failed to send"); }
    };

    const handleDelete = async (contractId: string) => {
        if (!confirm("Delete this contract?")) return;
        try {
            await deleteContract(contractId);
            toast.success("Deleted");
            window.location.reload();
        } catch { toast.error("Failed to delete"); }
    };

    const handleViewHistory = async (contractId: string) => {
        setHistoryModal(contractId);
        setLoadingHistory(true);
        try {
            const records = await getContractSigningHistory(contractId) as SigningRecord[];
            setSigningHistory(records);
        } catch { toast.error("Failed to load history"); }
        finally { setLoadingHistory(false); }
    };

    const handleTemplateChange = (templateId: string) => {
        setSelectedTemplate(templateId);
        const t = templates.find(t => t.id === templateId);
        if (t?.type === "lien_release") { setIsRecurring(true); setRecurringDays(30); }
    };

    const statusColors: Record<string, string> = {
        Draft: "bg-gray-100 text-gray-700 border-gray-200",
        Sent: "bg-blue-100 text-blue-700 border-blue-200",
        Viewed: "bg-yellow-100 text-yellow-700 border-yellow-200",
        Signed: "bg-green-100 text-green-700 border-green-200",
        Declined: "bg-red-100 text-red-700 border-red-200",
    };

    return (
        <div>
            {/* Header */}
            <div className="flex items-center justify-between mb-6">
                <div>
                    <h1 className="text-xl font-bold text-hui-textMain">Contracts & Lien Releases</h1>
                    <p className="text-sm text-hui-textMuted">{projectName} · {clientName}</p>
                </div>
                <button onClick={() => setShowModal(true)} className="hui-btn hui-btn-primary">+ Create</button>
            </div>

            {/* Contract List */}
            {initialContracts.length === 0 ? (
                <div className="text-center py-16 bg-white border border-slate-200 rounded-xl">
                    <svg className="w-12 h-12 text-slate-300 mx-auto mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
                    <p className="text-slate-500 font-medium">No contracts yet</p>
                    <p className="text-xs text-slate-400 mt-1 mb-4">Create a contract or lien release from a template.</p>
                    <button onClick={() => setShowModal(true)} className="hui-btn hui-btn-primary text-sm">+ Create Contract</button>
                </div>
            ) : (
                <div className="space-y-3">
                    {initialContracts.map((c: any) => (
                        <div key={c.id} className="bg-white rounded-xl border border-slate-200 shadow-sm p-5 hover:shadow-md transition group">
                            <div className="flex items-start justify-between">
                                <div className="min-w-0">
                                    <div className="flex items-center gap-2 mb-1.5">
                                        <h3 className="font-semibold text-hui-textMain truncate">{c.title}</h3>
                                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold border ${statusColors[c.status] || statusColors.Draft}`}>
                                            {c.status}
                                        </span>
                                        {c.recurringDays && (
                                            <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-indigo-50 text-indigo-600 border border-indigo-200">
                                                🔄 Every {c.recurringDays}d
                                            </span>
                                        )}
                                    </div>
                                    <div className="flex items-center gap-3 text-xs text-slate-500">
                                        <span>Created {new Date(c.createdAt).toLocaleDateString()}</span>
                                        {c.sentAt && <span>· Sent {new Date(c.sentAt).toLocaleDateString()}</span>}
                                        {c.approvedBy && <span className="text-green-600 font-medium">· Signed by {c.approvedBy}</span>}
                                        {c.nextDueDate && <span className="text-indigo-600">· Next due {new Date(c.nextDueDate).toLocaleDateString()}</span>}
                                    </div>
                                    {c.signingRecords?.length > 0 && (
                                        <p className="text-[10px] text-slate-400 mt-1">{c.signingRecords.length} signing record{c.signingRecords.length !== 1 ? "s" : ""}</p>
                                    )}
                                </div>
                                <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition shrink-0">
                                    {c.recurringDays && (
                                        <button onClick={() => handleViewHistory(c.id)} className="px-3 py-1.5 text-xs font-medium text-indigo-700 bg-indigo-50 rounded-lg hover:bg-indigo-100 transition border border-indigo-200">
                                            📋 History
                                        </button>
                                    )}
                                    {c.status === "Draft" && (
                                        <button onClick={() => handleSend(c.id)} className="px-3 py-1.5 text-xs font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition shadow-sm">
                                            Send
                                        </button>
                                    )}
                                    <button onClick={() => handleDelete(c.id)} className="px-3 py-1.5 text-xs font-medium text-slate-500 hover:text-red-600 transition">
                                        Delete
                                    </button>
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {/* Create Modal */}
            {showModal && (
                <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
                    <div className="bg-white rounded-xl shadow-2xl max-w-md w-full p-6">
                        <h3 className="text-lg font-bold text-hui-textMain mb-1">Create Contract / Lien Release</h3>
                        <p className="text-sm text-hui-textMuted mb-5">Merge fields will auto-fill from project data.</p>
                        <div className="space-y-4">
                            <div>
                                <label className="block text-sm font-medium text-hui-textMain mb-1">Template</label>
                                <select value={selectedTemplate} onChange={e => handleTemplateChange(e.target.value)} className="hui-input w-full">
                                    <option value="">Select a template...</option>
                                    <optgroup label="Contracts">
                                        {contractTemplates.filter(t => t.type === "contract").map(t => (
                                            <option key={t.id} value={t.id}>{t.name}</option>
                                        ))}
                                    </optgroup>
                                    <optgroup label="Lien Releases">
                                        {contractTemplates.filter(t => t.type === "lien_release").map(t => (
                                            <option key={t.id} value={t.id}>{t.name}</option>
                                        ))}
                                    </optgroup>
                                </select>
                            </div>

                            <div className="bg-slate-50 border border-slate-200 rounded-lg p-4">
                                <label className="flex items-center gap-3 cursor-pointer">
                                    <input type="checkbox" checked={isRecurring} onChange={e => setIsRecurring(e.target.checked)} className="w-4 h-4 text-indigo-600 border-slate-300 rounded" />
                                    <div>
                                        <span className="text-sm font-medium text-slate-800">Recurring signing</span>
                                        <p className="text-xs text-slate-500 mt-0.5">Client signs again at the interval below</p>
                                    </div>
                                </label>
                                {isRecurring && (
                                    <div className="mt-3 flex items-center gap-2 pl-7">
                                        <span className="text-sm text-slate-600">Every</span>
                                        <input type="number" min={1} value={recurringDays} onChange={e => setRecurringDays(parseInt(e.target.value) || 30)} className="hui-input w-20 text-center text-sm py-1" />
                                        <span className="text-sm text-slate-600">days</span>
                                    </div>
                                )}
                            </div>

                            <div className="flex gap-3 justify-end pt-2">
                                <button onClick={() => { setShowModal(false); setIsRecurring(false); }} className="hui-btn hui-btn-secondary px-4 py-2">Cancel</button>
                                <button onClick={handleCreate} disabled={!selectedTemplate || isCreating} className="hui-btn hui-btn-primary px-4 py-2">
                                    {isCreating ? "Creating..." : "Create"}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* History Modal */}
            {historyModal && (
                <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
                    <div className="bg-white rounded-xl shadow-2xl max-w-lg w-full p-6 max-h-[80vh] overflow-hidden flex flex-col">
                        <div className="flex items-center justify-between mb-4">
                            <h3 className="text-lg font-bold text-hui-textMain">Signing History</h3>
                            <button onClick={() => setHistoryModal(null)} className="text-slate-400 hover:text-slate-600 text-xl">&times;</button>
                        </div>
                        <div className="flex-1 overflow-y-auto">
                            {loadingHistory ? (
                                <div className="text-center py-8 text-slate-500">
                                    <div className="w-6 h-6 border-2 border-slate-300 border-t-indigo-500 rounded-full animate-spin mx-auto mb-2"></div>
                                    Loading...
                                </div>
                            ) : signingHistory.length === 0 ? (
                                <div className="text-center py-8 text-slate-500 text-sm">No signing records yet.</div>
                            ) : (
                                <div className="space-y-3">
                                    {signingHistory.map((r, idx) => (
                                        <div key={r.id} className="bg-slate-50 rounded-lg p-4 border border-slate-100">
                                            <div className="flex items-start justify-between">
                                                <div>
                                                    <div className="flex items-center gap-2 mb-1">
                                                        <span className="w-5 h-5 bg-green-100 text-green-700 rounded-full flex items-center justify-center text-[10px] font-bold">
                                                            {signingHistory.length - idx}
                                                        </span>
                                                        <span className="font-semibold text-sm text-slate-800">{r.signedBy}</span>
                                                    </div>
                                                    <p className="text-xs text-slate-500 pl-7">{new Date(r.signedAt).toLocaleString()}</p>
                                                    {r.periodStart && r.periodEnd && (
                                                        <p className="text-xs text-slate-400 pl-7 mt-0.5">
                                                            Period: {new Date(r.periodStart).toLocaleDateString()} – {new Date(r.periodEnd).toLocaleDateString()}
                                                        </p>
                                                    )}
                                                </div>
                                                {r.signatureUrl && <img src={r.signatureUrl} alt="Signature" className="h-8 object-contain opacity-60" />}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
