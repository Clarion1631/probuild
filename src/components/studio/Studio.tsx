"use client";

// Room Studio - root component. Owns load/autosave, keyboard shortcuts, and
// the panel layout around the canvas.

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { DesignDoc } from "@/lib/studio/doc";
import { toApiPayload } from "@/lib/studio/doc";
import { removeCornerFromPolygon } from "@/lib/studio/geometry";
import { useStudio } from "./store";
import { StudioCanvas } from "./canvas/StudioCanvas";
import { CatalogPanel } from "./panels/CatalogPanel";
import { Inspector } from "./panels/Inspector";
import { TopBar } from "./TopBar";
import { ShareDialog, type ShareState } from "./ShareDialog";
import { captureThumbnail } from "./snapshot";

const AUTOSAVE_MS = 2_500;
const THUMB_EVERY_MS = 45_000;

export interface StudioProps {
  roomId: string;
  roomName: string;
  initialDoc: DesignDoc;
  backHref: string;
  initialShare: ShareState;
}

export function Studio({ roomId, roomName, initialDoc, backHref, initialShare }: StudioProps) {
  const loadDoc = useStudio((s) => s.loadDoc);
  const presentMode = useStudio((s) => s.presentMode);
  const [shareOpen, setShareOpen] = useState(false);
  const [share, setShare] = useState<ShareState>(initialShare);

  // Load once per room.
  useEffect(() => {
    loadDoc(initialDoc);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);

  useAutosave(roomId);
  useKeyboardShortcuts();

  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden bg-slate-100">
      <TopBar roomName={roomName} backHref={backHref} onShare={() => setShareOpen(true)} />
      <div className="flex min-h-0 flex-1">
        {!presentMode && <CatalogPanel />}
        <div className="relative min-w-0 flex-1">
          <StudioCanvas />
          {!presentMode && <HintBar />}
        </div>
        {!presentMode && <Inspector />}
      </div>
      {shareOpen && (
        <ShareDialog
          roomId={roomId}
          share={share}
          onChange={setShare}
          onClose={() => setShareOpen(false)}
        />
      )}
    </div>
  );
}

function HintBar() {
  const selectedId = useStudio((s) => s.selectedId);
  const placing = useStudio((s) => s.placing);
  const view = useStudio((s) => s.view);

  let hint: string;
  if (placing) hint = "Click to place - Shift keeps placing - Esc cancels";
  else if (selectedId) hint = "Drag to move - blue dot spins - R rotates 90 - Ctrl+D duplicates - Del removes";
  else if (view === "walk") hint = "Drag to look around - W A S D to walk";
  else if (view === "plan") hint = "Drag blue dots to reshape (they snap square) - click a corner or wall for more options - double-click a wall dot adds a corner";
  else hint = "Drag to orbit - right-drag to pan - scroll to zoom - click walls or floor to change colors";

  return (
    <div className="pointer-events-none absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-full bg-slate-900/75 px-4 py-1.5 text-[11px] font-medium text-white shadow-lg backdrop-blur">
      {hint}
    </div>
  );
}

// ---------------------------------------------------------------------------

function useAutosave(roomId: string) {
  const dirty = useStudio((s) => s.dirty);
  const dragging = useStudio((s) => s.dragging);
  const docRev = useStudio((s) => s.docRev);
  // Bumped after a failed save so the effect re-arms a retry even when no new
  // edits arrive (dirty/docRev alone wouldn't change).
  const [retryTick, setRetryTick] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inflight = useRef(false);
  const lastThumb = useRef(0);

  useEffect(() => {
    if (!dirty || dragging) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      if (inflight.current) return;
      inflight.current = true;
      const s = useStudio.getState();
      const savedRev = s.docRev;
      s.markSaving();
      try {
        const payload: Record<string, unknown> = toApiPayload(s.doc);
        const now = Date.now();
        if (now - lastThumb.current > THUMB_EVERY_MS) {
          const thumb = captureThumbnail(560);
          if (thumb) {
            payload.thumbnail = thumb;
            lastThumb.current = now;
          }
        }
        const res = await fetch(`/api/rooms/${roomId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error(String(res.status));
        // Only clears dirty if no edits landed while the request was in
        // flight; otherwise saveState returns to "unsaved" and the effect
        // below re-arms because docRev changed.
        useStudio.getState().markSaved(savedRev);
      } catch {
        useStudio.getState().markSaveError();
        setRetryTick((t) => t + 1); // re-arm a retry after the debounce period
      } finally {
        inflight.current = false;
      }
    }, AUTOSAVE_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [dirty, dragging, roomId, docRev, retryTick]);

  // Flush pending edits whenever the page goes away: tab close (pagehide /
  // beforeunload), tab background (visibilitychange on document - it does not
  // reliably reach window listeners), and client-side route changes (unmount).
  useEffect(() => {
    const flush = () => {
      const s = useStudio.getState();
      if (!s.dirty) return;
      try {
        const body = JSON.stringify(toApiPayload(s.doc));
        fetch(`/api/rooms/${roomId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body,
          keepalive: true,
        }).catch(() => undefined);
      } catch {
        // page is going away; nothing to surface
      }
    };
    const onVis = () => {
      if (document.visibilityState === "hidden") flush();
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", flush);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("beforeunload", flush);
      flush(); // App Router navigation unmounts without any page event
    };
  }, [roomId]);
}

function useKeyboardShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      const s = useStudio.getState();

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) s.redo();
        else s.undo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        s.redo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "d") {
        if (s.selectedId) {
          e.preventDefault();
          s.duplicateItem(s.selectedId);
        }
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        if (s.selectedId) {
          e.preventDefault();
          s.removeItem(s.selectedId);
        } else if (s.activeSurface?.kind === "corner") {
          e.preventDefault();
          const next = removeCornerFromPolygon(s.doc.room.points, s.activeSurface.index);
          if (next) {
            s.setRoomShape({
              ...s.doc.room,
              points: next,
              slope: next.length === 4 ? s.doc.room.slope : undefined,
            });
            s.setActiveSurface(null);
            toast.success("Corner removed - Ctrl+Z to undo");
          } else {
            toast.error("This corner can't be removed - the room would collapse");
          }
        }
        return;
      }
      if (e.key.toLowerCase() === "r" && !e.ctrlKey && !e.metaKey) {
        if (s.selectedId) {
          const item = s.doc.items.find((it) => it.id === s.selectedId);
          if (item) s.updateItem(item.id, { rotation: item.rotation + Math.PI / 2 });
        }
        return;
      }
      if (e.key === "Escape") {
        if (s.placing) s.setPlacing(null);
        else if (s.presentMode) s.setPresentMode(false);
        else {
          s.select(null);
          s.setActiveSurface(null);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
