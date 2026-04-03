import Link from "next/link";

export default function MyItemsPage() {
    return (
        <div className="max-w-4xl mx-auto py-8 px-6 space-y-6">
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-bold text-hui-textMain">My Items</h1>
                    <p className="text-sm text-hui-textMuted mt-1">A reusable product catalog for estimate line items.</p>
                </div>
                <button className="hui-btn hui-btn-primary text-sm" disabled>+ Add Item</button>
            </div>
            <div className="hui-card p-12 text-center">
                <div className="w-12 h-12 bg-hui-primary/10 rounded-full flex items-center justify-center mx-auto mb-4">
                    <svg className="w-6 h-6 text-hui-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
                    </svg>
                </div>
                <p className="font-semibold text-hui-textMain mb-2">My Items Coming Soon</p>
                <p className="text-sm text-hui-textMuted mb-6">
                    Build a reusable product catalog with pre-defined prices and cost codes.
                    Items will auto-populate in estimates for faster quoting.
                </p>
                <Link href="/company/cost-codes" className="hui-btn hui-btn-secondary text-sm">
                    Manage Cost Codes
                </Link>
            </div>
        </div>
    );
}
