// Shared export handlers (PNG / PDF / CSV) for the room designer. Pulled out
// of RoomToolbar so the bottom dock and overflow menu can both trigger them
// without duplicating the canvas-ref / branding plumbing.
//
// The hook is consumed by *two* mounted components (RoomToolbar overflow +
// BottomDock screenshot), so each call site has its own `exportingPng/Pdf`
// state. To prevent concurrent runs from clobbering the shared WebGL
// renderer state mid-await (renderRoomPng/Pdf save/restore around an
// async `toBlob` boundary), the actual PNG/PDF entry points sit behind
// module-scope re-entry guards.

import { useState } from "react";
import { toast } from "sonner";
import {
    downloadBlob,
    renderRoomPng,
    slugifyForFilename,
} from "@/lib/room-designer/export-png";
import { renderRoomPdf } from "@/lib/room-designer/export-pdf";
import { buildMaterialsCsv } from "@/lib/room-designer/export-csv";
import type { OwnerContext } from "@/lib/room-designer/owner-context";
import { useRoomStore } from "./useRoomStore";

let pngBusy = false;
let pdfBusy = false;

interface UseRoomExportsArgs {
    ownerContext: OwnerContext;
    roomName: string;
}

export function useRoomExports({ ownerContext, roomName }: UseRoomExportsArgs) {
    const [exportingPng, setExportingPng] = useState(false);
    const [exportingPdf, setExportingPdf] = useState(false);

    async function exportPng() {
        if (pngBusy) {
            toast.message("An image export is already running");
            return;
        }
        const refs = useRoomStore.getState().canvasRefs;
        if (!refs) {
            toast.error("Canvas isn't ready yet — try again in a moment.");
            return;
        }
        pngBusy = true;
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
            pngBusy = false;
            setExportingPng(false);
        }
    }

    async function exportPdf() {
        if (pdfBusy) {
            toast.message("A PDF export is already running");
            return;
        }
        const state = useRoomStore.getState();
        const refs = state.canvasRefs;
        if (!refs) {
            toast.error("Canvas isn't ready yet — try again in a moment.");
            return;
        }
        pdfBusy = true;
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
            pdfBusy = false;
            setExportingPdf(false);
        }
    }

    function exportCsv() {
        const state = useRoomStore.getState();
        try {
            const csv = buildMaterialsCsv(state.assets);
            // Prepend UTF-8 BOM so Excel opens accented characters correctly.
            const blob = new Blob(["﻿", csv], { type: "text/csv;charset=utf-8" });
            const filename = `${slugifyForFilename(ownerContext.ownerName)}-${slugifyForFilename(roomName)}-materials.csv`;
            downloadBlob(blob, filename);
            toast.success("Materials list exported");
        } catch (err) {
            toast.error("CSV export failed");
            // eslint-disable-next-line no-console
            console.error(err);
        }
    }

    return { exportPng, exportPdf, exportCsv, exportingPng, exportingPdf };
}
