"use client";

import { useState } from "react";
import { createContractFromTemplate, sendContractToClient, deleteContract } from "@/lib/actions";
import { toast } from "sonner";

interface Template { id: string; name: string; type: string; }
interface Contract { id: string; title: string; status: string; createdAt: string; sentAt?: string; approvedBy?: string; }

export default function LeadContractsSection({ leadId, contracts: initialContracts, templates }: {
    leadId: string;
    contracts: Contract[];
    templates: Template[];
}) {
    const [showModal, setShowModal] = useState(false);
    const [selectedTemplate, setSelectedTemplate] = useState("");
    const [isCreating, setIsCreating] = useState(false);

    const contractTemplates = templates.filter(t => t.type === "contract");

    const handleCreate = async () => {
        if (!selectedTemplate) return;
        setIsCreating(true);
        try {
            await createContractFromTemplate(selectedTemplate, { type: "lead", id: leadId });
            toast.success("Contract created from template!");
            setShowModal(false);
            setSelectedTemplate("");
        } catch (e: any) {
            toast.error(e.message || "Failed to create contract");
        } finally {
            setIsCreating(false);
        }
    };

    const handleSend = async (contractId: string) => {
        try {
            const result = await sendContractToClient(contractId);
            toast.success(`Contract sent to ${result.sentTo}`);
        } catch (e: any) {
            toast.error(e.message || "Failed to send contract");
        }
    };

    const handleDelete = async (contractId: string) => {
        if (!confirm("Are you sure you want to delete this contract?")) return;
        try {
            await deleteContract(contractId);
            toast.success("Contract deleted");
        } catch {
            toast.error("Failed to delete contract");
        }
    };

    const statusColors: Record<string, string> = {
        Draft: "bg-gray-100 text-gray-700",
        Sent: "bg-blue-100 text-blue-700",
        Viewed: "bg-yellow-100 text-yellow-700",
        Signed: "bg-green-100 text-green-700",
        Declined: "bg-red-100 text-red-700",
    };

    return (
        <div className="hui-card p-6 shadow-sm">
            <div className="flex justify-between items-center mb-6">
                <h3 className="font-semibold text-hui-textMain text-lg">Contracts</h3>
                <button onClick={() => setShowModal(true)} className="hui-btn hui-btn-primary text-sm shadow-sm hover:shadow transition">
                    + Create Contract
                </button>
            </div>

            {initialContracts.length === 0 ? (
                <div className="text-center py-8 border border-dashed border-hui-border rounded-lg bg-slate-50">
                    <svg className="w-10 h-10 text-slate-300 mx-auto mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
                    <p className="text-sm text-hui-textMuted">No contracts created yet.</p>
                    <p className="text-xs text-hui-textMuted mt-1">Create a contract from a template to get started.</p>
                </div>
            ) : (
                <div className="divide-y divide-hui-border border border-hui-border rounded-lg bg-white overflow-hidden shadow-sm">
                    {initialContracts.map((c: any) => (
                        <div key={c.id} className="p-4 flex items-center justify-between hover:bg-slate-50 transition group">
                            <div>
                                <h4 className="font-medium text-sm text-hui-textMain mb-1">{c.title}</h4>
                                <div className="flex items-center gap-2 text-xs text-hui-textMuted">
                                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${statusColors[c.status] || "bg-gray-100 text-gray-700"}`}>
                                        {c.status}
                                    </span>
                                    <span>•</span>
                                    <span>{new Date(c.createdAt).toLocaleDateString()}</span>
                                    {c.approvedBy && (
                                        <>
                                            <span>•</span>
                                            <span className="text-green-600 font-medium">Signed by {c.approvedBy}</span>
                                        </>
                                    )}
                                </div>
                            </div>
                            <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition">
                                {c.status === "Draft" && (
                                    <button onClick={() => handleSend(c.id)} className="inline-flex items-center gap-1 px-3 py-1 text-xs font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 transition shadow-sm">
                                        Send
                                    </button>
                                )}
                                <button onClick={() => handleDelete(c.id)} className="text-hui-textMuted hover:text-red-600 text-sm font-medium transition px-2 py-1">
                                    Delete
                                </button>
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {/* Create Contract Modal */}
            {showModal && (
                <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
                    <div className="bg-white rounded-xl shadow-2xl max-w-md w-full p-6">
                        <h3 className="text-lg font-bold text-hui-textMain mb-1">Create Contract</h3>
                        <p className="text-sm text-hui-textMuted mb-5">Choose a template — merge fields like &#123;&#123;client_name&#125;&#125; will be auto-filled.</p>

                        <div className="space-y-4">
                            <div>
                                <label className="block text-sm font-medium text-hui-textMain mb-1">Template</label>
                                <select
                                    value={selectedTemplate}
                                    onChange={e => setSelectedTemplate(e.target.value)}
                                    className="hui-input w-full"
                                >
                                    <option value="">Select a template...</option>
                                    {contractTemplates.map(t => (
                                        <option key={t.id} value={t.id}>{t.name}</option>
                                    ))}
                                </select>
                            </div>

                            {contractTemplates.length === 0 && (
                                <div className="text-center p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
                                    <p className="text-sm text-yellow-800">No contract templates found.</p>
                                    <p className="text-xs text-yellow-600 mt-1">Go to Company → Templates to create one first.</p>
                                </div>
                            )}

                            <div className="flex gap-3 justify-end pt-2">
                                <button onClick={() => setShowModal(false)} className="hui-btn hui-btn-secondary px-4 py-2">Cancel</button>
                                <button
                                    onClick={handleCreate}
                                    disabled={!selectedTemplate || isCreating}
                                    className="hui-btn hui-btn-primary px-4 py-2"
                                >
                                    {isCreating ? "Creating..." : "Create Contract"}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
