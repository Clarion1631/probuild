"use client";

// Public share viewer. Read-only 3D canvas with orbit/pan/zoom, plus a top
// chrome bar hosting contractor branding and the two actions clients can
// take — Request Changes (email the manager) and Download PDF.
//
// We hydrate the editor's Zustand store with the shared snapshot so we can
// reuse Floor / Walls / Ceiling / AssetNode / HdriEnvironment / WindowLights
// without duplicating them. The interactive hooks (useAssetSelection,
// useRoomSave, useUndoRedoKeyboard) are NOT mounted — that's what keeps this
// a viewer instead of an editor.

import * as THREE from "three";
import { Canvas, useThree } from "@react-three/fiber";
import { OrbitControls, PerspectiveCamera } from "@react-three/drei";
import { Suspense, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Floor } from "@/components/room-designer/canvas/Floor";
import { Walls } from "@/components/room-designer/canvas/Walls";
import { Ceiling } from "@/components/room-designer/canvas/Ceiling";
import { AssetNode } from "@/components/room-designer/canvas/AssetNode";
import { WindowLights } from "@/components/room-designer/canvas/WindowLights";
import { HdriEnvironment } from "@/components/room-designer/HdriEnvironment";
import { useRoomStore } from "@/components/room-designer/hooks/useRoomStore";
import { DEFAULT_PRESET } from "@/lib/room-designer/hdri-presets";
import type { PlacedAsset, RoomSnapshot } from "@/components/room-designer/types";
import { renderRoomPdf } from "@/lib/room-designer/export-pdf";
import {
    downloadBlob,
    slugifyForFilename,
} from "@/lib/room-designer/export-png";
import { ShareRequestChangesModal } from "./ShareRequestChangesModal";

export interface ShareViewerData {
    snapshot: RoomSnapshot;
    roomName: string;
    token: string;
    owner: { name: string; address: string | null };
    contractor: { name: string; logoUrl: string | null; address: string | null };
}

export function ShareViewer({ data }: { data: ShareViewerData }) {
    const loadSnapshot = useRoomStore((s) => s.loadSnapshot);

    // One-time hydrate. We deliberately depend only on roomId so reopening
    // the same page doesn't blow away any user-initiated camera drift.
    useEffect(() => {
        loadSnapshot(data.snapshot);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [data.snapshot.roomId]);

    const [modalOpen, setModalOpen] = useState(false);
    const [exportingPdf, setExportingPdf] = useState(false);

    async function handlePdf() {
        const state = useRoomStore.getState();
        const refs = state.canvasRefs;
        if (!refs) {
            toast.error("3D view isn't ready yet — try again in a moment.");
            return;
        }
        setExportingPdf(true);
        try {
            const blob = await renderRoomPdf(
                { gl: refs.gl, scene: refs.scene, liveCamera: refs.camera, layout: state.layout },
                {
                    contractorName: data.contractor.name,
                    contractorLogoUrl: data.contractor.logoUrl,
                    contractorAddress: data.contractor.address,
                    ownerName: data.owner.name,
                    ownerAddress: data.owner.address,
                },
                { roomName: data.roomName },
                state.assets,
            );
            const filename = `${slugifyForFilename(data.owner.name)}-${slugifyForFilename(data.roomName)}.pdf`;
            downloadBlob(blob, filename);
        } catch (err) {
            toast.error("Couldn't build PDF. Please try again.");
            // eslint-disable-next-line no-console
            console.error(err);
        } finally {
            setExportingPdf(false);
        }
    }

    return (
        <div className="flex h-dvh w-full flex-col bg-slate-50" style={{ touchAction: "none" }}>
            <ShareHeader
                contractor={data.contractor}
                owner={data.owner}
                roomName={data.roomName}
                onRequestChanges={() => setModalOpen(true)}
                onDownloadPdf={handlePdf}
                downloadingPdf={exportingPdf}
            />

            <div className="relative min-h-0 flex-1">
                <ShareCanvas />
            </div>

            {modalOpen && (
                <ShareRequestChangesModal
                    roomId={data.snapshot.roomId}
                    token={data.token}
                    onClose={() => setModalOpen(false)}
                />
            )}
        </div>
    );
}

// ─────────────── Header chrome ───────────────
function ShareHeader({
    contractor,
    owner,
    roomName,
    onRequestChanges,
    onDownloadPdf,
    downloadingPdf,
}: {
    contractor: ShareViewerData["contractor"];
    owner: ShareViewerData["owner"];
    roomName: string;
    onRequestChanges: () => void;
    onDownloadPdf: () => void;
    downloadingPdf: boolean;
}) {
    return (
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 py-2">
            <div className="flex min-w-0 items-center gap-3">
                {contractor.logoUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                        src={contractor.logoUrl}
                        alt={contractor.name}
                        className="h-8 w-8 shrink-0 rounded object-contain"
                    />
                ) : null}
                <div className="min-w-0">
                    <div className="truncate text-sm font-semibold text-slate-900">
                        {contractor.name}
                    </div>
                    {contractor.address ? (
                        <div className="truncate text-xs text-slate-500">{contractor.address}</div>
                    ) : null}
                </div>
            </div>
            <div className="hidden min-w-0 flex-1 items-center justify-center text-center md:flex">
                <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-slate-800">
                        {owner.name} — {roomName}
                    </div>
                    {owner.address ? (
                        <div className="truncate text-xs text-slate-500">{owner.address}</div>
                    ) : null}
                </div>
            </div>
            <div className="flex items-center gap-2">
                <button
                    onClick={onRequestChanges}
                    className="hui-btn hui-btn-secondary px-3 py-1.5 text-xs"
                >
                    Request changes
                </button>
                <button
                    onClick={onDownloadPdf}
                    disabled={downloadingPdf}
                    className="hui-btn hui-btn-green px-3 py-1.5 text-xs disabled:opacity-60"
                >
                    {downloadingPdf ? "Preparing…" : "Download PDF"}
                </button>
            </div>
        </header>
    );
}

