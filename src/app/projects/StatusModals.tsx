"use client";

import { useState } from "react";
import { toast } from "sonner";
import { updateCompanyProjectStatuses } from "@/lib/actions";

export interface ProjectStatus {
    value: string;
    label: string;
    color: string;
    dot: string;
    rawColor: string;
    isActive: boolean;
}

interface CustomizeStatusModalProps {
    statuses: ProjectStatus[];
    onClose: () => void;
    onSave: (statuses: ProjectStatus[]) => void;
    onManageClick: () => void;
}

export function CustomizeStatusModal({ statuses, onClose, onSave, onManageClick }: CustomizeStatusModalProps) {
    const [localStatuses, setLocalStatuses] = useState<ProjectStatus[]>(statuses);

    const toggleStatus = (value: string) => {
        setLocalStatuses(prev => prev.map(s => s.value === value ? { ...s, isActive: !s.isActive } : s));
    };

    const handleSave = async () => {
        try {
            await updateCompanyProjectStatuses(JSON.stringify(localStatuses));
            onSave(localStatuses);
            onClose();
        } catch (error) {
            toast.error("Failed to save customized statuses");
        }
    };

    return (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[100] p-4 animate-in fade-in">
            <div className="bg-white rounded-xl shadow-2xl w-full max-w-sm overflow-hidden flex flex-col">
                <div className="flex items-center justify-between p-4 border-b border-slate-100">
                    <h2 className="text-xl font-bold text-slate-800">Customize</h2>
                    <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
                    </button>
                </div>
                
                <div className="p-4 border-b border-slate-100">
                    <p className="text-sm font-semibold text-slate-700 mb-4">Project Status</p>
                    <div className="space-y-4">
                        {localStatuses.map((status) => (
                            <div key={status.value} className="flex items-center justify-between">
                                <div className="flex items-center gap-3">
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#cbd5e1" strokeWidth="2" className="cursor-grab active:cursor-grabbing"><circle cx="9" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="19" r="1"/></svg>
                                    <span className="text-sm font-medium text-slate-700">{status.label}</span>
                                </div>
                                <button 
                                    onClick={() => toggleStatus(status.value)}
                                    className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${status.isActive ? 'bg-slate-800' : 'bg-slate-200'}`}
                                >
                                    <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${status.isActive ? 'translate-x-4' : 'translate-x-0'}`} />
                                </button>
                            </div>
                        ))}
                    </div>
                </div>

                <div className="p-3 bg-slate-50 flex items-center justify-center border-b border-slate-100">
                    <button 
                        onClick={() => {
                            onClose();
                            onManageClick();
                        }} 
                        className="text-sm font-bold text-slate-700 hover:text-indigo-600 transition"
                    >
                        Manage Status
                    </button>
                </div>
                <div className="p-4 flex gap-3">
                     <button onClick={onClose} className="flex-1 px-4 py-2 border border-slate-200 text-slate-600 rounded-lg hover:bg-slate-50 font-medium transition">Cancel</button>
                     <button onClick={handleSave} className="flex-1 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 font-medium transition">Save</button>
                </div>
            </div>
        </div>
    );
}

interface ManageStatusModalProps {
    statuses: ProjectStatus[];
    onClose: () => void;
    onSave: (statuses: ProjectStatus[]) => void;
}

