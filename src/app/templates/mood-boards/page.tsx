import Link from "next/link";

export default function MoodBoardTemplatesPage() {
    return (
        <div className="max-w-3xl mx-auto py-8 px-6 space-y-6">
            <div className="flex items-center gap-2 text-sm text-hui-textMuted mb-2">
                <Link href="/templates" className="hover:text-hui-textMain">Templates</Link>
                <span>/</span>
                <span>Mood Boards</span>
            </div>
            <div>
                <h1 className="text-2xl font-bold text-hui-textMain">Mood Board Templates</h1>
                <p className="text-sm text-hui-textMuted mt-1">Inspiration boards for kitchen, bath, and outdoor projects.</p>
            </div>
            <div className="hui-card p-12 text-center">
                <div className="w-12 h-12 bg-pink-50 rounded-full flex items-center justify-center mx-auto mb-4">
                    <svg className="w-6 h-6 text-pink-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <rect x="3" y="3" width="18" height="18" rx="2" />
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9h18M9 21V9" />
                    </svg>
                </div>
                <p className="font-semibold text-hui-textMain mb-2">Mood Board Templates Coming Soon</p>
                <p className="text-sm text-hui-textMuted mb-6">
                    Save mood boards as reusable templates. Apply to new projects to quickly set up design inspiration for clients.
                </p>
                <Link href="/templates" className="hui-btn hui-btn-secondary text-sm">Back to Templates</Link>
            </div>
        </div>
    );
}
