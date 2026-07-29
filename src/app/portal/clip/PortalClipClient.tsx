"use client";

import { useState } from "react";
import { toast } from "sonner";
import { submitSelectionProposal, createDecision } from "@/lib/actions";
import { isHttpUrl } from "@/lib/url-safety";
import { ImageOff, Check } from "lucide-react";

interface ClipDecision {
    id: string;
    name: string;
    area: string | null;
}

interface Props {
    projectId: string;
    initialUrl: string;
    initialName: string;
    initialPrice: string;
    initialCurrency: string;
    initialImage: string;
    // Accepted (the bookmarklet always sends it when found) but not rendered
    // or persisted — SelectionProposal has no vendor column, and the spec's
    // form only shows name / photo / note / source link. The source link
    // still gets the team to the vendor page directly.
    initialVendor: string;
    // The client's own live decisions, so a clip can land straight into the
    // category it belongs to instead of always dropping Unsorted.
    decisions: ClipDecision[];
}

// Sentinel for the "＋ New category" option — a real decision id can never
// collide with it (cuid), and "" is already taken by Unsorted.
const NEW_CATEGORY = "__new__";

// The client-facing clipper form. Prefilled entirely from the bookmarklet's
// in-page DOM extraction (see PortalClipPage / buildClipperBookmarklet) — no
// re-parse-from-URL step here, unlike the team clipper's ClipClient, since
// the spec keeps this a straight "review what we found, send it" form. Price
// is intentionally never shown or editable: the project team prices things
// out after reviewing the suggestion.
export default function PortalClipClient({
    projectId,
    initialUrl,
    initialName,
    initialPrice,
    initialCurrency,
    initialImage,
    decisions,
}: Props) {
    const [name, setName] = useState((initialName || "").slice(0, 200));
    const [note, setNote] = useState("");
    const [decisionId, setDecisionId] = useState("");
    const [newCategory, setNewCategory] = useState("");
    // Remembers a category this popup already created, so a failed submit
    // (network drop, validation) doesn't mint a second empty category when the
    // client hits Send again. Cleared whenever they change the name.
    const [createdDecisionId, setCreatedDecisionId] = useState<string | null>(null);
    const [submitting, setSubmitting] = useState(false);
    const [sent, setSent] = useState(false);

    const safeImage = initialImage && isHttpUrl(initialImage) ? initialImage : "";

    // Same non-USD fold as the team clipper (product-parse.ts's
    // normalizeParsedProduct): a listed price in another currency isn't a USD
    // number, so it's dropped from listPrice and kept as a note instead. This
    // never reaches the client's own view either way (price stays hidden
    // regardless of currency), but it keeps the team from seeing a
    // mis-scaled price once they approve the suggestion.
    const currency = (initialCurrency || "").trim().toUpperCase();
    const priceIsUsd = !!initialPrice && (!currency || currency === "USD");
    const parsedPrice = priceIsUsd ? parseFloat(initialPrice) : undefined;
    const listPrice = parsedPrice !== undefined && Number.isFinite(parsedPrice) ? parsedPrice : undefined;
    const currencyNote =
        !!initialPrice && currency && currency !== "USD" ? `Listed price: ${initialPrice} ${currency}` : undefined;

    const creatingCategory = decisionId === NEW_CATEGORY;

    async function handleSubmit() {
        if (!name.trim()) {
            toast.error("Give it a name so your team knows what you're pointing at.");
            return;
        }
        if (creatingCategory && !newCategory.trim()) {
            toast.error("Name the new category, or pick Unsorted.");
            return;
        }
        setSubmitting(true);
        try {
            // Create-then-clip, not one combined call: createDecision is the
            // single writer for a decision (client-created ones are flagged
            // createdByClient there), and submitSelectionProposal re-validates
            // whatever id it's handed against this project anyway. Reuse the
            // category if we already created it on an attempt that then failed
            // to submit — otherwise every retry leaves another empty category
            // behind.
            let targetDecisionId = creatingCategory ? createdDecisionId ?? undefined : decisionId || undefined;
            if (creatingCategory && !targetDecisionId) {
                const created = await createDecision(projectId, { name: newCategory.trim() });
                setCreatedDecisionId(created.id);
                targetDecisionId = created.id;
            }
            await submitSelectionProposal(projectId, {
                url: initialUrl || undefined,
                name: name.trim(),
                description: currencyNote,
                imageUrl: safeImage || undefined,
                clientNote: note.trim() || undefined,
                listPrice,
                decisionId: targetDecisionId,
            });
            setSent(true);
        } catch (e: any) {
            toast.error(e.message || "Couldn't send that suggestion. Please try again.");
        } finally {
            setSubmitting(false);
        }
    }

    function clipAnother() {
        setSent(false);
        setName((initialName || "").slice(0, 200));
        setNote("");
        // Category choice is deliberately NOT reset — clipping three faucets in
        // a row shouldn't mean picking "Fixtures" three times. A category made
        // via ＋ New on the last clip isn't in `decisions` (this popup never
        // re-fetches), so fall back to Unsorted rather than leaving the select
        // pointing at a stale sentinel that would create a duplicate category.
        if (creatingCategory) {
            setDecisionId("");
            setNewCategory("");
            setCreatedDecisionId(null);
        }
    }

    if (sent) {
        return (
            <div className="flex items-center justify-center min-h-[60vh] p-4">
                <div className="hui-card w-full max-w-sm p-6 text-center">
                    <div className="w-14 h-14 bg-green-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
                        <Check className="w-7 h-7 text-green-600" />
                    </div>
                    <h1 className="text-base font-bold text-hui-textMain">Sent!</h1>
                    <p className="text-sm text-hui-textMuted mt-1">
                        Your project team will take a look and get back to you.
                    </p>
                    <div className="flex flex-col gap-2 mt-6">
                        <button onClick={clipAnother} className="hui-btn hui-btn-secondary w-full">
                            Clip another item
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
        <div className="flex items-center justify-center min-h-[60vh] p-4">
            <div className="w-full max-w-sm">
                <h1 className="text-base font-bold text-hui-textMain mb-1">ProBuild Clip</h1>
                <p className="text-xs text-hui-textMuted mb-4">Send this to your project team for review.</p>

                <div className="hui-card p-4 space-y-3">
                    <div className="h-28 bg-slate-50 border border-hui-border rounded-lg flex items-center justify-center overflow-hidden">
                        {safeImage ? (
                            <img
                                src={safeImage}
                                alt="Preview"
                                className="h-full object-contain"
                                onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                            />
                        ) : (
                            <ImageOff className="w-6 h-6 text-slate-300" />
                        )}
                    </div>

                    <div>
                        <label className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Item name *</label>
                        <input
                            type="text"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            className="hui-input w-full mt-1 text-sm"
                            placeholder="Product name"
                            disabled={submitting}
                        />
                    </div>

                    <div>
                        <label className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Category</label>
                        <select
                            value={decisionId}
                            onChange={(e) => setDecisionId(e.target.value)}
                            className="hui-input w-full mt-1 text-sm"
                            disabled={submitting}
                        >
                            <option value="">Unsorted — I&apos;ll sort it later</option>
                            {decisions.map((d) => (
                                <option key={d.id} value={d.id}>
                                    {d.name}
                                    {d.area ? ` · ${d.area}` : ""}
                                </option>
                            ))}
                            <option value={NEW_CATEGORY}>＋ New category…</option>
                        </select>
                        {creatingCategory && (
                            <input
                                type="text"
                                value={newCategory}
                                onChange={(e) => {
                                    setNewCategory(e.target.value);
                                    // A different name means a different
                                    // category — don't reuse the last one.
                                    setCreatedDecisionId(null);
                                }}
                                className="hui-input w-full mt-2 text-sm"
                                placeholder="Category name (e.g. Fixtures)"
                                disabled={submitting}
                                autoFocus
                            />
                        )}
                    </div>

                    <div>
                        <label className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider">
                            Note to your team <span className="normal-case font-normal">(optional)</span>
                        </label>
                        <textarea
                            value={note}
                            onChange={(e) => setNote(e.target.value)}
                            className="hui-input w-full mt-1 text-sm"
                            rows={3}
                            placeholder="Where it'd go, why you like it..."
                            disabled={submitting}
                        />
                    </div>

                    {isHttpUrl(initialUrl) && (
                        <div className="text-xs text-hui-textMuted truncate">
                            Source:{" "}
                            <a
                                href={initialUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-blue-600 hover:underline"
                            >
                                {initialUrl}
                            </a>
                        </div>
                    )}

                    <p className="text-xs text-hui-textMuted border-t border-hui-border pt-3">
                        Your project team will price this out.
                    </p>

                    <button
                        onClick={handleSubmit}
                        disabled={submitting || !name.trim() || (creatingCategory && !newCategory.trim())}
                        className="hui-btn hui-btn-green w-full disabled:opacity-50"
                    >
                        {submitting ? "Sending..." : "Send to your project team"}
                    </button>
                </div>
            </div>
        </div>
    );
}
