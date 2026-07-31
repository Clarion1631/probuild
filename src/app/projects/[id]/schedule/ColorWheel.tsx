"use client";

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";

export function hexToHsl(hex: string): { h: number; s: number; l: number } | null {
    const match = /^#([0-9a-f]{6})$/i.exec(hex.trim());
    if (!match) return null;
    const r = parseInt(match[1].slice(0, 2), 16) / 255;
    const g = parseInt(match[1].slice(2, 4), 16) / 255;
    const b = parseInt(match[1].slice(4, 6), 16) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return { h: 0, s: 0, l };
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h: number;
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
    else if (max === g) h = ((b - r) / d + 2) * 60;
    else h = ((r - g) / d + 4) * 60;
    return { h, s, l };
}

export function hslToHex(hue: number, s: number, l: number): string {
    const h = ((hue % 360) + 360) % 360;
    const f = (n: number) => {
        const k = (n + h / 30) % 12;
        const a = s * Math.min(l, 1 - l);
        const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
        return Math.round(c * 255).toString(16).padStart(2, "0");
    };
    return `#${f(0)}${f(8)}${f(4)}`;
}

export type ColorWheelProps = {
    /** Current hex color (#rrggbb). Syncs the wheel when it changes externally. */
    value: string;
    /** Fires on every drag movement — use for live preview only. */
    onChange?: (hex: string) => void;
    /** Fires once when the user releases the wheel or slider — save here. */
    onCommit: (hex: string) => void;
    disabled?: boolean;
};

/**
 * Hue/saturation wheel (angle = hue, distance from center = saturation) with a
 * lightness slider. Pure CSS gradients — no canvas, no dependencies.
 *
 * The wheel renders the true HSL plane at the current lightness: a conic hue
 * ring at l=50%, a uniform black/white veil shifting it to the current
 * lightness (HSL is linear in that blend), and a radial gray(l) fade for
 * saturation — so the pixel under the thumb is exactly the committed color.
 */
