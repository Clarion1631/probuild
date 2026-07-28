"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { AnimatePresence, motion, MotionConfig } from "framer-motion";
import { Camera, X } from "lucide-react";

import type { PortalUpdate } from "@/lib/portal-tracker";

type UpdateStyle = CSSProperties & {
    "--project-accent": string;
};

type LightboxPhoto = {
    url: string;
    caption: string | null;
};

function updateDate(value: string): { day: string; long: string } {
    const date = new Date(value);
    return {
        day: date.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
        long: date.toLocaleDateString("en-US", {
            weekday: "long",
            year: "numeric",
            month: "long",
            day: "numeric",
        }),
    };
}

export default function PortalUpdatesFeed({
    updates,
    projectColor,
}: {
    updates: PortalUpdate[];
    projectColor: string;
}) {
    const [lightbox, setLightbox] = useState<LightboxPhoto | null>(null);
    const closeButtonRef = useRef<HTMLButtonElement>(null);

    useEffect(() => {
        if (!lightbox) return;
        const previousOverflow = document.body.style.overflow;
        document.body.style.overflow = "hidden";
        closeButtonRef.current?.focus();

        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") setLightbox(null);
        };
        window.addEventListener("keydown", onKeyDown);
        return () => {
            document.body.style.overflow = previousOverflow;
            window.removeEventListener("keydown", onKeyDown);
        };
    }, [lightbox]);

    if (updates.length === 0) {
        return (
            <div className="hui-card flex flex-col items-center justify-center px-6 py-16 text-center">
                <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-100 text-slate-400">
                    <Camera className="h-6 w-6" aria-hidden="true" />
                </div>
                <h3 className="text-base font-semibold text-hui-textMain">
                    Updates from the crew will appear here.
                </h3>
                <p className="mt-1 max-w-md text-sm leading-6 text-hui-textMuted">
                    Your project team shares selected progress notes and photos after reviewing them.
                </p>
            </div>
        );
    }

    return (
        <MotionConfig reducedMotion="user">
            <div
                className="relative space-y-4 pl-3 sm:pl-5"
                style={{ "--project-accent": projectColor } as UpdateStyle}
            >
                <div
                    aria-hidden="true"
                    className="absolute bottom-8 left-[0.31rem] top-8 w-px sm:left-[0.81rem]"
                    style={{
                        background:
                            "linear-gradient(to bottom, var(--project-accent), color-mix(in srgb, var(--project-accent) 15%, transparent))",
                    }}
                />

                {updates.map((update, index) => {
                    const formatted = updateDate(update.date);
                    return (
                        <motion.article
                            key={update.id}
                            initial={{ opacity: 0, y: 14 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{
                                duration: 0.38,
                                delay: Math.min(index * 0.06, 0.3),
                                ease: [0.22, 1, 0.36, 1],
                            }}
                            className="relative rounded-2xl border border-slate-200 bg-white p-4 shadow-[0_14px_38px_-32px_rgba(15,23,42,0.75)] sm:p-5"
                        >
                            <span
                                aria-hidden="true"
                                className="absolute -left-[0.99rem] top-6 h-3 w-3 rounded-full border-[3px] border-white shadow-sm sm:-left-[1.49rem]"
                                style={{ backgroundColor: "var(--project-accent)" }}
                            />

                            <header className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
                                <h3 className="text-base font-bold tracking-[-0.01em] text-slate-950">
                                    {formatted.long}
                                </h3>
                                <span
                                    className="rounded-full px-2.5 py-1 text-[0.62rem] font-extrabold uppercase tracking-[0.14em]"
                                    style={{
                                        color: "var(--project-accent)",
                                        backgroundColor:
                                            "color-mix(in srgb, var(--project-accent) 10%, white)",
                                    }}
                                >
                                    {formatted.day}
                                </span>
                            </header>

                            <p className="whitespace-pre-wrap text-sm leading-6 text-slate-700">
                                {update.workPerformed}
                            </p>

                            {update.photos.length > 0 && (
                                <div className="mt-4 grid grid-cols-2 gap-2.5 sm:grid-cols-3">
                                    {update.photos.map((photo, photoIndex) => (
                                        <button
                                            key={`${photo.url}-${photoIndex}`}
                                            type="button"
                                            onClick={() => setLightbox(photo)}
                                            className={`group relative overflow-hidden rounded-xl border border-slate-200 bg-slate-100 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--project-accent)] focus-visible:ring-offset-2 ${
                                                update.photos.length === 1
                                                    ? "col-span-2 aspect-[16/10] sm:col-span-2"
                                                    : "aspect-square"
                                            }`}
                                            aria-label={`Open photo ${photoIndex + 1}${photo.caption ? `: ${photo.caption}` : ""}`}
                                        >
                                            {/* eslint-disable-next-line @next/next/no-img-element */}
                                            <img
                                                src={photo.url}
                                                alt={photo.caption || ""}
                                                className="h-full w-full object-cover transition duration-500 group-hover:scale-[1.035]"
                                            />
                                            {photo.caption && (
                                                <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-slate-950/80 to-transparent px-3 pb-2.5 pt-8 text-xs font-medium text-white">
                                                    {photo.caption}
                                                </span>
                                            )}
                                        </button>
                                    ))}
                                </div>
                            )}
                        </motion.article>
                    );
                })}
            </div>

            <AnimatePresence>
                {lightbox && (
                    <motion.div
                        className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/90 p-4 backdrop-blur-sm"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        onMouseDown={event => {
                            if (event.target === event.currentTarget) setLightbox(null);
                        }}
                    >
                        <motion.div
                            role="dialog"
                            aria-modal="true"
                            aria-label={lightbox.caption || "Project update photo"}
                            initial={{ opacity: 0, scale: 0.96 }}
                            animate={{ opacity: 1, scale: 1 }}
                            exit={{ opacity: 0, scale: 0.98 }}
                            transition={{ duration: 0.2 }}
                            className="relative flex max-h-[92vh] w-full max-w-5xl flex-col items-center"
                        >
                            <button
                                ref={closeButtonRef}
                                type="button"
                                onClick={() => setLightbox(null)}
                                className="absolute right-0 top-0 z-10 flex min-h-11 min-w-11 -translate-y-12 items-center justify-center rounded-full bg-white/10 text-white transition hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
                                aria-label="Close photo"
                            >
                                <X className="h-6 w-6" aria-hidden="true" />
                            </button>
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                                src={lightbox.url}
                                alt={lightbox.caption || "Project update"}
                                className="max-h-[82vh] max-w-full rounded-xl object-contain shadow-2xl"
                            />
                            {lightbox.caption && (
                                <p className="mt-3 max-w-3xl text-center text-sm text-white/90">
                                    {lightbox.caption}
                                </p>
                            )}
                        </motion.div>
                    </motion.div>
                )}
            </AnimatePresence>
        </MotionConfig>
    );
}
