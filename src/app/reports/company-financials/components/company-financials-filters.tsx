"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import {
    DropdownMenu,
    DropdownMenuTrigger,
    DropdownMenuContent,
    DropdownMenuCheckboxItem,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { DATE_RANGE_PRESETS, type DateRangePreset } from "@/lib/company-financials-charts";

interface Props {
    presetValue: DateRangePreset;
    selectedProjectIds: string[];
    allProjects: { id: string; name: string }[];
    includeOverhead: boolean;
}

export default function CompanyFinancialsFilters({ presetValue, selectedProjectIds, allProjects, includeOverhead }: Props) {
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();

    function updateParams(mutate: (sp: URLSearchParams) => void) {
        const sp = new URLSearchParams(searchParams.toString());
        mutate(sp);
        router.replace(`${pathname}?${sp.toString()}`);
    }

    function setPreset(preset: DateRangePreset) {
        updateParams((sp) => sp.set("range", preset));
    }

    // "projectId" absent => default (all). A single "none" value is an explicit
    // empty selection (distinct from "absent") — see parseCompanyFinancialsChartFilters.
    function currentSelection(sp: URLSearchParams): Set<string> {
        if (!sp.has("projectId")) return new Set(allProjects.map((p) => p.id));
        const explicit = sp.getAll("projectId");
        if (explicit.length === 1 && explicit[0] === "none") return new Set();
        return new Set(explicit);
    }

    function toggleProject(id: string, checked: boolean) {
        updateParams((sp) => {
            const current = currentSelection(sp);
            if (checked) current.add(id);
            else current.delete(id);
            sp.delete("projectId");
            if (current.size === 0) {
                sp.set("projectId", "none"); // keep the empty selection explicit — don't fall back to "all"
            } else {
                for (const pid of current) sp.append("projectId", pid);
            }
        });
    }

    function selectAllProjects() {
        updateParams((sp) => sp.delete("projectId")); // no params = default = all
    }

    function setIncludeOverhead(checked: boolean) {
        updateParams((sp) => sp.set("overhead", checked ? "1" : "0"));
    }

    const allSelected = selectedProjectIds.length === allProjects.length;

    return (
        <div className="hui-card p-4 space-y-2">
            <div className="flex flex-wrap items-center gap-3">
                <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Range</span>
                    <div className="flex gap-1">
                        {DATE_RANGE_PRESETS.map((p) => (
                            <button
                                key={p.value}
                                type="button"
                                onClick={() => setPreset(p.value)}
                                className={`px-2.5 py-1 rounded-md text-xs font-medium transition ${
                                    presetValue === p.value
                                        ? "bg-hui-primary text-white"
                                        : "bg-slate-100 text-hui-textMain hover:bg-slate-200"
                                }`}
                            >
                                {p.label}
                            </button>
                        ))}
                    </div>
                </div>

                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <button type="button" className="hui-btn hui-btn-secondary text-xs">
                            {allSelected ? "All projects" : `${selectedProjectIds.length} of ${allProjects.length} projects`}
                        </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="w-64">
                        <DropdownMenuLabel>Projects</DropdownMenuLabel>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                            onSelect={(e) => {
                                e.preventDefault();
                                selectAllProjects();
                            }}
                            className="text-hui-primary"
                        >
                            Select all
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        {allProjects.map((p) => (
                            <DropdownMenuCheckboxItem
                                key={p.id}
                                checked={selectedProjectIds.includes(p.id)}
                                onSelect={(e) => e.preventDefault()}
                                onCheckedChange={(checked) => toggleProject(p.id, checked)}
                            >
                                {p.name}
                            </DropdownMenuCheckboxItem>
                        ))}
                    </DropdownMenuContent>
                </DropdownMenu>

                <label className="flex items-center gap-2 ml-auto cursor-pointer">
                    <span className="text-xs font-medium text-hui-textMain">Include overhead</span>
                    <Switch checked={includeOverhead} onCheckedChange={setIncludeOverhead} size="sm" />
                </label>
            </div>
            <p className="text-xs text-hui-textMuted">Charts below follow these filters. Tiles and the jobs table are all-time.</p>
        </div>
    );
}
