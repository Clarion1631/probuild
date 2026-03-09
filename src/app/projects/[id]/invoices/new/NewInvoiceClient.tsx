"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { createInvoiceFromEstimate } from "@/lib/actions";
import StatusBadge from "@/components/StatusBadge";

export default function NewInvoiceClient({ project, estimates }: { project: any, estimates: any[] }) {
    const router = useRouter();
    const [isGenerating, setIsGenerating] = useState<string | null>(null);

    async function handleGenerate(estimateId: string) {
        setIsGenerating(estimateId);
        try {
            const res = await createInvoiceFromEstimate(estimateId);
            router.push(`/projects/${project.id}/invoices/${res.id}`);
        } catch (e) {
            console.error(e);
            setIsGenerating(null);
        }
    }

    return (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {estimates.length === 0 && (
                <div className="col-span-full hui-card p-12 text-center text-hui-textMuted">
                    <svg className="w-12 h-12 mx-auto mb-3 text-slate-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1"><path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                    <p className="text-base font-medium text-hui-textMain mb-1">No estimates found</p>
                    <p className="text-sm">Create an estimate first before generating an invoice.</p>
                </div>
            )}
            {estimates.map((est: any) => (
                <div key={est.id} className="hui-card p-6 flex flex-col h-full hover:shadow-md transition">
                    <div className="mb-4">
                        <div className="flex justify-between items-start mb-2">
                            <h3 className="font-semibold text-lg text-hui-textMain line-clamp-1" title={est.title}>{est.title}</h3>
                            <StatusBadge status={est.status} />
                        </div>
                        <p className="text-sm text-hui-textMuted mb-1">{est.code}</p>
                        <p className="font-medium text-hui-textMain">${(est.totalAmount || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
                    </div>
                    <div className="mt-auto pt-4 border-t border-hui-border">
                        <button 
                            onClick={() => handleGenerate(est.id)}
                            disabled={isGenerating !== null}
                            className="hui-btn hui-btn-primary w-full justify-center disabled:opacity-50"
                        >
                            {isGenerating === est.id ? "Generating..." : "Generate Invoice"}
                        </button>
                    </div>
                </div>
            ))}
        </div>
    );
}
