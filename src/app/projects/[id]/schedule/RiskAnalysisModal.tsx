"use client";

type RiskAnalysisModalProps = {
    analysis: string;
    onClose: () => void;
};

export default function RiskAnalysisModal({ analysis, onClose }: RiskAnalysisModalProps) {
    return (
        <div className="fixed inset-0 z-[200] flex items-center justify-center">
            <div className="fixed inset-0 bg-black/40" onClick={onClose} />
            <div className="relative bg-white rounded-xl shadow-2xl max-w-2xl w-full mx-4 max-h-[80vh] flex flex-col">
                <div className="flex items-center justify-between p-5 border-b border-hui-border">
                    <div className="flex items-center gap-2">
                        <span className="text-xl">⚠️</span>
                        <h2 className="font-bold text-hui-textMain text-lg">Schedule Risk Analysis</h2>
                    </div>
                    <button onClick={onClose} className="text-hui-textMuted hover:text-hui-textMain">
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                    </button>
                </div>
                <div className="p-5 overflow-y-auto flex-1">
                    <div className="prose prose-sm max-w-none text-hui-textMain whitespace-pre-wrap text-sm leading-relaxed">
                        {analysis}
                    </div>
                </div>
                <div className="p-4 border-t border-hui-border">
                    <button onClick={onClose} className="hui-btn hui-btn-secondary text-sm">Close</button>
                </div>
            </div>
        </div>
    );
}
