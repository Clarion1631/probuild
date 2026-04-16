"use client";

// 4-step "first run" coach. Only runs when:
//   - the current room is empty (assets.length === 0), AND
//   - localStorage doesn't have `room-designer-onboarding-complete`.
//
// Each step anchors a tooltip card to a fixed screen region near the relevant
// UI element. The arrow uses a pure-CSS triangle to avoid an SVG dep. The
// overlay is `fixed inset-0` with `pointer-events-none` so the user can still
// interact with the app while reading; only the card itself is interactive.
//
// Dismiss paths: "Got it" advances; "Skip all" ends; Escape ends. Finishing
// step 4 sets the localStorage flag so it never shows again on this device.

import { useEffect, useState } from "react";
import { useRoomStore } from "./hooks/useRoomStore";

const STORAGE_KEY = "room-designer-onboarding-complete";

type StepAnchor = "properties" | "dimensions" | "assets" | "canvas";

interface Step {
    anchor: StepAnchor;
    title: string;
    body: string;
}

const STEPS: Step[] = [
    {
        anchor: "properties",
        title: "Draw your walls first",
        body:
            "Open the Room Layout section on the right and set your room dimensions. Walls are auto-generated from width × length.",
    },
    {
        anchor: "dimensions",
        title: "Tune the dimensions",
        body:
            "Enter the real-world size in feet and inches. Everything in the canvas stays in real-world scale — cabinets, clearances, everything.",
    },
    {
        anchor: "assets",
        title: "Drop in cabinets, appliances & fixtures",
        body:
            "Pick a category on the left, then click any item to place it. Drag to reposition. Press R to rotate 90°.",
    },
    {
        anchor: "canvas",
        title: "Click a surface to restyle it",
        body:
            "Click the floor, ceiling, or a wall to open the material picker. Stage-ready finishes, no shader knowledge required.",
    },
];

/** Absolute-positioned card coordinates per step. Pixel values match the
 * fixed toolbar/sidebar widths declared in DESIGN_SYSTEM.md. */
function stepPosition(anchor: StepAnchor): { top: string; left?: string; right?: string } {
    switch (anchor) {
        case "properties":
            // Right sidebar is ~320px wide; card sits just to its left.
            return { top: "120px", right: "340px" };
        case "dimensions":
            return { top: "200px", right: "340px" };
        case "assets":
            // Left sidebar (AssetPanel) is ~280px wide.
            return { top: "180px", left: "300px" };
        case "canvas":
            // Middle of the canvas viewport.
            return { top: "50%", left: "50%" };
    }
}

export function OnboardingCoach() {
    const assets = useRoomStore((s) => s.assets);
    const onboardingActive = useRoomStore((s) => s.onboardingActive);
    const setOnboardingActive = useRoomStore((s) => s.setOnboardingActive);
    const [stepIdx, setStepIdx] = useState(0);

    // Activate on first mount if eligible.
    useEffect(() => {
        if (typeof window === "undefined") return;
        const dismissed = window.localStorage.getItem(STORAGE_KEY) === "1";
        if (!dismissed && assets.length === 0) {
            setOnboardingActive(true);
        }
        // Intentionally only runs on mount.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Escape to dismiss.
    useEffect(() => {
        if (!onboardingActive) return;
        function onKey(e: KeyboardEvent) {
            if (e.key === "Escape") dismiss();
        }
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [onboardingActive]);

    function dismiss() {
        if (typeof window !== "undefined") {
            window.localStorage.setItem(STORAGE_KEY, "1");
        }
        setOnboardingActive(false);
    }

    function next() {
        if (stepIdx >= STEPS.length - 1) {
            dismiss();
        } else {
            setStepIdx(stepIdx + 1);
        }
    }

    if (!onboardingActive) return null;

    const step = STEPS[stepIdx];
    const pos = stepPosition(step.anchor);
    const isCentered = step.anchor === "canvas";

    return (
        <div
            className="pointer-events-none fixed inset-0 z-40"
            aria-live="polite"
        >
            {/* Soft dim so the card reads clearly over busy UI. */}
            <div className="absolute inset-0 bg-slate-950/10" />

            <div
                className="pointer-events-auto absolute w-80 max-w-[90vw] rounded-xl border border-slate-200 bg-white p-4 shadow-2xl"
                style={{
                    top: pos.top,
                    left: pos.left,
                    right: pos.right,
                    transform: isCentered ? "translate(-50%, -50%)" : undefined,
                }}
                role="dialog"
                aria-label={`Onboarding step ${stepIdx + 1} of ${STEPS.length}`}
            >
                <div className="mb-1 text-xs font-medium uppercase tracking-wide text-emerald-600">
                    Step {stepIdx + 1} of {STEPS.length}
                </div>
                <h3 className="text-base font-semibold text-slate-900">{step.title}</h3>
                <p className="mt-1 text-sm text-slate-600">{step.body}</p>
                <div className="mt-4 flex items-center justify-between">
                    <button
                        onClick={dismiss}
                        className="text-xs font-medium text-slate-500 hover:text-slate-700"
                    >
                        Skip all
                    </button>
                    <div className="flex items-center gap-2">
                        {/* Pips */}
                        <div className="flex gap-1">
                            {STEPS.map((_, i) => (
                                <span
                                    key={i}
                                    className={`h-1.5 w-1.5 rounded-full ${
                                        i === stepIdx ? "bg-emerald-500" : "bg-slate-300"
                                    }`}
                                    aria-hidden
                                />
                            ))}
                        </div>
                        <button
                            onClick={next}
                            className="hui-btn hui-btn-green px-3 py-1 text-xs"
                        >
                            {stepIdx === STEPS.length - 1 ? "Finish" : "Got it"}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
