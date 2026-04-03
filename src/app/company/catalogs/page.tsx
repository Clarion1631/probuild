import Link from "next/link";

export default function CatalogsPage() {
    return (
        <div className="max-w-4xl mx-auto py-8 px-6 space-y-6">
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-bold text-hui-textMain">Catalogs</h1>
                    <p className="text-sm text-hui-textMuted mt-1">Browse and manage vendor product catalogs.</p>
                </div>
            </div>
            <div className="hui-card p-12 text-center">
                <div className="w-12 h-12 bg-hui-primary/10 rounded-full flex items-center justify-center mx-auto mb-4">
                    <svg className="w-6 h-6 text-hui-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                    </svg>
                </div>
                <p className="font-semibold text-hui-textMain mb-2">Vendor Catalogs Coming Soon</p>
                <p className="text-sm text-hui-textMuted mb-6">
                    Upload and browse vendor product catalogs. Pull items directly into estimates and purchase orders.
                </p>
                <Link href="/company/vendors" className="hui-btn hui-btn-secondary text-sm">
                    Manage Vendors
                </Link>
            </div>
        </div>
    );
}
