"use client";

// Room Studio - Draw walls tool (Plan view). First click sets the start, the
// preview follows the cursor with a live length, the next click commits ONE
// wall item (one undo step) and chains from its end. Preview state lives in
// component state/refs only - the store is written once per committed wall.

import * as THREE from "three";
import { useMemo, useRef, useEffect, useState, useCallback } from "react";
import type { ThreeEvent } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import { toast } from "sonner";
import type { DesignDoc, Pt } from "@/lib/studio/doc";
import { getItemDef } from "@/lib/studio/catalog";
import { inches, formatFtIn } from "@/lib/studio/units";
import { parseLength, snapDrawPoint, drawAnchors, lengthKeyEdit } from "@/lib/studio/walls";
import { useStudio } from "../store";
import { resolveItem } from "./Items";

const MIN_LEN = inches(4);
const MAX_TYPED = inches(288);
const CLICK_SLOP_PX = 5;
const PREVIEW_Y = 0.05;

export function DrawWalls({ doc }: { doc: DesignDoc }) {
  const drawing = useStudio((s) => s.drawingWalls);
  const view = useStudio((s) => s.view);
  const presentMode = useStudio((s) => s.presentMode);
  if (!drawing || view !== "plan" || presentMode) return null;
  return <DrawWallsInner doc={doc} />;
}

