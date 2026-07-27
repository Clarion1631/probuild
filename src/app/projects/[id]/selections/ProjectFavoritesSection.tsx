"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { getProductLibrary, addProjectFavorite, removeProjectFavorite } from "@/lib/actions";
import { isHttpUrl } from "@/lib/url-safety";
import { ImageOff, ExternalLink, Star, Plus, X, Search } from "lucide-react";

interface Product {
    id: string;
    name: string;
    imageUrl: string | null;
    price: number | string | null;
    vendor: string | null;
    vendorUrl: string | null;
    category: string | null;
}

interface Favorite {
    id: string;
    productId: string;
    addedByClient: boolean;
    note: string | null;
    product: Product;
}

function formatPrice(value: number | string | null | undefined): string | null {
    if (value === null || value === undefined || value === "") return null;
    const num = Number(value);
    if (isNaN(num)) return null;
    return num.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

export default function ProjectFavoritesSection({
    projectId,
    initialFavorites,
}: {
    projectId: string;
    initialFavorites: Favorite[];
}) {
    const [favorites, setFavorites] = useState<Favorite[]>(initialFavorites);
    const [removingId, setRemovingId] = useState<string | null>(null);

    // Add-from-library modal
    const [showAdd, setShowAdd] = useState(false);
    const [search, setSearch] = useState("");
    const [results, setResults] = useState<Product[]>([]);
    const [searching, setSearching] = useState(false);
    const [addingId, setAddingId] = useState<string | null>(null);

    const favoritedProductIds = new Set(favorites.map((f) => f.productId));

    useEffect(() => {
        if (!showAdd) return;
        setSearching(true);
        const handle = setTimeout(() => {
            getProductLibrary(search.trim() ? { search: search.trim() } : undefined)
                .then((items) => setResults(items as unknown as Product[]))
                .catch(() => toast.error("Failed to load product library"))
                .finally(() => setSearching(false));
        }, 250);
        return () => clearTimeout(handle);
    }, [showAdd, search]);

    async function handleRemove(favorite: Favorite) {
        if (!confirm(`Remove "${favorite.product.name}" from this project's favorites?`)) return;
        setRemovingId(favorite.id);
        try {
            await removeProjectFavorite(projectId, favorite.productId);
            setFavorites((prev) => prev.filter((f) => f.id !== favorite.id));
            toast.success("Removed from favorites");
        } catch (e: any) {
            toast.error(e.message || "Failed to remove");
        } finally {
            setRemovingId(null);
        }
    }

    async function handleAdd(product: Product) {
        setAddingId(product.id);
        try {
            const favorite = await addProjectFavorite(projectId, product.id);
            setFavorites((prev) => [
                { id: favorite.id, productId: product.id, addedByClient: false, note: favorite.note ?? null, product },
                ...prev,
            ]);
            toast.success(`Added "${product.name}"`);
        } catch (e: any) {
            toast.error(e.message || "Failed to add");
        } finally {
            setAddingId(null);
        }
    }

    return (
        <div>
            <div className="flex items-center justify-between mb-4">
                <div>
                    <h2 className="text-base font-semibold text-hui-textMain">Project Favorites</h2>
                    <p className="text-sm text-hui-textMuted mt-1">Client-visible picks pinned to this project.</p>
                </div>
                <button onClick={() => setShowAdd(true)} className="hui-btn hui-btn-secondary text-sm flex items-center gap-1.5">
                    <Plus className="w-4 h-4" />
                    Add from Library
                </button>
            </div>

            {favorites.length === 0 ? (
                <div className="hui-card p-8 text-center">
                    <div className="w-12 h-12 bg-slate-100 rounded-2xl flex items-center justify-center mx-auto mb-3">
                        <Star className="w-6 h-6 text-slate-400" />
                    </div>
                    <p className="text-sm text-hui-textMuted">No favorites yet. Add one from the product library.</p>
                </div>
            ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                    {favorites.map((f) => {
                        const price = formatPrice(f.product.price);
                        return (
                            <div key={f.id} className="hui-card overflow-hidden group relative flex flex-col">
                                <div className="h-32 bg-gradient-to-br from-slate-100 to-slate-200 flex items-center justify-center overflow-hidden">
                                    {isHttpUrl(f.product.imageUrl) ? (
                                        <img src={f.product.imageUrl} alt={f.product.name} className="w-full h-full object-cover" />
                                    ) : (
                                        <ImageOff className="w-7 h-7 text-slate-300" />
                                    )}
                                </div>
                                <button
                                    onClick={() => handleRemove(f)}
                                    disabled={removingId === f.id}
                                    title="Remove from favorites"
                                    aria-label="Remove from favorites"
                                    className="absolute top-2 right-2 w-7 h-7 rounded-lg bg-white/90 backdrop-blur shadow flex items-center justify-center text-slate-500 hover:text-red-600 transition opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto [@media(hover:none)]:opacity-100 [@media(hover:none)]:pointer-events-auto"
                                >
                                    <X className="w-3.5 h-3.5" />
                                </button>
                                <div className="p-3 flex-1 flex flex-col">
                                    <div className="flex items-start justify-between gap-2">
                                        <h3 className="text-sm font-semibold text-hui-textMain line-clamp-2">{f.product.name}</h3>
                                        {price && <span className="text-sm font-bold text-hui-primary whitespace-nowrap">{price}</span>}
                                    </div>
                                    {f.product.vendor && <p className="text-xs text-hui-textMuted mt-0.5">{f.product.vendor}</p>}
                                    {f.addedByClient && (
                                        <span className="inline-block w-fit text-[10px] font-semibold uppercase tracking-wider text-green-700 bg-green-100 rounded-full px-2 py-0.5 mt-2">
                                            From client suggestion
                                        </span>
                                    )}
                                    <div className="flex-1" />
                                    {isHttpUrl(f.product.vendorUrl) && (
                                        <a
                                            href={f.product.vendorUrl}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="text-xs text-blue-600 hover:underline flex items-center gap-1 mt-2"
                                        >
                                            <ExternalLink className="w-3 h-3" />
                                            Source
                                        </a>
                                    )}
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}

            {/* Add from library modal */}
            {showAdd && (
                <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setShowAdd(false)}>
                    <div
                        className="bg-white rounded-xl shadow-2xl max-w-lg w-full max-h-[80vh] flex flex-col"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="px-6 py-4 border-b border-hui-border flex items-center justify-between">
                            <h3 className="text-lg font-bold text-hui-textMain">Add from Product Library</h3>
                            <button onClick={() => setShowAdd(false)} aria-label="Close" className="text-hui-textMuted hover:text-hui-textMain">
                                <X className="w-5 h-5" />
                            </button>
                        </div>
                        <div className="p-4 border-b border-hui-border">
                            <div className="relative">
                                <Search className="w-4 h-4 text-hui-textMuted absolute left-3 top-1/2 -translate-y-1/2" />
                                <input
                                    type="text"
                                    placeholder="Search products, vendors, categories..."
                                    value={search}
                                    onChange={(e) => setSearch(e.target.value)}
                                    className="hui-input w-full pl-9"
                                    autoFocus
                                />
                            </div>
                        </div>
                        <div className="overflow-y-auto flex-1 divide-y divide-slate-100">
                            {searching ? (
                                <p className="text-sm text-hui-textMuted text-center py-8">Searching...</p>
                            ) : results.length === 0 ? (
                                <p className="text-sm text-hui-textMuted text-center py-8">No products found.</p>
                            ) : (
                                results.map((product) => {
                                    const already = favoritedProductIds.has(product.id);
                                    const price = formatPrice(product.price);
                                    return (
                                        <div key={product.id} className="flex items-center gap-3 p-3">
                                            <div className="w-12 h-12 rounded-lg bg-slate-100 flex items-center justify-center overflow-hidden shrink-0">
                                                {isHttpUrl(product.imageUrl) ? (
                                                    <img src={product.imageUrl} alt={product.name} className="w-full h-full object-cover" />
                                                ) : (
                                                    <ImageOff className="w-4 h-4 text-slate-300" />
                                                )}
                                            </div>
                                            <div className="flex-1 min-w-0">
                                                <p className="text-sm font-medium text-hui-textMain truncate">{product.name}</p>
                                                <p className="text-xs text-hui-textMuted">
                                                    {product.vendor || "—"}{price ? ` · ${price}` : ""}
                                                </p>
                                            </div>
                                            <button
                                                onClick={() => handleAdd(product)}
                                                disabled={already || addingId === product.id}
                                                className="hui-btn hui-btn-secondary text-xs px-3 py-1.5 disabled:opacity-50 shrink-0"
                                            >
                                                {already ? "Added" : addingId === product.id ? "Adding..." : "Add"}
                                            </button>
                                        </div>
                                    );
                                })
                            )}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
