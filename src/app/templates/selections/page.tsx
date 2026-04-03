import Link from "next/link";

export default function SelectionTemplatesPage() {
    return (
        <div className="max-w-3xl mx-auto py-8 px-6 space-y-6">
            <div className="flex items-center gap-2 text-sm text-hui-textMuted mb-2">
                <Link href="/templates" className="hover:text-hui-textMain">Templates</Link>
                <span>/</span>
                <span>Selection Boards</span>
            </div>
            <div>
                <h1 className="text-2xl font-bold text-hui-textMain">Selection Board Templates</h1>
                <p className="text-sm text-hui-textMuted mt-1">Reusable selection boards for common project types.</p>
            </div>
            <div className="hui-card p-12 text-center">
                <div className="w-12 h-12 bg-purple-50 rounded-full flex items-center justify-center mx-auto mb-4">
                    <svg className="w-6 h-6 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 10h16M4 14h16M4 18h16" />
                    </svg>
                </div>
                <p className="font-semibold text-hui-textMain mb-2">Selection Board Templates Coming Soon</p>
                <p className="text-sm text-hui-textMuted mb-6">
                    Create template selection boards for flooring, cabinets, fixtures, and finishes. Apply to a project to auto-populate client selections.
                </p>
                <Link href="/templates" className="hui-btn hui-btn-secondary text-sm">Back to Templates</Link>
            </div>
        </div>
    );
}
