// Read-only "Project Favorites" grid — items your team has pinned from the
// product library, plus anything that landed here automatically from an
// approved client suggestion (see PortalSuggestionsSection). Price is
// intentionally never shown here (see docs/specs/product-library-portal-selections.md
// Phase 3, item 2) — favorites are ideas being explored, not priced selections.

interface FavoriteProduct {
    id: string;
    name: string;
    imageUrl: string | null;
    vendor: string | null;
    vendorUrl: string | null;
}

interface Favorite {
    id: string;
    note: string | null;
    product: FavoriteProduct;
}

export default function PortalProjectFavorites({ favorites }: { favorites: Favorite[] }) {
    return (
        <div>
            <div className="mb-4">
                <h2 className="text-xl font-bold text-hui-textMain">Project Favorites</h2>
                <p className="text-sm text-hui-textMuted">Things your team has been finding for your project.</p>
            </div>

            {favorites.length === 0 ? (
                <div className="hui-card p-10 text-center">
                    <p className="text-sm text-hui-textMuted">
                        Your team will pin ideas here as they find them.
                    </p>
                </div>
            ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
                    {favorites.map(fav => (
                        <div
                            key={fav.id}
                            className="rounded-xl border-2 border-slate-200 overflow-hidden hover:shadow-sm transition-all duration-200"
                        >
                            <div className="h-48 bg-slate-100 flex items-center justify-center overflow-hidden">
                                {fav.product.imageUrl ? (
                                    <img
                                        src={fav.product.imageUrl}
                                        alt={fav.product.name}
                                        className="w-full h-full object-cover"
                                    />
                                ) : (
                                    <svg className="w-12 h-12 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                                    </svg>
                                )}
                            </div>

                            <div className="p-4 bg-white">
                                <h4 className="font-bold text-slate-800 leading-tight mb-1">{fav.product.name}</h4>
                                {fav.product.vendor && (
                                    <p className="text-xs text-slate-500 mb-2">{fav.product.vendor}</p>
                                )}
                                {fav.note && (
                                    <p className="text-sm text-slate-500 mb-3 line-clamp-3">{fav.note}</p>
                                )}
                                {fav.product.vendorUrl && (
                                    <a
                                        href={fav.product.vendorUrl}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="text-xs font-semibold text-blue-600 hover:text-blue-800 inline-flex items-center gap-1"
                                    >
                                        View Product
                                        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
                                    </a>
                                )}
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