export function ManageStatusModal({ statuses, onClose, onSave }: ManageStatusModalProps) {
    const [localStatuses, setLocalStatuses] = useState<ProjectStatus[]>(statuses);
    const [newStatusName, setNewStatusName] = useState("");
    const [isAdding, setIsAdding] = useState(false);
    const [editingValue, setEditingValue] = useState<string | null>(null);
    const [editLabel, setEditLabel] = useState("");

    const handleSave = async () => {
        try {
            await updateCompanyProjectStatuses(JSON.stringify(localStatuses));
            onSave(localStatuses);
            onClose();
        } catch (error) {
            toast.error("Failed to save managed statuses");
        }
    };

    const handleDelete = (value: string) => {
        setLocalStatuses(prev => prev.filter(s => s.value !== value));
    };

    const handleEditSave = (value: string) => {
        if (!editLabel.trim()) return;
        setLocalStatuses(prev => prev.map(s => 
            s.value === value ? { ...s, label: editLabel.trim(), value: editLabel.trim() } : s
        ));
        setEditingValue(null);
    };

    const handleAdd = () => {
        if (!newStatusName.trim()) return;
        const newStatus: ProjectStatus = {
            value: newStatusName,
            label: newStatusName,
            color: "bg-slate-100 text-slate-700",
            dot: "bg-slate-400",
            rawColor: "#94a3b8",
            isActive: true
        };
        setLocalStatuses(prev => [...prev, newStatus]);
        setNewStatusName("");
        setIsAdding(false);
    };

    return (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[100] p-4 animate-in fade-in">
            <div className="bg-white rounded-xl shadow-2xl w-full max-w-sm overflow-hidden flex flex-col">
                <div className="flex items-center justify-between p-4 border-b border-slate-100">
                    <h2 className="text-xl font-bold text-slate-800">Manage Project Status</h2>
                    <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
                    </button>
                </div>
                
                <div className="p-2 space-y-1">
                    {localStatuses.map((status) => (
                        <div key={status.value} className="group flex items-center justify-between p-2 rounded-lg hover:bg-slate-50 border-b border-slate-100 last:border-0 min-h-[44px]">
                            {editingValue === status.value ? (
                                <div className="flex items-center gap-2 w-full animate-in fade-in">
                                    <input 
                                        autoFocus
                                        type="text" 
                                        value={editLabel}
                                        onChange={e => setEditLabel(e.target.value)}
                                        className="hui-input flex-1 py-1 text-sm bg-white" 
                                        onKeyDown={e => {
                                            if (e.key === 'Enter') handleEditSave(status.value);
                                            if (e.key === 'Escape') setEditingValue(null);
                                        }}
                                    />
                                    <button onClick={() => handleEditSave(status.value)} className="text-sm font-semibold text-indigo-600 hover:text-indigo-800 shrink-0">Save</button>
                                </div>
                            ) : (
                                <>
                                    <div className="flex items-center gap-3 relative w-full">
                                        <div className={`w-3.5 h-3.5 shrink-0 rounded-full ring-2 ring-white shadow-sm ${status.dot}`} style={{ backgroundColor: status.rawColor }} />
                                        <span className="text-sm text-slate-700 truncate">{status.label}</span>
                                    </div>
                                    <div className="flex items-center justify-end gap-2 opacity-0 group-hover:opacity-100 transition-opacity pl-2">
                                        <button onClick={() => { setEditingValue(status.value); setEditLabel(status.label); }} className="text-slate-400 hover:text-indigo-600 p-1">
                                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>
                                        </button>
                                        <button onClick={() => handleDelete(status.value)} className="text-slate-400 hover:text-red-500 p-1">
                                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
                                        </button>
                                    </div>
                                </>
                            )}
                        </div>
                    ))}
                </div>

                <div className="p-4 border-t border-slate-100 mt-2 bg-slate-50">
                    {isAdding ? (
                        <div className="flex items-center gap-2">
                            <input 
                                autoFocus
                                type="text" 
                                value={newStatusName}
                                onChange={e => setNewStatusName(e.target.value)}
                                className="hui-input flex-1 py-1.5 text-sm" 
                                placeholder="Status name"
                                onKeyDown={e => e.key === 'Enter' && handleAdd()}
                            />
                            <button onClick={handleAdd} className="text-sm font-semibold text-indigo-600 hover:text-indigo-800">Add</button>
                            <button onClick={() => setIsAdding(false)} className="text-sm text-slate-500 hover:text-slate-700">Cancel</button>
                        </div>
                    ) : (
                        <button onClick={() => setIsAdding(true)} className="flex items-center gap-2 text-sm font-bold text-slate-800 hover:text-indigo-600 transition">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>
                            Add New Status
                        </button>
                    )}
                </div>

                <div className="p-4 flex gap-3 border-t border-slate-100">
                     <button onClick={onClose} className="flex-1 px-4 py-2 border border-slate-200 text-slate-600 rounded-lg hover:bg-slate-50 font-medium transition">Cancel</button>
                     <button onClick={handleSave} className="flex-1 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 font-medium transition">Save</button>
                </div>
            </div>
        </div>
    );
}
