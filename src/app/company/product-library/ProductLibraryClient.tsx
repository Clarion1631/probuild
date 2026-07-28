"use client";

import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import {
    createProductLibraryItem,
    updateProductLibraryItem,
    deleteProductLibraryItem,
    addProjectFavorite,
} from "@/lib/actions";
import { isHttpUrl } from "@/lib/url-safety";
import { buildClipperBookmarklet } from "@/lib/clipper-bookmarklet";
import {
    Plus,
    Search,
    Edit2,
    Trash2,
    ExternalLink,
    ImageOff,
    X,
    Link2,
    FolderPlus,
    Clipboard,
} from "lucide-react";

interface Product {
    id: string;
    name: string;
    description: string | null;
    imageUrl: string | null;
    price: number | string | null;
    vendor: string | null;
    vendorUrl: string | null;
    category: string | null;
    source: string;
    createdAt: string;
}

interface ProjectOption {
    id: string;
    name: string;
}

interface Props {
    initialProducts: Product[];
    allProjects: ProjectOption[];
    appUrl: string;
}

const EMPTY_FORM = {
    name: "",
    description: "",
    imageUrl: "",
    price: "",
    vendor: "",
    vendorUrl: "",
    category: "",
};

export const SITE_BLOCKS_PARSE_MESSAGE =
    "This site blocks automated reading. Tip: use the ProBuild Clip bookmarklet while on the product page — it reads the page directly.";