export default function ColorWheel({ value, onChange, onCommit, disabled }: ColorWheelProps) {
    const wheelRef = useRef<HTMLDivElement>(null);
    const isDraggingRef = useRef(false);
    // Last color sent to onCommit (or received via `value`) — used to skip
    // no-op commits when a gesture ends on the color it started from.
    const lastCommittedRef = useRef(value.trim().toLowerCase());
    const [hsl, setHsl] = useState(() => hexToHsl(value) ?? { h: 210, s: 0.8, l: 0.55 });

    useEffect(() => {
        lastCommittedRef.current = value.trim().toLowerCase();
        if (isDraggingRef.current) return;
        const parsed = hexToHsl(value);
        if (parsed) setHsl(parsed);
    }, [value]);

    function commit(next: { h: number; s: number; l: number }) {
        const hex = hslToHex(next.h, next.s, next.l);
        if (hex === lastCommittedRef.current) return;
        lastCommittedRef.current = hex;
        onCommit(hex);
    }

    function resetFromValue() {
        isDraggingRef.current = false;
        const parsed = hexToHsl(value);
        if (parsed) setHsl(parsed);
    }

    function updateFromPointer(event: ReactPointerEvent<HTMLDivElement>): { h: number; s: number; l: number } {
        const rect = wheelRef.current!.getBoundingClientRect();
        const radius = rect.width / 2;
        const dx = event.clientX - (rect.left + radius);
        const dy = event.clientY - (rect.top + radius);
        const h = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;
        const s = Math.min(1, Math.hypot(dx, dy) / radius);
        const next = { h, s, l: hsl.l };
        setHsl(next);
        onChange?.(hslToHex(next.h, next.s, next.l));
        return next;
    }

    function handleWheelPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
        if (disabled) return;
        event.preventDefault();
        isDraggingRef.current = true;
        try {
            event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
            // Capture can fail for already-released pointers — dragging still
            // works while the pointer stays over the wheel.
        }
        updateFromPointer(event);
    }

    function handleWheelPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
        if (!isDraggingRef.current) return;
        updateFromPointer(event);
    }

    function handleWheelPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
        if (!isDraggingRef.current) return;
        isDraggingRef.current = false;
        commit(updateFromPointer(event));
    }

    function handleWheelKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
        if (disabled) return;
        let next: { h: number; s: number; l: number } | null = null;
        if (event.key === "ArrowRight") next = { ...hsl, h: (hsl.h + 5) % 360 };
        else if (event.key === "ArrowLeft") next = { ...hsl, h: (hsl.h + 355) % 360 };
        else if (event.key === "ArrowUp") next = { ...hsl, s: Math.min(1, hsl.s + 0.05) };
        else if (event.key === "ArrowDown") next = { ...hsl, s: Math.max(0, hsl.s - 0.05) };
        if (!next) return;
        event.preventDefault();
        setHsl(next);
        onChange?.(hslToHex(next.h, next.s, next.l));
    }

    function handleWheelKeyUp(event: ReactKeyboardEvent<HTMLDivElement>) {
        if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) commit(hsl);
    }

    function handleLightnessChange(nextL: number) {
        const next = { ...hsl, l: nextL };
        setHsl(next);
        onChange?.(hslToHex(next.h, next.s, next.l));
    }

    const hex = hslToHex(hsl.h, hsl.s, hsl.l);
    const grayAtL = hslToHex(0, 0, hsl.l);
    const lightnessVeil = hsl.l < 0.5
        ? `rgba(0,0,0,${(1 - 2 * hsl.l).toFixed(3)})`
        : `rgba(255,255,255,${(2 * hsl.l - 1).toFixed(3)})`;
    const thumbAngle = hsl.h * Math.PI / 180;
    const thumbLeft = 50 + hsl.s * 50 * Math.cos(thumbAngle);
    const thumbTop = 50 + hsl.s * 50 * Math.sin(thumbAngle);

    return (
        <div className={disabled ? "pointer-events-none opacity-60" : ""}>
            <div
                ref={wheelRef}
                role="slider"
                aria-label="Hue and saturation wheel. Left and right arrows change hue, up and down change saturation."
                aria-valuemin={0}
                aria-valuemax={360}
                aria-valuenow={Math.round(hsl.h)}
                aria-valuetext={hex}
                aria-disabled={disabled || undefined}
                tabIndex={disabled ? undefined : 0}
                onPointerDown={handleWheelPointerDown}
                onPointerMove={handleWheelPointerMove}
                onPointerUp={handleWheelPointerUp}
                onPointerCancel={resetFromValue}
                onKeyDown={handleWheelKeyDown}
                onKeyUp={handleWheelKeyUp}
                className="relative mx-auto h-44 w-44 cursor-crosshair touch-none rounded-full ring-1 ring-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hui-primary focus-visible:ring-offset-2"
                style={{
                    background:
                        `radial-gradient(circle closest-side, ${grayAtL} 0%, ${grayAtL}00 100%), ` +
                        `linear-gradient(${lightnessVeil}, ${lightnessVeil}), ` +
                        "conic-gradient(from 90deg, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)",
                }}
            >
                <span
                    aria-hidden="true"
                    className="pointer-events-none absolute h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow ring-1 ring-black/20"
                    style={{ left: `${thumbLeft}%`, top: `${thumbTop}%`, backgroundColor: hex }}
                />
            </div>
            <div className="mt-3 flex items-center gap-2">
                <input
                    type="range"
                    min={0}
                    max={100}
                    value={Math.round(hsl.l * 100)}
                    aria-label="Lightness"
                    disabled={disabled}
                    onChange={event => handleLightnessChange(Number(event.target.value) / 100)}
                    onPointerUp={() => commit(hsl)}
                    onPointerCancel={resetFromValue}
                    onKeyUp={event => {
                        if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
                            commit(hsl);
                        }
                    }}
                    className="h-2 min-w-0 flex-1 cursor-pointer appearance-none rounded-full"
                    style={{ background: `linear-gradient(to right, #000, ${hslToHex(hsl.h, hsl.s, 0.5)}, #fff)` }}
                />
                <span className="flex items-center gap-1.5 rounded border border-hui-border px-1.5 py-0.5">
                    <span className="h-3.5 w-3.5 rounded-full ring-1 ring-black/10" style={{ backgroundColor: hex }} aria-hidden="true" />
                    <code className="text-[10px] text-hui-textMuted">{hex}</code>
                </span>
            </div>
        </div>
    );
}