function DrawWallsInner({ doc }: { doc: DesignDoc }) {
  const kind = useStudio((s) => s.drawWallKind);
  const addWall = useStudio((s) => s.addWall);
  const setDrawingWalls = useStudio((s) => s.setDrawingWalls);

  const [start, setStart] = useState<Pt | null>(null);
  const [cursor, setCursor] = useState<Pt | null>(null);
  const [typing, setTyping] = useState<string | null>(null);
  const startRef = useRef(start);
  const cursorRef = useRef(cursor);
  const typingRef = useRef(typing);
  const shiftRef = useRef(false);
  const applyTypedRef = useRef<(text: string) => void>(() => {});
  useEffect(() => {
    startRef.current = start;
    cursorRef.current = cursor;
  }, [start, cursor]);
  /** Set the typed-length text; the ref updates synchronously so keys that
      arrive before React re-renders (fast typing) are never lost. */
  const setTypingText = useCallback((next: string | null) => {
    typingRef.current = next;
    setTyping(next);
  }, []);

  const anchors = useMemo(
    () => drawAnchors(doc.room.points, doc.items, (it) => resolveItem(it)?.w ?? 0),
    [doc.room.points, doc.items],
  );
  const thickness = getItemDef(kind === "pony" ? "pony-wall" : "interior-wall")?.d ?? inches(4.5);

  const snap = useCallback(
    (raw: Pt): Pt => snapDrawPoint(raw, startRef.current, { anchors, angleSnap: !shiftRef.current }),
    [anchors],
  );

  const endChain = useCallback(() => {
    setStart(null);
    setCursor(null);
    setTypingText(null);
  }, [setTypingText]);

  // Esc ends the chain; Esc with no chain leaves draw mode. Digits open the length box.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      // Length box is open but not focused yet: collect the keys here.
      if (typingRef.current !== null && startRef.current && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const r = lengthKeyEdit(typingRef.current, e.key);
        if (r.action === "submit") {
          e.preventDefault();
          applyTypedRef.current(typingRef.current);
          return;
        }
        if (r.action === "cancel") {
          e.preventDefault();
          setTypingText(null);
          return;
        }
        if (r.text !== typingRef.current || e.key === "Backspace") {
          e.preventDefault();
          setTypingText(r.text);
          return;
        }
      }
      if (e.key === "Escape") {
        if (startRef.current) endChain();
        else setDrawingWalls(false);
        return;
      }
      if (startRef.current && typingRef.current === null && !e.ctrlKey && !e.metaKey && !e.altKey && /^[0-9.]$/.test(e.key)) {
        e.preventDefault();
        setTypingText(e.key);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [endChain, setDrawingWalls, setTypingText]);

  const commit = (a: Pt, b: Pt) => {
    if (Math.hypot(b.x - a.x, b.z - a.z) < MIN_LEN) return false;
    addWall(a, b, kind);
    setStart(b);
    setCursor(b);
    return true;
  };

  const onMove = (e: ThreeEvent<PointerEvent>) => {
    shiftRef.current = e.nativeEvent.shiftKey;
    setCursor(snap({ x: e.point.x, z: e.point.z }));
  };

  const onClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    if (e.delta > CLICK_SLOP_PX) return; // was a pan, not a click
    shiftRef.current = e.nativeEvent.shiftKey;
    const p = snap({ x: e.point.x, z: e.point.z });
    const s = startRef.current;
    if (!s) {
      setStart(p);
      setCursor(p);
      return;
    }
    commit(s, p);
  };

  const applyTyped = (text: string) => {
    const s = startRef.current;
    if (!s) return;
    const len = parseLength(text);
    if (len === null) {
      toast.error("Type a length like 54, 4'6\" or 10'");
      return;
    }
    if (len < MIN_LEN || len > MAX_TYPED) {
      toast.error(`Walls run from ${formatFtIn(MIN_LEN)} to ${formatFtIn(MAX_TYPED)}`);
      return;
    }
    const c = cursorRef.current ?? s;
    let dx = c.x - s.x;
    let dz = c.z - s.z;
    const d = Math.hypot(dx, dz);
    if (d < 1e-6) {
      dx = 1;
      dz = 0;
    } else {
      dx /= d;
      dz /= d;
    }
    setTypingText(null);
    commit(s, { x: s.x + dx * len, z: s.z + dz * len });
  };

  useEffect(() => {
    applyTypedRef.current = applyTyped;
  });

  const a = start;
  const b = cursor;
  const len = a && b ? Math.hypot(b.x - a.x, b.z - a.z) : 0;
  const mid = a && b ? { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 } : null;
  const rot = a && b ? Math.atan2(-(b.z - a.z), b.x - a.x) : 0;
  const hasSegment = !!(a && b && mid && len > 0.005);

  return (
    <group>
      {/* capture plane spanning the whole scene at floor level */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, 0.001, 0]}
        onPointerMove={onMove}
        onClick={onClick}
        onContextMenu={(e) => {
          e.stopPropagation();
          e.nativeEvent.preventDefault();
          endChain();
        }}
      >
        <planeGeometry args={[80, 80]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>

      {a && (
        <mesh position={[a.x, PREVIEW_Y, a.z]} raycast={() => null}>
          <cylinderGeometry args={[0.05, 0.05, 0.02, 18]} />
          <meshBasicMaterial color="#2563eb" depthTest={false} />
        </mesh>
      )}
      {b && (
        <mesh position={[b.x, PREVIEW_Y, b.z]} raycast={() => null}>
          <cylinderGeometry args={[0.04, 0.04, 0.02, 18]} />
          <meshBasicMaterial color="#2563eb" depthTest={false} />
        </mesh>
      )}
      {hasSegment && a && b && mid && (
        <mesh position={[mid.x, PREVIEW_Y, mid.z]} rotation={[0, rot, 0]} raycast={() => null}>
          <boxGeometry args={[len, 0.02, thickness]} />
          <meshBasicMaterial color="#2563eb" transparent opacity={0.45} depthTest={false} side={THREE.DoubleSide} />
        </mesh>
      )}
      {/* live length label, or the typed-length box */}
      {a && (hasSegment || typing !== null) && (
        <Html position={[mid && hasSegment ? mid.x : a.x, PREVIEW_Y, mid && hasSegment ? mid.z : a.z]} center zIndexRange={[30, 0]}>
          {typing === null ? (
            <div
              style={{
                background: "rgba(15,23,42,0.85)",
                color: "#fff",
                padding: "2px 8px",
                borderRadius: 6,
                fontSize: 12,
                fontFamily: "system-ui, sans-serif",
                whiteSpace: "nowrap",
                pointerEvents: "none",
                transform: "translateY(-18px)",
              }}
            >
              {formatFtIn(len)}
            </div>
          ) : (
            <LengthBox text={typing} setText={setTypingText} onSubmit={applyTyped} onCancel={() => setTypingText(null)} />
          )}
        </Html>
      )}
    </group>
  );
}

function LengthBox({ text, setText, onSubmit, onCancel }: {
  text: string;
  setText: (t: string) => void;
  onSubmit: (text: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const focused = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    focused.current = true;
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  return (
    <label
      className="flex items-center gap-1.5 rounded-md border border-blue-400 bg-white px-2 py-1 shadow-lg"
      style={{ transform: "translateY(-22px)" }}
    >
      <span className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Length</span>
      <input
        ref={ref}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") onSubmit(text);
          else if (e.key === "Escape") onCancel();
        }}
        onBlur={() => {
          // ignore any blur before the box has ever held focus
          if (focused.current) onCancel();
        }}
        placeholder={"4'6\""}
        className="w-20 text-right text-xs text-slate-800 outline-none"
      />
    </label>
  );
}
