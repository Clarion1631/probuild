"use client";
export const dynamic = "force-dynamic";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useRouter } from "next/navigation";

type ClockInSuggestion = {
    scheduleTaskId: string;
    clockInEstimateItemId: string;
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
    const [error, setError] = useState<string>("");

    const [projects, setProjects] = useState<any[]>([]);
    const [selectedProject, setSelectedProject] = useState<string>("");

    const [budgetBuckets, setBudgetBuckets] = useState<any[]>([]);
    const [selectedBucket, setSelectedBucket] = useState<string>("");

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
                    setStatus("Clocked In");
                    setCurrentTimeEntryId(active.id);
                    setSelectedProject(active.projectId);
                    setSelectedBucket(active.estimateItemId || "");
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
            setBudgetBuckets([]);
            setSelectedBucket("");
            setSuggestion(null);
            userPickedBucket.current = false;
            return;
        }

        userPickedBucket.current = false;
        setSuggestion(null);

        // Abort both per-project fetches on project switch — a slow response
        // for the previous project must not overwrite the current one's state.
        const controller = new AbortController();

        fetch(`/api/projects/${selectedProject}/estimate-items`, { signal: controller.signal })
            .then(res => res.json())
            .then(data => {
                if (Array.isArray(data)) {
                    setBudgetBuckets(data);
                }
            })
            .catch(e => {
                if (e.name === "AbortError") return;
                console.error("Could not fetch estimate items", e);
                setBucketsError("Failed to load budget phases");
            });

        // Suggested task for today (from the latest daily log / schedule).
        // Best-effort: a failure here must never block clocking in.
        fetch(`/api/mobile/time-suggestion?projectId=${selectedProject}`, { signal: controller.signal })
            .then(res => res.ok ? res.json() : { suggestion: null })
            .then(data => {
                const s: ClockInSuggestion | null = data?.suggestion ?? null;
                setSuggestion(s);
                if (s && !userPickedBucket.current) {
                    setSelectedBucket(s.clockInEstimateItemId);
                }
            })
            .catch(() => { /* aborted or failed — no suggestion */ });

        return () => controller.abort();
    }, [selectedProject]);

    // Phase-code-grouped picker: groups ordered by cost code; codeless items
    // surface last, flagged — every estimate item is supposed to carry a phase
    // code. When the project has more than one eligible estimate, the estimate
    // title joins the group label so identical phases can't be confused.
    const bucketGroups = useMemo(() => {
        const estimateIds = new Set(budgetBuckets.map((b: any) => b.estimateId).filter(Boolean));
        const multiEstimate = estimateIds.size > 1;
        const groups = new Map<string, { label: string; items: any[] }>();
        for (const bucket of budgetBuckets) {
            const codeKey = bucket.costCode ? bucket.costCode.code : "~none";
            const key = multiEstimate ? `${bucket.estimateId}|${codeKey}` : codeKey;
            const baseLabel = bucket.costCode
                ? `${bucket.costCode.code} — ${bucket.costCode.name}`
                : "No phase code (fix in estimate)";
            const label = multiEstimate && bucket.estimateTitle
                ? `${bucket.estimateTitle}: ${baseLabel}`
                : baseLabel;
            if (!groups.has(key)) groups.set(key, { label, items: [] });
            groups.get(key)!.items.push(bucket);
        }
        return [...groups.entries()]
            .sort(([a], [b]) => {
                const aNone = a.endsWith("~none");
                const bNone = b.endsWith("~none");
                if (aNone !== bNone) return aNone ? 1 : -1;
                return a.localeCompare(b, undefined, { numeric: true });
            })
            .map(([, group]) => group);
    }, [budgetBuckets]);

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

    const performClockIn = async (bucketId: string, overridden: boolean) => {
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
                    estimateItemId: bucketId || null,
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

            setStatus("Clocked In");
            setCurrentTimeEntryId(data.id);
            if (bucketId !== selectedBucket) setSelectedBucket(bucketId);
        } catch (err: any) {
            setError(err.message);
        }
    };

    const handleClockInOut = async () => {
        setError("");

        if (status === "Clocked Out") {
            if (!selectedProject) {
                setError("Please select a project before clocking in.");
                return;
            }

            // Red flag: picked something other than today's plan? Confirm first.
            if (suggestion && selectedBucket !== suggestion.clockInEstimateItemId) {
                setConfirmMismatch(true);
                return;
            }
            await performClockIn(selectedBucket, false);
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
                        latitude: loc?.lat,
                        longitude: loc?.lng
                    })
                });
                const data = await res.json();
                if (data.error) throw new Error(data.error);

                setStatus("Clocked Out");
                setCurrentTimeEntryId(null);
                setSelectedProject("");
                setSelectedBucket("");
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
                                onChange={(e) => setSelectedProject(e.target.value)}
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

                        {budgetBuckets.length > 0 && (
                            <div>
                                <label className="block text-sm font-medium text-slate-700 mb-2">Budget Bucket (Phase)</label>
                                <select
                                    value={selectedBucket}
                                    onChange={(e) => {
                                        userPickedBucket.current = true;
                                        setSelectedBucket(e.target.value);
                                    }}
                                    className="hui-input"
                                >
                                    <option value="">Select a Phase...</option>
                                    {bucketGroups.map(group => (
                                        <optgroup key={group.label} label={group.label}>
                                            {group.items.map((b: any) => (
                                                <option key={b.id} value={b.id}>
                                                    {b.costCode ? `${b.costCode.code} — ` : ''}{b.name}
                                                </option>
                                            ))}
                                        </optgroup>
                                    ))}
                                </select>
                                {bucketsError && (
                                    <p className="text-xs text-red-600 mt-1">{bucketsError}</p>
                                )}
                                {budgetBuckets.some((b: any) => !b.costCode) && (
                                    <p className="text-xs text-amber-600 mt-1">
                                        Some phases have no phase code — assign cost codes in the estimate.
                                    </p>
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
                            {selectedBucket && (
                                <div className="text-xs text-green-700 mt-1">
                                    Phase: {budgetBuckets.find(b => b.id === selectedBucket)?.name || ""}
                                </div>
                            )}
                        </div>
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
                    className={`hui-btn w-full py-4 text-lg font-bold
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
                                    await performClockIn(suggestion.clockInEstimateItemId, false);
                                }}
                            >
                                Use suggested task
                            </button>
                            <button
                                className="hui-btn w-full"
                                onClick={async () => {
                                    setConfirmMismatch(false);
                                    await performClockIn(selectedBucket, true);
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

