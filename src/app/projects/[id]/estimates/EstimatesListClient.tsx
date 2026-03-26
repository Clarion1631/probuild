"use client";

import { useState } from "react";

export default function EstimatesListClient({ 
    projectId, 
    templates, 
    handleNewEstimate, 
    handleNewFromTemplate 
}: { 
    projectId: string, 
    templates: any[], 
    handleNewEstimate: () => Promise<void>,
    handleNewFromTemplate: (formData: FormData) => Promise<void> 
}) {
    const [showDropdown, setShowDropdown] = useState(false);
    const [showTemplatePicker, setShowTemplatePicker] = useState(false);

    return (
        <div className="relative">
            <div className="flex items-center gap-2">
                <form action={handleNewEstimate}>
                    <button type="submit" className="hui-btn hui-btn-primary flex items-center gap-2">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14M5 12h14"/></svg>
                        New Estimate
                    </button>
                </form>
                {templates.length > 0 && (
                    <button 
                        onClick={() => setShowDropdown(!showDropdown)}
                        className="hui-btn hui-btn-secondary px-2.5"
                        title="Create from template"
                    >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 9l6 6 6-6"/></svg>
                    </button>
                )}
            </div>
            {showDropdown && (
                <>
                    <div className="fixed inset-0 z-40" onClick={() => setShowDropdown(false)} />
                    <div className="absolute right-0 top-full mt-1 w-64 bg-white rounded-lg shadow-xl border border-hui-border z-50 py-1 text-sm">
                        <div className="px-4 py-2 text-[10px] font-bold text-slate-400 uppercase tracking-wider">Create from Template</div>
                        {templates.map(t => (
                            <form key={t.id} action={handleNewFromTemplate}>
                                <input type="hidden" name="templateId" value={t.id} />
                                <button
                                    type="submit"
                                    onClick={() => setShowDropdown(false)}
                                    className="w-full text-left px-4 py-2.5 hover:bg-slate-50 flex items-center gap-2.5 text-hui-textMain"
                                >
                                    <svg className="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" /></svg>
                                    <div>
                                        <div className="font-medium">{t.name}</div>
                                        <div className="text-[10px] text-slate-400">{t.items?.length || 0} items</div>
                                    </div>
                                </button>
                            </form>
                        ))}
                    </div>
                </>
            )}
        </div>
    );
}
