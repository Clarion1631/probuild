// Top toolbar — undo/redo, 2D/3D toggle, manual save, export (Stage 4 stub).
// All wiring runs through the Zustand store so the toolbar stays pure.

import { useRoomStore } from "./hooks/useRoomStore";
import { toast } from "sonner";
import { exportToProBuild } from "@/lib/room-designer/blueprint3d-adapter";
import { useEffect, useRef, useState } from "react";
import {
    DEFAULT_PRESET,
    HDRI_PRESETS,
    HDRI_PRESET_ORDER,
    type HdriPreset,
} from "@/lib/room-designer/hdri-presets";
import {
    downloadBlob,
    renderRoomPng,
    slugifyForFilename,
} from "@/lib/room-designer/export-png";
import { renderRoomPdf } from "@/lib/room-designer/export-pdf";
import { buildMaterialsCsv } from "@/lib/room-designer/export-csv";
import type { OwnerContext } from "@/lib/room-designer/owner-context";
import { buildShareUrl } from "@/lib/room-designer/share-url";
import type { RoomDesignerInitialShareState } from "./RoomDesignerClient";
import { ShareModal } from "./ShareModal";
import { PreviewModeToggle } from "./PreviewModeToggle";

interface RoomToolbarProps {
    roomName: string;
    ownerContext: OwnerContext;
    initialShareState: RoomDesignerInitialShareState;
}

