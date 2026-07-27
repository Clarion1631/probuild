"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { createProductLibraryItem, addProjectFavorite } from "@/lib/actions";
import { ImageOff, Check, RefreshCw } from "lucide-react";

interface ProjectOption {
    id: string;
    name: string;
}

const EMPTY_FORM = {
    name: "",
    description: "",
    imageUrl: "",
    price: "",
    vendor: "",
    category: "",
};

export default function ClipClient({ initialUrl, allProjects }: { initialUrl: string; allProjects: ProjectOption[] }) {
    const [url, setUrl] = useState(initialUrl);
    const [form, setForm] = useState(EMPTY_FORM);
    const [parsing, setParsing] = useState(false);
    const [parsed, setParsed] = useState(false);
    const [saving, setSaving] = useState(false);
    const [savedProduct, setSavedProduct] = useState<{ id: string; toProject?: string } | null>(null);
    const [showProjectPicker, setShowProjectPicker] = useState(false);
    const [pickedProjectId, setPickedProjectId] = useState("");

    useEffect(() => {
        if (initialUrl) {
            void parseUrl(initialUrl);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [initialUrl]);

    async function parseUrl(targetUrl: string) {
        const trimmed = targetUrl.trim();
        if (!trimmed) return;
        setParsing(true);
        try {
            const res = await fetch("/api/products/parse", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ url: trimmed }),
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
            }));
            setParsed(true);
            if (!data.name) {
                toast.info("Couldn't auto-detect this page — fill in details manually.");
            }
        } catch (e: any) {
            toast.error(e.message || "Couldn't parse that page");
        } finally {
            setParsing(false);
        }
    }

    function resetForAnother() {
        setUrl("");
        setForm(EMPTY_FORM);
        setParsed(false);
        setSavedProduct(null);
        setShowProjectPicker(false);
        setPickedProjectId("");
    }

    async function saveToLibrary(): Promise<{ id: string } | null> {
        if (!form.name.trim()) {
            toast.error("Name is required");
            return null;
        }
        try {
            const created = await createProductLibraryItem({
                name: form.name.trim(),
                description: form.description || undefined,
                imageUrl: form.imageUrl || undefined,
                price: form.price ? parseFloat(form.price) : undefined,
                vendor: form.vendor || undefined,
                vendorUrl: url || undefined,
                category: form.category || undefined,
                source: "clip",
            });
            return { id: created.id };
        } catch (e: any) {
            toast.error(e.message || "Failed to save product");
            return null;
        }
    }

    async function handleSaveOnly() {
        setSaving(true);
        try {
            const created = await saveToLibrary();
            if (created) {
                setSavedProduct({ id: created.id });
                toast.success("Saved to product library");
            }
        } finally {
            setSaving(false);
        }
    }

    async function handleSaveAndAddToProject() {
        if (!pickedProjectId) return;
        setSaving(true);
        try {
            const created = await saveToLibrary();
            if (created) {
                const projectName = allProjects.find((p) => p.id === pickedProjectId)?.name || "project";
                await addProjectFavorite(pickedProjectId, created.id);
                setSavedProduct({ id: created.id, toProject: projectName });
                toast.success(`Saved and added to ${projectName}`);
            }
        } catch (e: any) {
            toast.error(e.message || "Failed to add to project");
        } finally {
            setSaving(false);
        }
    }

    if (savedProduct) {
        return (
            <div className="min-h-screen bg-hui-background flex items-center justify-center p-6">
                <div className="hui-card w-full max-w-sm p-6 text-center">
                    <div className="w-14 h-14 bg-green-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
                        <Check className="w-7 h-7 text-green-600" />
                    </div>
                    <h1 className="text-base font-bold text-hui-textMain">Clipped!</h1>
                    <p className="text-sm text-hui-textMuted mt-1">
                        {savedProduct.toProject
                            ? `Saved to the library and added to ${savedProduct.toProject}'s favorites.`
                            : "Saved to the product library."}
                    </p>
                    <div className="flex flex-col gap-2 mt-6">
                        <button onClick={resetForAnother} className="hui-btn hui-btn-secondary w-full">
                            Clip another
                        </button>
                        <button onClick={() => window.close()} className="hui-btn hui-btn-green w-full">
                            Close window
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-hui-background p-4">
            <div className="max-w-sm mx-auto">
                <h1 className="text-base font-bold text-hui-textMain mb-1">ProBuild Clip</h1>
                <p className="text-xs text-hui-textMuted mb-4">Capture this product into the shared library.</p>

                <div className="hui-card p-4 space-y-3">
                    <div className="flex gap-2">
                        <input
                            type="url"
                            value={url}
                            onChange={(e) => setUrl(e.target.value)}
                            placeholder="https://vendor.com/product/..."
                            className="hui-input flex-1 text-sm"
                            onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), parseUrl(url))}
                        />
                        <button
                            onClick={() => parseUrl(url)}
                            disabled={parsing || !url.trim()}
                            title="Re-parse"
                            aria-label="Re-parse"
                            className="hui-btn hui-btn-secondary px-3 disabled:opacity-50"
                        >
                            <RefreshCw className={`w-4 h-4 ${parsing ? "animate-spin" : ""}`} />
                        </button>
                    </div>

                    {parsing && (
                        <p className="text-xs text-hui-textMuted">Reading the page...</p>
                    )}

                    <div className="h-28 bg-slate-50 border border-hui-border rounded-lg flex items-center justify-center overflow-hidden">
                        {form.imageUrl ? (
                            <img
                                src={form.imageUrl}
                                alt="Preview"
                                className="h-full object-contain"
                                onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                            />
                        ) : (
                            <ImageOff className="w-6 h-6 text-slate-300" />
                        )}
                    </div>

                    <div>
                        <label className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Name *</label>
                        <input
                            type="text"
                            value={form.name}
                            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                            className="hui-input w-full mt-1 text-sm"
                            placeholder="Product name"
                        />
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                        <div>
                            <label className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Price</label>
                            <input
                                type="number"
                                step="0.01"
                                min="0"
                                value={form.price}
                                onChange={(e) => setForm((f) => ({ ...f, price: e.target.value }))}
                                className="hui-input w-full mt-1 text-sm"
                                placeholder="0.00"
                            />
                        </div>
                        <div>
                            <label className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Vendor</label>
                            <input
                                type="text"
                                value={form.vendor}
                                onChange={(e) => setForm((f) => ({ ...f, vendor: e.target.value }))}
                                className="hui-input w-full mt-1 text-sm"
                                placeholder="e.g. Ferguson"
                            />
                        </div>
                    </div>

                    <div>
                        <label className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Category</label>
                        <input
                            type="text"
                            value={form.category}
                            onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
                            className="hui-input w-full mt-1 text-sm"
                            placeholder="e.g. Plumbing Fixtures"
                        />
                    </div>

                    <div>
                        <label className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Description</label>
                        <textarea
                            value={form.description}
                            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                            className="hui-input w-full mt-1 text-sm"
                            rows={2}
                        />
                    </div>

                    {showProjectPicker && (
                        <div className="border-t border-hui-border pt-3">
                            <label className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Project</label>
                            <select
                                value={pickedProjectId}
                                onChange={(e) => setPickedProjectId(e.target.value)}
                                className="hui-input w-full mt-1 text-sm"
                            >
                                <option value="">— Pick a project —</option>
                                {allProjects.map((p) => (
                                    <option key={p.id} value={p.id}>{p.name}</option>
                                ))}
                            </select>
                        </div>
                    )}

                    <div className="flex flex-col gap-2 pt-1">
                        {!showProjectPicker ? (
                            <>
                                <button
                                    onClick={handleSaveOnly}
                                    disabled={saving || !form.name.trim()}
                                    className="hui-btn hui-btn-green w-full disabled:opacity-50"
                                >
                                    {saving ? "Saving..." : "Save to Library"}
                                </button>
                                <button
                                    onClick={() => setShowProjectPicker(true)}
                                    disabled={!form.name.trim() || allProjects.length === 0}
                                    className="hui-btn hui-btn-secondary w-full disabled:opacity-50"
                                >
                                    Save + Add to Project
                                </button>
                            </>
                        ) : (
                            <>
                                <button
                                    onClick={handleSaveAndAddToProject}
                                    disabled={saving || !pickedProjectId}
                                    className="hui-btn hui-btn-green w-full disabled:opacity-50"
                                >
                                    {saving ? "Saving..." : "Save + Add"}
                                </button>
                                <button
                                    onClick={() => setShowProjectPicker(false)}
                                    className="hui-btn hui-btn-secondary w-full"
                                >
                                    Back
                                </button>
                            </>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
