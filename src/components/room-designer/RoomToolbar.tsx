// Top bar — slim: left logo + room name + saved-label · center Save pill ·
// right Add-to-Estimate, Designer-Assistance, and an overflow menu carrying
// the lower-frequency actions (PNG/PDF/CSV/Share, Lighting, FX, Before/After).
// View controls (undo/redo, 2D/3D, presets, measure, screenshot) live in
// BottomDock now; Layers/Properties live in RightRail.

import { useRoomStore } from "./hooks/useRoomStore";
import { toast } from "sonner";
import { exportToProBuild } from "@/lib/room-designer/blueprint3d-adapter";
import { createEstimateFromRoomDesign } from "@/lib/actions";
import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
    DEFAULT_PRESET,
    HDRI_PRESETS,
    HDRI_PRESET_ORDER,
    type HdriPreset,
} from "@/lib/room-designer/hdri-presets";
import type { OwnerContext } from "@/lib/room-designer/owner-context";
import { buildShareUrl } from "@/lib/room-designer/share-url";
import type { RoomDesignerInitialShareState } from "./RoomDesignerClient";
import { ShareModal } from "./ShareModal";
import { PreviewModeToggle } from "./PreviewModeToggle";
import { useRoomExports } from "./hooks/useRoomExports";
import {
    Calculator,
    Cloud,
    Image as ImageIcon,
    FileText,
    FileSpreadsheet,
    Share2,
    Sparkles,
    MoreVertical,
    Sun,
} from "lucide-react";

interface RoomToolbarProps {
    roomName: string;
    ownerContext: OwnerContext;
    initialShareState: RoomDesignerInitialShareState;
}