export function RoomToolbar({ roomName, ownerContext, initialShareState }: RoomToolbarProps) {
    const viewMode = useRoomStore((s) => s.viewMode);
    const setViewMode = useRoomStore((s) => s.setViewMode);
    const undo = useRoomStore((s) => s.undo);
    const redo = useRoomStore((s) => s.redo);
    const past = useRoomStore((s) => s.past);
    const future = useRoomStore((s) => s.future);
    const dirty = useRoomStore((s) => s.dirty);
    const lastSavedAt = useRoomStore((s) => s.lastSavedAt);
    const getSnapshot = useRoomStore((s) => s.getSnapshot);
    const markSaved = useRoomStore((s) => s.markSaved);
    const roomId = useRoomStore((s) => s.roomId);
    const showLayers = useRoomStore((s) => s.showLayers);
    const setShowLayers = useRoomStore((s) => s.setShowLayers);
    const showMeasurements = useRoomStore((s) => s.showMeasurements);
    const setShowMeasurements = useRoomStore((s) => s.setShowMeasurements);

    const [saving, setSaving] = useState(false);
    const [exportingPng, setExportingPng] = useState(false);
    const [exportingPdf, setExportingPdf] = useState(false);
    const [shareEnabled, setShareEnabled] = useState(initialShareState.enabled);
    const [shareUrl, setShareUrl] = useState<string | null>(
        initialShareState.token ? buildShareUrl(initialShareState.token) : null,
    );
    const [shareOpen, setShareOpen] = useState(false);
    const shareBtnRef = useRef<HTMLButtonElement | null>(null);

    function exportCsv() {
        const state = useRoomStore.getState();
        try {
            const csv = buildMaterialsCsv(state.assets);
            // Prepend UTF-8 BOM so Excel opens accented characters correctly.
            const blob = new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" });
            const filename = `${slugifyForFilename(ownerContext.ownerName)}-${slugifyForFilename(roomName)}-materials.csv`;
            downloadBlob(blob, filename);
            toast.success("Materials list exported");
        } catch (err) {
            toast.error("CSV export failed");
            // eslint-disable-next-line no-console
            console.error(err);
        }
    }

    async function exportPdf() {
        const state = useRoomStore.getState();
        const refs = state.canvasRefs;
        if (!refs) {
            toast.error("Canvas isn't ready yet — try again in a moment.");
            return;
        }
        setExportingPdf(true);
        try {
            const blob = await renderRoomPdf(
                {
                    gl: refs.gl,
                    scene: refs.scene,
                    liveCamera: refs.camera,
                    layout: state.layout,
                },
                {
                    contractorName: ownerContext.contractorName,
                    contractorLogoUrl: ownerContext.contractorLogoUrl,
                    contractorAddress: ownerContext.contractorAddress,
                    ownerName: ownerContext.ownerName,
                    ownerAddress: ownerContext.ownerAddress,
                },
                { roomName },
                state.assets,
            );
            const filename = `${slugifyForFilename(ownerContext.ownerName)}-${slugifyForFilename(roomName)}.pdf`;
            downloadBlob(blob, filename);
            toast.success("PDF exported");
        } catch (err) {
            toast.error("PDF export failed");
            // eslint-disable-next-line no-console
            console.error(err);
        } finally {
            setExportingPdf(false);
        }
    }

    async function exportPng() {
        const refs = useRoomStore.getState().canvasRefs;
        if (!refs) {
            toast.error("Canvas isn't ready yet — try again in a moment.");
            return;
        }
        setExportingPng(true);
        try {
            const blob = await renderRoomPng(refs.gl, refs.scene, refs.camera, {
                width: 2048,
                height: 2048,
                watermark: {
                    contractor: ownerContext.contractorName,
                    project: ownerContext.ownerName,
                },
            });
            const filename = `${slugifyForFilename(ownerContext.ownerName)}-${slugifyForFilename(roomName)}.png`;
            downloadBlob(blob, filename);
            toast.success("Image exported");
        } catch (err) {
            toast.error("Image export failed");
            // eslint-disable-next-line no-console
            console.error(err);
        } finally {
            setExportingPng(false);
        }
    }

    async function saveNow() {
        if (!roomId) return;
        setSaving(true);
        try {
            const payload = exportToProBuild(getSnapshot());
            const res = await fetch(`/api/rooms/${roomId}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            });
            if (!res.ok) throw new Error(`Save failed: ${res.status}`);
            markSaved();
            toast.success("Saved");
        } catch (err) {
            toast.error("Save failed");
            // eslint-disable-next-line no-console
            console.error(err);
        } finally {
            setSaving(false);
        }
    }

    // Ctrl+S force-save bridge — useAssetSelection dispatches this so the
    // key handler doesn't need to reach into the toolbar's local state.
    useEffect(() => {
        function onForceSave() {
            saveNow();
        }
        window.addEventListener("room-designer:force-save", onForceSave);
        return () => window.removeEventListener("room-designer:force-save", onForceSave);
        // saveNow is a stable-enough closure for the room's lifecycle; deps
        // kept empty intentionally so the listener isn't re-attached on every
        // render (roomId never changes within a mounted toolbar).
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const savedLabel = dirty
        ? "Unsaved changes"
        : lastSavedAt
            ? `Saved ${timeAgo(lastSavedAt)}`
            : "Saved";

    return (
        <div className="flex items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 py-2">
            <div className="flex items-center gap-3">
                <h1 className="truncate text-sm font-semibold text-slate-900">{roomName}</h1>
                <span className={`text-xs ${dirty ? "text-amber-600" : "text-slate-400"}`}>{savedLabel}</span>
            </div>

            <div className="flex items-center gap-1">
                <button
                    onClick={undo}
                    disabled={past.length === 0}
                    className="hui-btn hui-btn-secondary px-2 py-1 text-xs disabled:opacity-40"
                    title="Undo (Ctrl+Z)"
                >
                    ↶ Undo
                </button>
                <button
                    onClick={redo}
                    disabled={future.length === 0}
                    className="hui-btn hui-btn-secondary px-2 py-1 text-xs disabled:opacity-40"
                    title="Redo (Ctrl+Y)"
                >
                    ↷ Redo
                </button>

                <ToolModeIndicator />

                <div className="mx-2 h-5 w-px bg-slate-200" />

                <button
                    onClick={() => setShowLayers(!showLayers)}
                    className={`hui-btn px-2 py-1 text-xs ${showLayers ? "hui-btn-green" : "hui-btn-secondary"}`}
                    title="Layers (L)"
                >
                    Layers
                </button>
                <button
                    onClick={() => setShowMeasurements(!showMeasurements)}
                    className={`hui-btn px-2 py-1 text-xs ${showMeasurements ? "hui-btn-green" : "hui-btn-secondary"}`}
                    title="Measurements (M)"
                >
                    Measure
                </button>

                <HdriPicker />
                <FxToggle />

                <div className="mx-2 h-5 w-px bg-slate-200" />

                <div className="flex overflow-hidden rounded-md border border-slate-200">
                    <button
                        onClick={() => setViewMode("2d")}
                        className={`px-3 py-1 text-xs font-medium transition ${
                            viewMode === "2d" ? "bg-slate-900 text-white" : "bg-white text-slate-700 hover:bg-slate-50"
                        }`}
                    >
                        2D
                    </button>
                    <button
                        onClick={() => setViewMode("3d")}
                        className={`px-3 py-1 text-xs font-medium transition ${
                            viewMode === "3d" ? "bg-slate-900 text-white" : "bg-white text-slate-700 hover:bg-slate-50"
                        }`}
                    >
                        3D
                    </button>
                </div>

                <PreviewModeToggle />

                <div className="mx-2 h-5 w-px bg-slate-200" />

                <button
                    onClick={saveNow}
                    disabled={saving || !dirty}
                    className="hui-btn hui-btn-green px-3 py-1 text-xs disabled:opacity-50"
                >
                    {saving ? "Saving…" : "Save"}
                </button>
                <button
                    onClick={exportPng}
                    disabled={exportingPng}
                    className="hui-btn hui-btn-secondary px-2 py-1 text-xs disabled:opacity-50"
                    title="Export as PNG image (2048×2048, watermarked)"
                >
                    {exportingPng ? "Exporting…" : "Export Image"}
                </button>
                <button
                    onClick={exportPdf}
                    disabled={exportingPdf}
                    className="hui-btn hui-btn-secondary px-2 py-1 text-xs disabled:opacity-50"
                    title="Export 3-page PDF (perspective, top-down, materials list)"
                >
                    {exportingPdf ? "Exporting…" : "Export PDF"}
                </button>
                <button
                    onClick={exportCsv}
                    className="hui-btn hui-btn-secondary px-2 py-1 text-xs"
                    title="Download materials list as CSV"
                >
                    Materials CSV
                </button>

                <div className="relative">
                    <button
                        ref={shareBtnRef}
                        onClick={() => setShareOpen((v) => !v)}
                        className={`hui-btn px-2 py-1 text-xs ${shareEnabled ? "hui-btn-green" : "hui-btn-secondary"}`}
                        title={shareEnabled ? "Share link enabled" : "Share with a client"}
                    >
                        Share
                        {shareEnabled && <span className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-emerald-300" aria-hidden />}
                    </button>
                    {shareOpen && roomId && (
                        <ShareModal
                            roomId={roomId}
                            anchorRef={shareBtnRef}
                            onClose={() => setShareOpen(false)}
                            onStateChange={({ enabled, url }) => {
                                setShareEnabled(enabled);
                                setShareUrl(url);
                            }}
                            initialEnabled={shareEnabled}
                            initialUrl={shareUrl}
                        />
                    )}
                </div>
            </div>
        </div>
    );
}

function timeAgo(ts: number): string {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 10) return "just now";
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    return `${h}h ago`;
}

// ─────────────── Tool mode indicator ───────────────
function ToolModeIndicator() {
    const toolMode = useRoomStore((s) => s.toolMode);
    const hasSelection = useRoomStore((s) => s.selectedAssetIds.length > 0);
    if (!hasSelection) return null;

    const labels: Record<string, string> = {
        translate: "Move (1)",
        rotate: "Rotate (2)",
        scale: "Scale (3)",
    };

    return (
        <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-semibold text-blue-700">
            {labels[toolMode] ?? toolMode}
        </span>
    );
}

// ─────────────── FX toggle (Stage 4 — SSAO + Bloom) ───────────────
function FxToggle() {
    const effectsEnabled = useRoomStore((s) => s.effectsEnabled);
    const toggleEffects = useRoomStore((s) => s.toggleEffects);
    return (
        <button
            onClick={toggleEffects}
            className={`hui-btn px-2 py-1 text-xs ${effectsEnabled ? "hui-btn-green" : "hui-btn-secondary"}`}
            title="Post-effects (ambient occlusion + bloom)"
        >
            FX
            {effectsEnabled && <span className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-emerald-300" aria-hidden />}
        </button>
    );
}

// ─────────────── HDRI picker (Stage 4 — lighting preset) ───────────────
// Reads from layout.lighting.hdriPreset and writes via setHdriPreset (which
// rides through setLayout → history → dirty → autosave). Closes on outside
// click, Escape, or selection.
function HdriPicker() {
    const layout = useRoomStore((s) => s.layout);
    const setHdriPreset = useRoomStore((s) => s.setHdriPreset);
    const preset: HdriPreset = layout.lighting?.hdriPreset ?? DEFAULT_PRESET;
    const currentLabel = HDRI_PRESETS[preset].label;

    const [open, setOpen] = useState(false);
    const wrapRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        function onDown(e: MouseEvent) {
            if (!wrapRef.current) return;
            if (!wrapRef.current.contains(e.target as Node)) setOpen(false);
        }
        function onKey(e: KeyboardEvent) {
            if (e.key === "Escape") setOpen(false);
        }
        document.addEventListener("mousedown", onDown);
        document.addEventListener("keydown", onKey);
        return () => {
            document.removeEventListener("mousedown", onDown);
            document.removeEventListener("keydown", onKey);
        };
    }, [open]);

    return (
        <div ref={wrapRef} className="relative">
            <button
                onClick={() => setOpen((v) => !v)}
                className="hui-btn hui-btn-secondary px-2 py-1 text-xs"
                title="Lighting preset"
            >
                Lighting: <span className="font-medium">{currentLabel}</span>{" "}
                <span className="ml-0.5 text-slate-400">▾</span>
            </button>
            {open && (
                <div className="absolute left-0 top-full z-20 mt-1 w-44 overflow-hidden rounded-md border border-slate-200 bg-white shadow-lg">
                    {HDRI_PRESET_ORDER.map((k) => {
                        const meta = HDRI_PRESETS[k];
                        const active = k === preset;
                        return (
                            <button
                                key={k}
                                onClick={() => {
                                    setHdriPreset(k);
                                    setOpen(false);
                                }}
                                className={`flex w-full items-center justify-between px-3 py-1.5 text-left text-xs transition ${
                                    active ? "bg-slate-900 text-white" : "bg-white text-slate-700 hover:bg-slate-50"
                                }`}
                            >
                                <span>{meta.label}</span>
                                {active && <span aria-hidden>✓</span>}
                            </button>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