function formatPrice(value: number | string | null | undefined): string | null {
    if (value === null || value === undefined || value === "") return null;
    const num = Number(value);
    if (isNaN(num)) return null;
    return num.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function EmptyState({ icon, title, description, action, onAction }: {
    icon: React.ReactNode; title: string; description: string; action?: string; onAction?: () => void;
}) {
    return (
        <div className="flex flex-col items-center justify-center py-16 text-center">
            <div className="w-16 h-16 bg-slate-100 rounded-2xl flex items-center justify-center mb-4">{icon}</div>
            <h3 className="text-base font-semibold text-hui-textMain">{title}</h3>
            <p className="text-sm text-hui-textMuted mt-1 max-w-md">{description}</p>
            {action && onAction && (
                <button onClick={onAction} className="hui-btn hui-btn-green mt-4">{action}</button>
            )}
        </div>
    );
}

export default function ProductLibraryClient({ initialProducts, allProjects, appUrl }: Props) {
    const [products, setProducts] = useState<Product[]>(initialProducts);
    const [search, setSearch] = useState("");
    const [categoryFilter, setCategoryFilter] = useState("");
    const [isPending, startTransition] = useTransition();

    // Add/Edit modal
    const [showForm, setShowForm] = useState(false);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [form, setForm] = useState(EMPTY_FORM);
    const [parseUrl, setParseUrl] = useState("");
    const [parsing, setParsing] = useState(false);
    const [saving, setSaving] = useState(false);

    // Add-to-project modal
    const [addToProjectFor, setAddToProjectFor] = useState<Product | null>(null);
    const [pickedProjectId, setPickedProjectId] = useState("");
    const [favoriteNote, setFavoriteNote] = useState("");
    const [addingFavorite, setAddingFavorite] = useState(false);

    const categories = useMemo(() => {
        const set = new Set<string>();
        products.forEach((p) => { if (p.category) set.add(p.category); });
        return Array.from(set).sort();
    }, [products]);

    const filtered = useMemo(() => {
        const q = search.trim().toLowerCase();
        return products.filter((p) => {
            if (categoryFilter && p.category !== categoryFilter) return false;
            if (!q) return true;
            return (
                p.name.toLowerCase().includes(q) ||
                (p.vendor || "").toLowerCase().includes(q) ||
                (p.category || "").toLowerCase().includes(q)
            );
        });
    }, [products, search, categoryFilter]);

    function openAdd() {
        setEditingId(null);
        setForm(EMPTY_FORM);
        setParseUrl("");
        setShowForm(true);
    }

    function openEdit(product: Product) {
        setEditingId(product.id);
        setForm({
            name: product.name,
            description: product.description || "",
            imageUrl: product.imageUrl || "",
            price: product.price != null ? String(product.price) : "",
            vendor: product.vendor || "",
            vendorUrl: product.vendorUrl || "",
            category: product.category || "",
        });
        setParseUrl(product.vendorUrl || "");
        setShowForm(true);
    }

    function closeForm() {
        setShowForm(false);
        setEditingId(null);
        setForm(EMPTY_FORM);
        setParseUrl("");
    }

    async function handleParse() {
        const url = parseUrl.trim();
        if (!url) return;
        setParsing(true);
        try {
            const res = await fetch("/api/products/parse", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ url }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data?.error || "Parse failed");
            setForm((f) => ({
                ...f,
                name: data.name || f.name,
                description: data.description ?? f.description,
                imageUrl: data.imageUrl ?? f.imageUrl,
                price: data.price != null ? String(data.price) : f.price,
                vendor: data.vendor ?? f.vendor,
                vendorUrl: data.vendorUrl || url,
            }));
            if (!data.name) {
                toast.info(SITE_BLOCKS_PARSE_MESSAGE);
            } else {
                toast.success("Product details pulled in — review and save.");
            }
        } catch (e: any) {
            toast.error(SITE_BLOCKS_PARSE_MESSAGE);
        } finally {
            setParsing(false);
        }
    }

    async function handleSave() {
        if (!form.name.trim()) return;
        setSaving(true);
        try {
            const payload = {
                name: form.name.trim(),
                description: form.description || undefined,
                imageUrl: form.imageUrl || undefined,
                price: form.price ? parseFloat(form.price) : undefined,
                vendor: form.vendor || undefined,
                vendorUrl: form.vendorUrl || undefined,
                category: form.category || undefined,
            };
            if (editingId) {
                const updated = await updateProductLibraryItem(editingId, payload);
                setProducts((prev) => prev.map((p) => (p.id === editingId ? ({ ...p, ...updated } as unknown as Product) : p)));
                toast.success("Product updated");
            } else {
                const created = await createProductLibraryItem({ ...payload, source: "manual" });
                setProducts((prev) => [created as unknown as Product, ...prev]);
                toast.success("Product added to library");
            }
            closeForm();
        } catch (e: any) {
            toast.error(e.message || "Failed to save product");
        } finally {
            setSaving(false);
        }
    }

    function handleDelete(product: Product) {
        if (!confirm(`Delete "${product.name}" from the product library? This cannot be undone.`)) return;
        startTransition(async () => {
            try {
                await deleteProductLibraryItem(product.id);
                setProducts((prev) => prev.filter((p) => p.id !== product.id));
                toast.success("Product deleted");
            } catch (e: any) {
                toast.error(e.message || "Failed to delete product");
            }
        });
    }

    function openAddToProject(product: Product) {
        setAddToProjectFor(product);
        setPickedProjectId("");
        setFavoriteNote("");
    }

    async function handleAddToProject() {
        if (!addToProjectFor || !pickedProjectId) return;
        setAddingFavorite(true);
        try {
            await addProjectFavorite(pickedProjectId, addToProjectFor.id, favoriteNote || undefined);
            const projectName = allProjects.find((p) => p.id === pickedProjectId)?.name || "project";
            toast.success(`Added to ${projectName}'s favorites`);
            setAddToProjectFor(null);
        } catch (e: any) {
            toast.error(e.message || "Failed to add to project");
        } finally {
            setAddingFavorite(false);
        }
    }

    const bookmarkletHref = buildClipperBookmarklet({ origin: appUrl, targetPath: "/clip" });

    return (
        <div className="max-w-6xl mx-auto py-8 px-6">
            {/* Header */}
            <div className="flex items-center justify-between mb-6">
                <div>
                    <h1 className="text-xl font-bold text-hui-textMain">Product Library</h1>
                    <p className="text-sm text-hui-textMuted mt-1">
                        {products.length} product{products.length !== 1 ? "s" : ""} · reusable across every project
                    </p>
                </div>
                <button onClick={openAdd} className="hui-btn hui-btn-green flex items-center gap-2">
                    <Plus className="w-4 h-4" />
                    Add Product
                </button>
            </div>

            {/* Bookmarklet card */}
            <div className="hui-card p-5 mb-6 flex items-center justify-between gap-6 flex-wrap">
                <div className="flex items-center gap-4">
                    <div className="w-11 h-11 bg-hui-primary/10 rounded-xl flex items-center justify-center shrink-0">
                        <Clipboard className="w-5 h-5 text-hui-primary" />
                    </div>
                    <div>
                        <h2 className="text-base font-semibold text-hui-textMain">Get the Clipper</h2>
                        <p className="text-sm text-hui-textMuted mt-0.5">
                            Drag this to your bookmarks bar. On any product page, click it to clip straight to the library.
                        </p>
                    </div>
                </div>
                <a
                    href={bookmarkletHref}
                    onClick={(e) => e.preventDefault()}
                    className="hui-btn hui-btn-secondary flex items-center gap-2 cursor-grab active:cursor-grabbing shrink-0"
                    title="Drag me to your bookmarks bar"
                >
                    <Link2 className="w-4 h-4" />
                    ProBuild Clip
                </a>
            </div>

            {/* Search + category filter */}
            <div className="flex items-center gap-3 mb-4 flex-wrap">
                <div className="relative flex-1 min-w-[220px]">
                    <Search className="w-4 h-4 text-hui-textMuted absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                        type="text"
                        placeholder="Search products, vendors, categories..."
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        className="hui-input w-full pl-9"
                    />
                </div>
                <select
                    value={categoryFilter}
                    onChange={(e) => setCategoryFilter(e.target.value)}
                    className="hui-input w-56"
                >
                    <option value="">All categories</option>
                    {categories.map((c) => (
                        <option key={c} value={c}>{c}</option>
                    ))}
                </select>
            </div>

            {/* Grid */}
            {filtered.length === 0 ? (
                <div className="hui-card">
                    <EmptyState
                        icon={<Clipboard className="w-7 h-7 text-slate-400" />}
                        title={products.length === 0 ? "No products clipped yet" : "No products match your filters"}
                        description={
                            products.length === 0
                                ? "Paste a product URL to clip it into the library, or drag the Clipper bookmarklet above to your bookmarks bar."
                                : "Try a different search term or category."
                        }
                        action={products.length === 0 ? "Add Product" : undefined}
                        onAction={products.length === 0 ? openAdd : undefined}
                    />
                </div>
            ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                    {filtered.map((product) => {
                        const price = formatPrice(product.price);
                        return (
                            <div key={product.id} className="hui-card overflow-hidden group relative flex flex-col">
                                {/* Image */}
                                <div className="h-36 bg-gradient-to-br from-slate-100 to-slate-200 flex items-center justify-center overflow-hidden">
                                    {isHttpUrl(product.imageUrl) ? (
                                        <img
                                            src={product.imageUrl}
                                            alt={product.name}
                                            className="w-full h-full object-cover"
                                            onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                                        />
                                    ) : (
                                        <ImageOff className="w-8 h-8 text-slate-300" />
                                    )}
                                </div>

                                {/* Edit / delete — hover reveal, always visible on no-hover devices */}
                                <div className="absolute top-2 right-2 flex gap-1 opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto [@media(hover:none)]:opacity-100 [@media(hover:none)]:pointer-events-auto transition">
                                    <button
                                        onClick={() => openEdit(product)}
                                        title="Edit"
                                        aria-label="Edit product"
                                        className="w-7 h-7 rounded-lg bg-white/90 backdrop-blur shadow flex items-center justify-center text-slate-500 hover:text-hui-primary transition"
                                    >
                                        <Edit2 className="w-3.5 h-3.5" />
                                    </button>
                                    <button
                                        onClick={() => handleDelete(product)}
                                        disabled={isPending}
                                        title="Delete"
                                        aria-label="Delete product"
                                        className="w-7 h-7 rounded-lg bg-white/90 backdrop-blur shadow flex items-center justify-center text-slate-500 hover:text-red-600 transition"
                                    >
                                        <Trash2 className="w-3.5 h-3.5" />
                                    </button>
                                </div>

                                {/* Info */}
                                <div className="p-3 flex-1 flex flex-col">
                                    <div className="flex items-start justify-between gap-2 mb-1">
                                        <h3 className="text-sm font-semibold text-hui-textMain line-clamp-2">{product.name}</h3>
                                        {price && (
                                            <span className="text-sm font-bold text-hui-primary whitespace-nowrap">{price}</span>
                                        )}
                                    </div>
                                    {product.vendor && (
                                        <p className="text-xs text-hui-textMuted mb-1">{product.vendor}</p>
                                    )}
                                    {product.category && (
                                        <span className="inline-block w-fit text-[10px] font-semibold uppercase tracking-wider text-hui-textMuted bg-slate-100 rounded-full px-2 py-0.5 mb-2">
                                            {product.category}
                                        </span>
                                    )}
                                    <div className="flex-1" />
                                    <div className="flex items-center gap-2 mt-2">
                                        {isHttpUrl(product.vendorUrl) && (
                                            <a
                                                href={product.vendorUrl}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="text-xs text-blue-600 hover:underline flex items-center gap-1"
                                            >
                                                <ExternalLink className="w-3 h-3" />
                                                Source
                                            </a>
                                        )}
                                        <div className="flex-1" />
                                        <button
                                            onClick={() => openAddToProject(product)}
                                            className="text-xs font-medium text-hui-primary hover:text-hui-primaryHover flex items-center gap-1 transition"
                                        >
                                            <FolderPlus className="w-3.5 h-3.5" />
                                            Add to project…
                                        </button>
                                    </div>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}

            {/* Add / Edit modal */}
            {showForm && (
                <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={closeForm}>
                    <div
                        className="bg-white rounded-xl shadow-2xl max-w-lg w-full max-h-[90vh] overflow-y-auto"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="px-6 py-4 border-b border-hui-border flex items-center justify-between">
                            <h3 className="text-lg font-bold text-hui-textMain">
                                {editingId ? "Edit Product" : "Add Product"}
                            </h3>
                            <button onClick={closeForm} aria-label="Close" className="text-hui-textMuted hover:text-hui-textMain">
                                <X className="w-5 h-5" />
                            </button>
                        </div>

                        <div className="p-6 space-y-4">
                            {/* Parse from URL */}
                            <div>
                                <label className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Paste Product URL</label>
                                <div className="flex gap-2 mt-1">
                                    <input
                                        type="url"
                                        placeholder="https://vendor.com/product/..."
                                        value={parseUrl}
                                        onChange={(e) => setParseUrl(e.target.value)}
                                        className="hui-input flex-1"
                                        onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), handleParse())}
                                    />
                                    <button
                                        onClick={handleParse}
                                        disabled={parsing || !parseUrl.trim()}
                                        className="hui-btn hui-btn-secondary whitespace-nowrap disabled:opacity-50"
                                    >
                                        {parsing ? "Parsing..." : "Parse"}
                                    </button>
                                </div>
                                <p className="text-xs text-hui-textMuted mt-1">
                                    Pulls in name, image, price, and vendor when available. Everything below stays editable.
                                </p>
                            </div>

                            <div className="border-t border-hui-border pt-4 space-y-4">
                                <div>
                                    <label className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Name *</label>
                                    <input
                                        type="text"
                                        value={form.name}
                                        onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                                        className="hui-input w-full mt-1"
                                        placeholder="Product name"
                                    />
                                </div>
                                <div>
                                    <label className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Description</label>
                                    <textarea
                                        value={form.description}
                                        onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                                        className="hui-input w-full mt-1"
                                        rows={2}
                                    />
                                </div>
                                <div className="grid grid-cols-2 gap-4">
                                    <div>
                                        <label className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Price</label>
                                        <input
                                            type="number"
                                            step="0.01"
                                            min="0"
                                            value={form.price}
                                            onChange={(e) => setForm((f) => ({ ...f, price: e.target.value }))}
                                            className="hui-input w-full mt-1"
                                            placeholder="0.00"
                                        />
                                    </div>
                                    <div>
                                        <label className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Vendor</label>
                                        <input
                                            type="text"
                                            value={form.vendor}
                                            onChange={(e) => setForm((f) => ({ ...f, vendor: e.target.value }))}
                                            className="hui-input w-full mt-1"
                                            placeholder="e.g. Ferguson"
                                        />
                                    </div>
                                </div>
                                <div className="grid grid-cols-2 gap-4">
                                    <div>
                                        <label className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Category</label>
                                        <input
                                            type="text"
                                            list="product-library-categories"
                                            value={form.category}
                                            onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
                                            className="hui-input w-full mt-1"
                                            placeholder="e.g. Plumbing Fixtures"
                                        />
                                        <datalist id="product-library-categories">
                                            {categories.map((c) => <option key={c} value={c} />)}
                                        </datalist>
                                    </div>
                                    <div>
                                        <label className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Image URL</label>
                                        <input
                                            type="url"
                                            value={form.imageUrl}
                                            onChange={(e) => setForm((f) => ({ ...f, imageUrl: e.target.value }))}
                                            className="hui-input w-full mt-1"
                                            placeholder="https://..."
                                        />
                                    </div>
                                </div>
                                <div>
                                    <label className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Source Link</label>
                                    <input
                                        type="url"
                                        value={form.vendorUrl}
                                        onChange={(e) => setForm((f) => ({ ...f, vendorUrl: e.target.value }))}
                                        className="hui-input w-full mt-1"
                                        placeholder="https://vendor.com/product/..."
                                    />
                                </div>
                                {isHttpUrl(form.imageUrl) && (
                                    <div className="h-28 bg-slate-50 border border-hui-border rounded-lg flex items-center justify-center overflow-hidden">
                                        <img src={form.imageUrl} alt="Preview" className="h-full object-contain" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
                                    </div>
                                )}
                            </div>
                        </div>

                        <div className="px-6 py-4 border-t border-hui-border flex justify-end gap-3 bg-slate-50">
                            <button onClick={closeForm} className="hui-btn hui-btn-secondary">Cancel</button>
                            <button
                                onClick={handleSave}
                                disabled={saving || !form.name.trim()}
                                className="hui-btn hui-btn-green disabled:opacity-50"
                            >
                                {saving ? "Saving..." : editingId ? "Save Changes" : "Add to Library"}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Add to project modal */}
            {addToProjectFor && (
                <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setAddToProjectFor(null)}>
                    <div className="bg-white rounded-xl shadow-2xl max-w-md w-full" onClick={(e) => e.stopPropagation()}>
                        <div className="px-6 py-4 border-b border-hui-border">
                            <h3 className="text-lg font-bold text-hui-textMain">Add to project favorites</h3>
                            <p className="text-xs text-hui-textMuted mt-0.5">{addToProjectFor.name}</p>
                        </div>
                        <div className="p-6 space-y-4">
                            {allProjects.length === 0 ? (
                                <p className="text-sm text-hui-textMuted">No active projects found.</p>
                            ) : (
                                <>
                                    <div>
                                        <label className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Project</label>
                                        <select
                                            value={pickedProjectId}
                                            onChange={(e) => setPickedProjectId(e.target.value)}
                                            className="hui-input w-full mt-1"
                                            autoFocus
                                        >
                                            <option value="">— Pick a project —</option>
                                            {allProjects.map((p) => (
                                                <option key={p.id} value={p.id}>{p.name}</option>
                                            ))}
                                        </select>
                                    </div>
                                    <div>
                                        <label className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Note (optional)</label>
                                        <textarea
                                            value={favoriteNote}
                                            onChange={(e) => setFavoriteNote(e.target.value)}
                                            className="hui-input w-full mt-1"
                                            rows={2}
                                            placeholder="Why this fits the project..."
                                        />
                                    </div>
                                </>
                            )}
                        </div>
                        <div className="px-6 py-4 border-t border-hui-border flex justify-end gap-3 bg-slate-50">
                            <button onClick={() => setAddToProjectFor(null)} className="hui-btn hui-btn-secondary">Cancel</button>
                            <button
                                onClick={handleAddToProject}
                                disabled={addingFavorite || !pickedProjectId}
                                className="hui-btn hui-btn-green disabled:opacity-50"
                            >
                                {addingFavorite ? "Adding..." : "Add to Favorites"}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