// ─────────────── R3F canvas ───────────────
function ShareCanvas() {
    const layout = useRoomStore((s) => s.layout);
    const hdriPreset = layout.lighting?.hdriPreset ?? DEFAULT_PRESET;

    // Initial camera placement — same logic CameraRig uses for the editor's
    // default pose, but without the 2D/3D switcher.
    const cameraTarget = useMemo<[number, number, number]>(
        () => [0, layout.dimensions.height / 2, 0],
        [layout.dimensions.height],
    );
    const cameraPosition = useMemo<[number, number, number]>(
        () => [
            layout.dimensions.width,
            layout.dimensions.height * 1.5,
            layout.dimensions.length,
        ],
        [layout.dimensions.width, layout.dimensions.height, layout.dimensions.length],
    );

    return (
        <Canvas
            shadows
            dpr={[1, 2]}
            gl={{
                antialias: true,
                preserveDrawingBuffer: true,
                toneMapping: THREE.ACESFilmicToneMapping,
                toneMappingExposure: 1.0,
            }}
        >
            <SceneRefBridge />
            <PerspectiveCamera makeDefault position={cameraPosition} fov={45} near={0.1} far={100} />
            <OrbitControls
                target={cameraTarget}
                enablePan
                enableRotate
                enableZoom
                dampingFactor={0.1}
                maxPolarAngle={Math.PI / 2 - 0.01}
                minDistance={1}
                maxDistance={20}
            />

            <Suspense fallback={null}>
                <HdriEnvironment preset={hdriPreset} />
                <WindowLights preset={hdriPreset} />
            </Suspense>
            <ambientLight intensity={0.18} />
            <directionalLight
                position={[layout.dimensions.width, layout.dimensions.height * 2, layout.dimensions.length]}
                intensity={0.22}
                castShadow={false}
            />

            <Floor layout={layout} />
            <Walls layout={layout} />
            <Ceiling layout={layout} visible />

            <SceneAssets />
        </Canvas>
    );
}

function SceneAssets() {
    const assets = useRoomStore((s) => s.assets);
    return (
        <>
            {assets.map((asset: PlacedAsset) => (
                // selected=false locks out editor-only affordances; onSelect
                // is a no-op so a client click doesn't inadvertently mutate
                // the store.
                <AssetNode
                    key={asset.id}
                    asset={asset}
                    selected={false}
                    isPrimary={false}
                    onSelect={() => {}}
                />
            ))}
        </>
    );
}

// Publish the live renderer/scene/camera to the store so the share viewer's
// "Download PDF" button can reuse the same renderRoomPdf pipeline the editor
// uses. Mirrors the SceneRefBridge in RoomCanvas.
function SceneRefBridge() {
    const { gl, scene, camera } = useThree();
    const setCanvasRefs = useRoomStore((s) => s.setCanvasRefs);
    useEffect(() => {
        setCanvasRefs({ gl, scene, camera });
        return () => setCanvasRefs(null);
    }, [gl, scene, camera, setCanvasRefs]);
    return null;
}
