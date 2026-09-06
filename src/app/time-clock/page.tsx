"use client";
export const dynamic = "force-dynamic";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useRouter } from "next/navigation";

type ClockInSuggestion = {
    scheduleTaskId: string;
    costCodeId: string;
    costCodeLabel: string;
    taskName: string;
    source: "daily_log" | "today_schedule" | "user_history";
    confidence: "high" | "medium" | "low";
    reason: string | null;
};

export default function TimeClockPage() {
    const router = useRouter();
    const [status, setStatus] = useState<"Clocked Out" | "Clocked In">("Clocked Out");
    const [currentTimeEntryId, setCurrentTimeEntryId] = useState<string | null>(null);
    const [location, setLocation] = useState<{ lat: number, lng: number } | null>(null);
    const [mealAnswer, setMealAnswer] = useState("");
    const [restAnswer, setRestAnswer] = useState("");
    const [error, setError] = useState<string>("");

    const [projects, setProjects] = useState<any[]>([]);
    const [selectedProject, setSelectedProject] = useState<string>("");

    // PHASES ONLY (owner's rule, 2026-08): the crew picks a cost-code phase, never an
    // individual estimate line item. Same endpoint and same rule set as the crew app —
    // GET /api/projects/[id]/cost-codes, backed by src/lib/project-phases.ts, which is
    // also what POST /api/time-entries validates against, so what this lists is exactly
    // what the server accepts.
    const [phases, setPhases] = useState<{ id: string; code: string; name: string; isActive?: boolean }[]>([]);
    const [selectedPhase, setSelectedPhase] = useState<string>("");
    // Plan 02: on a Logistics job the clock-in is a voice/typed dump of what
    // you're doing (dictation via the OS keyboard mic). Required.
    const [logisticsDump, setLogisticsDump] = useState<string>("");

    const [suggestion, setSuggestion] = useState<ClockInSuggestion | null>(null);
    // True once the user has picked a phase themselves — the suggestion preselect
    // must never fight a manual choice.
    const userPickedBucket = useRef(false);
    // Set while the "are you sure?" mismatch dialog is showing.
    const [confirmMismatch, setConfirmMismatch] = useState(false);

    const [projectsError, setProjectsError] = useState<string>("");
    const [timeEntriesError, setTimeEntriesError] = useState<string>("");
    const [bucketsError, setBucketsError] = useState<string>("");

    const activeProjectsController = useRef<AbortController | null>(null);

    const loadProjects = useCallback(() => {
        activeProjectsController.current?.abort();
        const controller = new AbortController();
        activeProjectsController.current = controller;

        fetch('/api/projects?assigned=true', { signal: controller.signal })
            .then(res => {
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                return res.json();
            })
            .then(data => {
                if (Array.isArray(data)) {
                    setProjects(data);
                    setProjectsError("");
                    setSelectedProject(prev => {
                        if (!prev) return prev;
                        return data.some((p: any) => p.id === prev) ? prev : "";
                    });
                }
            })
            .catch(e => {
                if (e.name === "AbortError") return;
                console.error("Could not fetch projects", e);
                setProjectsError("Failed to load projects");
            });
    }, []);

    useEffect(() => {
        loadProjects();

        fetch('/api/time-entries')
            .then(res => res.json())
            .then(data => {
                const active = data.find((te: any) => !te.endTime);
                if (active) {
                    setMealAnswer("");
                    setRestAnswer("");
                    setStatus("Clocked In");
                    setCurrentTimeEntryId(active.id);
                    setSelectedProject(active.projectId);
                    setSelectedPhase(active.costCodeId || "");
                }
            })
            .catch(e => {
                console.error("Could not fetch time entries", e);
                setTimeEntriesError("Failed to load time entries");
            });

    }, [loadProjects]);

    useEffect(() => {
        if (status === "Clocked In") return;

        const interval = setInterval(loadProjects, 30_000);

        const onVisibility = () => {
            if (document.visibilityState === "visible") loadProjects();
        };
        document.addEventListener("visibilitychange", onVisibility);

        return () => {
            clearInterval(interval);
            document.removeEventListener("visibilitychange", onVisibility);
        };
    }, [loadProjects, status]);

    useEffect(() => {
        if (!selectedProject) {
            setPhases([]);
            setSelectedPhase("");
            setSuggestion(null);
            userPickedBucket.current = false;
            return;
        }

        userPickedBucket.current = false;
        setSuggestion(null);

        // Abort both per-project fetches on project switch — a slow response
        // for the previous project must not overwrite the current one's state.
        const controller = new AbortController();

        setBucketsError("");
        fetch(`/api/projects/${selectedProject}/cost-codes`, { signal: controller.signal })
            .then(res => {
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                return res.json();
            })
            .then(data => {
                if (Array.isArray(data)) {
                    // Mirror the server's list EXACTLY (no extra client filtering):
                    // POST /api/time-entries accepts precisely this list, and a
                    // client-only filter would let a preselected suggestion point at
                    // a phase with no <option>, clocking in behind a blank picker.
                    setPhases(data.filter((c: any) => c && c.id));
                }
            })
            .catch(e => {
                if (e.name === "AbortError") return;
                console.error("Could not fetch project phases", e);
                setBucketsError("Failed to load phases");
            });

        // Suggested task for today (from the latest daily log / schedule).
        // Best-effort: a failure here must never block clocking in. Skipped while
        // clocked in — the restored shift's phase must not be overwritten by
        // today's suggestion (the banner would then label the shift wrong).
        if (status === "Clocked In") return () => controller.abort();
        fetch(`/api/mobile/time-suggestion?projectId=${selectedProject}`, { signal: controller.signal })
            .then(res => res.ok ? res.json() : { suggestion: null })
            .then(data => {
                const s: ClockInSuggestion | null = data?.suggestion ?? null;
                setSuggestion(s);
            })
            .catch(() => { /* aborted or failed — no suggestion */ });

        return () => controller.abort();
        // eslint-disable-next-line react-hooks/exhaustive-deps -- status is read only to skip the suggestion; re-running on every status flip would refetch phases mid-shift
    }, [selectedProject]);

    // Preselect today's suggested phase once BOTH the suggestion and the phase list are
    // in (the two fetches are independent and can resolve in either order). Only if the
    // phase is actually offered — otherwise the picker would show "Select a Phase..."
    // over a hidden selection — and never over a manual pick.
    useEffect(() => {
        if (!suggestion || userPickedBucket.current) return;
        if (phases.some(ph => ph.id === suggestion.costCodeId)) setSelectedPhase(suggestion.costCodeId);
    }, [phases, suggestion]);

    // Sorted by code — plain string sort, correct for zero-padded codes like "01-DEMO".
    const sortedPhases = useMemo(
        () => [...phases].sort((a, b) => a.code.localeCompare(b.code)),
        [phases]
    );

    const getLocation = (): Promise<{ lat: number, lng: number }> => {
        return new Promise((resolve, reject) => {
            if (!navigator.geolocation) {
                reject("Geolocation is not supported by your browser");
            } else {
                navigator.geolocation.getCurrentPosition((position) => {
                    resolve({
                        lat: position.coords.latitude,
                        lng: position.coords.longitude
                    });
                }, () => {
                    reject("Unable to retrieve your location");
                });
            }
        });
    };

    const performClockIn = async (phaseId: string, overridden: boolean) => {
        let loc = null;
        try {
            loc = await getLocation();
            setLocation(loc);
        } catch (e: any) {
            setError(e);
        }

        try {
            const res = await fetch('/api/time-entries', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    projectId: selectedProject,
                    // Phase-only punch. The server rejects any code that is not one of
                    // this project's phases (PHASE_NOT_ON_PROJECT).
                    costCodeId: phaseId || null,
                    ...(isLogistics ? { rawNote: logisticsDump.trim() } : {}),
                    latitude: loc?.lat,
                    longitude: loc?.lng,
                    ...(suggestion ? {
                        suggestedScheduleTaskId: suggestion.scheduleTaskId,
                        suggestedCostCodeId: suggestion.costCodeId,
                        suggestionSource: suggestion.source,
                        suggestionOverridden: overridden,
                    } : {}),
                })
            });
            const data = await res.json();
            if (data.error) throw new Error(data.error);

            setMealAnswer("");
            setRestAnswer("");
            setStatus("Clocked In");
            setCurrentTimeEntryId(data.id);
            if (phaseId !== selectedPhase) setSelectedPhase(phaseId);
        } catch (err: any) {
            setError(err.message);
        }
    };

    const isLogistics = !!projects.find(p => p.id === selectedProject)?.isLogistics;

    const handleClockInOut = async () => {
        setError("");

        if (status === "Clocked Out") {
            if (!selectedProject) {
                setError("Please select a project before clocking in.");
                return;
            }

            // A phase is required on every job EXCEPT Logistics (shop, travel,
            // admin time has no estimate to attach to — the server's
            // requiresPhaseForClockIn is the real rule; this only avoids a
            // round-trip). Note an In Progress Logistics job still lists
            // 32-SAFETY, so "has phases" alone cannot decide this.
            if (!isLogistics && !selectedPhase) {
                setError(phases.length > 0
                    ? "Please select a phase before clocking in."
                    : "This job has no phases set up yet. Contact the office to have phases added.");
                return;
            }
            if (isLogistics && !logisticsDump.trim()) {
                setError("Tell us what you're doing before clocking into Logistics — a few words is enough.");
                return;
            }

            // Red flag: picked something other than today's plan? Confirm first.
            if (suggestion && suggestion.costCodeId && selectedPhase !== suggestion.costCodeId) {
                setConfirmMismatch(true);
                return;
            }
            await performClockIn(selectedPhase, false);
        } else {
            let loc = null;
            try {
                loc = await getLocation();
                setLocation(loc);
            } catch (e: any) {
                setError(e);
            }
            try {
                if (!currentTimeEntryId) return;

                const res = await fetch('/api/time-entries', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        id: currentTimeEntryId,
                        mealSkipped: mealAnswer === "taken" ? false : mealAnswer === "worked" ? true : undefined,
                        restBreaksMissed: restAnswer === "missed" ? true : restAnswer === "taken" ? false : undefined,
                        latitude: loc?.lat,
                        longitude: loc?.lng
                    })
                });
                const data = await res.json();
                if (data.error) throw new Error(data.error);

                setStatus("Clocked Out");
                setCurrentTimeEntryId(null);
                setMealAnswer("");
                setRestAnswer("");
                setSelectedProject("");
                setSelectedPhase("");
                setLogisticsDump("");
            } catch (err: any) {
                setError(err.message);
            }
        }
    };

    return (
        <div className="max-w-xl mx-auto py-12 px-6">
            <h1 className="text-2xl font-bold text-hui-textMain mb-8">Time Clock</h1>

            <div className="hui-card p-8 text-center">
                <div className={`text-sm font-semibold mb-6 ${status === 'Clocked In' ? 'text-green-600' : 'text-slate-500'}`}>
                    Status: {status}
                </div>

                {status === "Clocked Out" && (
                    <div className="mb-8 text-left space-y-4">
                        <div>
                            <label className="block text-sm font-medium text-slate-700 mb-2">Project</label>
                            <select
                                value={selectedProject}
                                onChange={(e) => {
                                    // A phase belongs to one project: clear it (and the old
                                    // list) here, not in the effect — the restore-on-load path
                                    // sets project + phase together and must keep both.
                                    setSelectedProject(e.target.value);
                                    setSelectedPhase("");
                                    setPhases([]);
                                }}
                                className="hui-input"
                            >
                                <option value="">Select a Project...</option>
                                {projects.map(p => (
                                    <option key={p.id} value={p.id}>{p.name}</option>
                                ))}
                            </select>
                            {projectsError && (
                                <p className="text-xs text-red-600 mt-1">{projectsError}</p>
                            )}
                            {!projectsError && projects.length === 0 && (
                                <p className="text-xs text-amber-600 mt-1">No projects assigned to you. Ask your manager to assign you.</p>
                            )}
                        </div>

                        {suggestion && (
                            <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
                                <div className="text-sm text-blue-800 font-medium">
                                    Suggested: {suggestion.taskName}
                                </div>
                                <div className="text-xs text-blue-700 mt-0.5">{suggestion.costCodeLabel}</div>
                                {suggestion.reason && (
                                    <div className="text-xs text-blue-600 mt-1">{suggestion.reason}</div>
                                )}
                            </div>
                        )}

                        {selectedProject && isLogistics && (
                            <div>
                                <label className="block text-sm font-medium text-slate-700 mb-2">What are you doing? Talk or type.</label>
                                <textarea
                                    value={logisticsDump}
                                    onChange={(e) => setLogisticsDump(e.target.value)}
                                    className="hui-input min-h-[88px]"
                                    placeholder="E.g., dump run for the ADU, then Lowe's for Mesplay"
                                    maxLength={4000}
                                />
                                <p className="text-xs text-slate-500 mt-1">Shop time, runs, driving. Name the job if it was for one — you can clean it up at clock-out.</p>
                            </div>
                        )}
                        {selectedProject && !isLogistics && (
                            <div>
                                <label className="block text-sm font-medium text-slate-700 mb-2">Phase</label>
                                {sortedPhases.length > 0 ? (
                                    <select
                                        value={selectedPhase}
                                        onChange={(e) => {
                                            userPickedBucket.current = true;
                                            setSelectedPhase(e.target.value);
                                        }}
                                        className="hui-input"
                                    >
                                        <option value="">Select a Phase...</option>
                                        {sortedPhases.map(phase => (
                                            <option key={phase.id} value={phase.id}>
                                                {phase.code} — {phase.name}
                                            </option>
                                        ))}
                                    </select>
                                ) : !bucketsError ? (
                                    // Never a bare empty list: an empty result is meaningful
                                    // (same wording as the crew app's no-phases state).
                                    <p className="text-xs text-amber-600">
                                        This job&apos;s estimate has no phases set up yet. Contact the office to have phases added.
                                    </p>
                                ) : null}
                                {bucketsError && (
                                    <p className="text-xs text-red-600 mt-1">{bucketsError}</p>
                                )}
                            </div>
                        )}
                    </div>
                )}

                {status === "Clocked In" && selectedProject && (
                    <div className="mb-6 text-left">
                        <div className="bg-green-50 border border-green-200 rounded-lg p-4">
                            <div className="text-sm text-green-800 font-medium">
                                Currently working on: {projects.find(p => p.id === selectedProject)?.name || "Unknown Project"}
                            </div>
                            {selectedPhase && (
                                <div className="text-xs text-green-700 mt-1">
                                    Phase: {(() => { const p = phases.find(ph => ph.id === selectedPhase); return p ? `${p.code} — ${p.name}` : ""; })()}
                                </div>
                            )}
                        </div>
                    </div>
                )}

                {status === "Clocked In" && (
                    <div className="mb-6 space-y-4 text-left">
                        <label className="block text-sm font-medium">
                            Meal break today
                            <select className="hui-input mt-2 w-full" value={mealAnswer} onChange={e => setMealAnswer(e.target.value)}>
                                <option value="">Unsure / needs review</option>
                                <option value="taken">I took an uninterrupted, duty-free meal of at least 30 minutes</option>
                                <option value="worked">I worked through, missed, or had an interrupted meal</option>
                            </select>
                        </label>
                        <p className="text-sm text-hui-textMuted">Work and interrupted meals stay paid. A confirmed meal may deduct 30 minutes if it was inside your punch. Unclear answers go to review.</p>
                        <label className="block text-sm font-medium">
                            Paid rest breaks today
                            <select className="hui-input mt-2 w-full" value={restAnswer} onChange={e => setRestAnswer(e.target.value)}>
                                <option value="">Unsure / no answer</option>
                                <option value="taken">I took my rest breaks</option>
                                <option value="missed">I missed one or more rest breaks</option>
                            </select>
                        </label>
                        <p className="text-sm text-hui-textMuted">Rest breaks are paid and already included in your clocked time.</p>
                    </div>
                )}

                {timeEntriesError && (
                    <div className="mb-6 p-4 bg-red-50 text-red-600 rounded-lg text-sm text-left">
                        {timeEntriesError}
                    </div>
                )}

                {error && (
                    <div className="mb-6 p-4 bg-red-50 text-red-600 rounded-lg text-sm text-left">
                        {error}
                    </div>
                )}

                <button
                    onClick={handleClockInOut}
                    disabled={status === "Clocked Out" && !!selectedProject && !isLogistics && phases.length === 0}
                    className={`hui-btn w-full py-4 text-lg font-bold disabled:opacity-50 disabled:cursor-not-allowed
                        ${status === 'Clocked In' ? 'bg-red-500 hover:bg-red-600 text-white' : 'hui-btn-green'}
                    `}
                >
                    {status === 'Clocked In' ? 'Clock Out' : 'Clock In'}
                </button>

                {location && (
                    <div className="mt-6 text-xs text-slate-400">
                        Location captured: {location.lat.toFixed(4)}, {location.lng.toFixed(4)}
                    </div>
                )}
            </div>

            {confirmMismatch && suggestion && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-6">
                    <div className="hui-card w-full max-w-sm p-6 text-left">
                        <h2 className="text-lg font-bold text-hui-textMain mb-2">
                            Are you sure this is the correct task?
                        </h2>
                        <p className="text-sm text-slate-600 mb-5">
                            Today&apos;s plan is <span className="font-semibold">{suggestion.taskName}</span> ({suggestion.costCodeLabel}).
                        </p>
                        <div className="space-y-2">
                            <button
                                className="hui-btn hui-btn-green w-full"
                                onClick={async () => {
                                    setConfirmMismatch(false);
                                    userPickedBucket.current = true;
                                    setSelectedPhase(suggestion.costCodeId);
                                    await performClockIn(suggestion.costCodeId, false);
                                }}
                            >
                                Use suggested task
                            </button>
                            <button
                                className="hui-btn w-full"
                                onClick={async () => {
                                    setConfirmMismatch(false);
                                    await performClockIn(selectedPhase, true);
                                }}
                            >
                                Keep my choice
                            </button>
                            <button
                                className="w-full py-2 text-sm text-slate-500 hover:text-slate-700"
                                onClick={() => setConfirmMismatch(false)}
                            >
                                Cancel
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