export function RoomToolbar({ roomName, ownerContext, initialShareState }: RoomToolbarProps) {
    const dirty = useRoomStore((s) => s.dirty);
    const lastSavedAt = useRoomStore((s) => s.lastSavedAt);
    const getSnapshot = useRoomStore((s) => s.getSnapshot);
    const markSaved = useRoomStore((s) => s.markSaved);
    const roomId = useRoomStore((s) => s.roomId);
    const showAssistant = useRoomStore((s) => s.showAssistant);
    const setShowAssistant = useRoomStore((s) => s.setShowAssistant);

    const [saving, setSaving] = useState(false);
    const [shareEnabled, setShareEnabled] = useState(initialShareState.enabled);
    const [shareUrl, setShareUrl] = useState<string | null>(
        initialShareState.token ? buildShareUrl(initialShareState.token) : null,
    );
    const [shareOpen, setShareOpen] = useState(false);
    const shareBtnRef = useRef<HTMLButtonElement | null>(null);
    const [menuOpen, setMenuOpen] = useState(false);
    const menuRef = useRef<HTMLDivElement>(null);

    const router = useRouter();
    const pathname = usePathname();

    const { exportPng, exportPdf, exportCsv, exportingPng, exportingPdf } = useRoomExports({
        ownerContext,
        roomName,
    });

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

    // Ctrl+S force-save bridge — useAssetSelection dispatches this so the key
    // handler doesn't need to reach into the toolbar's local state.
    useEffect(() => {
        function onForceSave() {
            saveNow();
        }
        window.addEventListener("room-designer:force-save", onForceSave);
        return () => window.removeEventListener("room-designer:force-save", onForceSave);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Close overflow menu on outside-click or Escape.
    useEffect(() => {
        if (!menuOpen) return;
        function onDown(e: MouseEvent) {
            if (!menuRef.current) return;
            if (!menuRef.current.contains(e.target as Node)) setMenuOpen(false);
        }
        function onKey(e: KeyboardEvent) {
            if (e.key === "Escape") setMenuOpen(false);
        }
        document.addEventListener("mousedown", onDown);
        document.addEventListener("keydown", onKey);
        return () => {
            document.removeEventListener("mousedown", onDown);
            document.removeEventListener("keydown", onKey);
        };
    }, [menuOpen]);

    async function gotoEstimate() {
        if (!roomId) {
            toast.error("No active room found.");
            return;
        }

        const promise = (async () => {
            const result = await createEstimateFromRoomDesign(roomId);
            if (!result || !result.success || !result.redirectUrl) {
                throw new Error("Failed to create estimate");
            }
            router.push(result.redirectUrl);
            return result;
        })();

        toast.promise(promise, {
            loading: "Generating detailed takeoff & creating draft estimate...",
            success: "Takeoff successful! Redirecting to estimate...",
            error: "Failed to generate material estimate takeoff.",
        });
    }

    function showAssistanceStub() {
        toast.message("Designer Assistance coming soon", {
            description: "Conversational design help is on the roadmap.",
        });
    }

    const savedLabel = dirty
        ? "Unsaved changes"
        : lastSavedAt
            ? `Saved ${timeAgo(lastSavedAt)}`
            : "Saved";

    return (
        <div className="flex items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 py-2">
            {/* Left — brand + room context */}
            <div className="flex items-center gap-3">
                <span className="flex h-7 w-7 items-center justify-center rounded-md bg-[#531b7e] text-sm font-bold text-white">
                    P
                </span>
                <div className="flex flex-col leading-tight">
                    <h1 className="truncate text-sm font-semibold text-slate-900">{roomName}</h1>
                    <span className={`text-[10px] ${dirty ? "text-amber-600" : "text-slate-400"}`}>{savedLabel}</span>
                </div>
            </div>

            {/* Center — Save pill */}
            <div className="flex items-center">
                <button
                    type="button"
                    onClick={saveNow}
                    disabled={saving || !dirty}
                    className={`rounded-full px-4 py-1.5 text-xs font-bold transition flex items-center shadow-sm duration-200 ${
                        dirty 
                            ? "bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100 hover:border-emerald-300"
                            : "bg-slate-50 text-slate-400 border border-slate-200 cursor-not-allowed"
                    }`}
                >
                    <Cloud className="mr-1.5 h-3.5 w-3.5" />
                    {saving ? "Saving…" : dirty ? "Save" : "All changes saved"}
                </button>
            </div>

            {/* Right — Estimate / Assistance / overflow */}
            <div className="flex items-center gap-2">
                <button
                    type="button"
                    onClick={gotoEstimate}
                    className="bg-[#531b7e] text-white hover:bg-[#431466] active:scale-95 rounded-full px-5 py-2 text-xs font-bold transition-all duration-200 flex items-center shadow-sm"
                >
                    <Calculator className="mr-1.5 h-3.5 w-3.5" />
                    Add to Estimate
                </button>
                <button
                    type="button"
                    onClick={() => setShowAssistant(!showAssistant)}
                    className={`border transition-all duration-200 flex items-center shadow-sm rounded-full px-5 py-2 text-xs font-bold active:scale-95 ${
                        showAssistant
                            ? "bg-[#531b7e] text-white border-transparent hover:bg-[#431466]"
                            : "border-[#531b7e] text-[#531b7e] hover:bg-purple-50"
                    }`}
                >
                    <Sparkles className="mr-1.5 h-3.5 w-3.5" />
                    Designer Assistance
                </button>

                <div ref={menuRef} className="relative">
                    <button
                        ref={shareBtnRef}
                        type="button"
                        onClick={() => setMenuOpen((v) => !v)}
                        aria-label="More actions"
                        aria-haspopup="menu"
                        aria-expanded={menuOpen}
                        className="hui-btn hui-btn-secondary rounded-full p-1.5"
                    >
                        <MoreVertical className="h-4 w-4" />
                    </button>
                    {menuOpen && (
                        <div
                            role="menu"
                            className="absolute right-0 top-full z-30 mt-1 w-56 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-lg"
                        >
                            <MenuButton
                                icon={<ImageIcon className="h-3.5 w-3.5" />}
                                label={exportingPng ? "Exporting…" : "Export image (PNG)"}
                                disabled={exportingPng}
                                onClick={() => { exportPng(); setMenuOpen(false); }}
                            />
                            <MenuButton
                                icon={<FileText className="h-3.5 w-3.5" />}
                                label={exportingPdf ? "Exporting…" : "Export PDF"}
                                disabled={exportingPdf}
                                onClick={() => { exportPdf(); setMenuOpen(false); }}
                            />
                            <MenuButton
                                icon={<FileSpreadsheet className="h-3.5 w-3.5" />}
                                label="Materials list (CSV)"
                                onClick={() => { exportCsv(); setMenuOpen(false); }}
                            />
                            <MenuButton
                                icon={<Share2 className="h-3.5 w-3.5" />}
                                label={shareEnabled ? "Share link (enabled)" : "Share with a client"}
                                onClick={() => {
                                    setShareOpen(true);
                                    setMenuOpen(false);
                                }}
                                trailing={
                                    shareEnabled ? (
                                        <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden />
                                    ) : null
                                }
                            />
                            <div className="my-1 border-t border-slate-100" />
                            <div className="px-3 py-2">
                                <HdriPicker />
                            </div>
                            <div className="px-3 py-2">
                                <FxToggle />
                            </div>
                            <div className="px-3 py-2">
                                <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-slate-400">Preview</span>
                                <PreviewModeToggle />
                            </div>
                        </div>
                    )}
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

interface MenuButtonProps {
    icon: React.ReactNode;
    label: string;
    disabled?: boolean;
    onClick: () => void;
    trailing?: React.ReactNode;
}

function MenuButton({ icon, label, disabled, onClick, trailing }: MenuButtonProps) {
    return (
        <button
            type="button"
            role="menuitem"
            disabled={disabled}
            onClick={onClick}
            className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-xs text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
            <span className="flex items-center gap-2">
                <span className="text-slate-500">{icon}</span>
                {label}
            </span>
            {trailing}
        </button>
    );
}

function FxToggle() {
    const effectsEnabled = useRoomStore((s) => s.effectsEnabled);
    const toggleEffects = useRoomStore((s) => s.toggleEffects);
    return (
        <button
            type="button"
            onClick={toggleEffects}
            className="flex w-full items-center justify-between text-xs text-slate-700"
        >
            <span className="flex items-center gap-2">
                <Sparkles className="h-3.5 w-3.5 text-slate-500" />
                Post-effects (SSAO + Bloom)
            </span>
            <span
                className={`inline-flex h-4 w-7 items-center rounded-full px-0.5 transition-colors ${
                    effectsEnabled ? "bg-[#531b7e]" : "bg-slate-300"
                }`}
                aria-hidden
            >
                <span
                    className={`h-3 w-3 rounded-full bg-white transition-transform ${
                        effectsEnabled ? "translate-x-3" : "translate-x-0"
                    }`}
                />
            </span>
        </button>
    );
}

function HdriPicker() {
    const layout = useRoomStore((s) => s.layout);
    const setHdriPreset = useRoomStore((s) => s.setHdriPreset);
    const preset: HdriPreset = layout.lighting?.hdriPreset ?? DEFAULT_PRESET;

    return (
        <div className="flex flex-col gap-1">
            <span className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                <Sun className="h-3 w-3" /> Lighting
            </span>
            <div className="grid grid-cols-2 gap-1">
                {HDRI_PRESET_ORDER.map((k) => {
                    const meta = HDRI_PRESETS[k];
                    const active = k === preset;
                    return (
                        <button
                            key={k}
                            type="button"
                            onClick={() => setHdriPreset(k)}
                            className={
                                "rounded border px-2 py-1 text-left text-[10px] font-medium transition " +
                                (active
                                    ? "border-[#531b7e] bg-purple-50 text-[#531b7e]"
                                    : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50")
                            }
                        >
                            {meta.label}
                        </button>
                    );
                })}
            </div>
        </div>
    );
}
