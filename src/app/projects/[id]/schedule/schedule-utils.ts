import type { Task } from "./schedule-types";

export const STATUS_OPTIONS = ["Not Started", "In Progress", "Complete", "Blocked"];
export const STATUS_COLORS: Record<string, string> = {
    "Not Started": "bg-slate-100 text-slate-700",
    "In Progress": "bg-blue-100 text-blue-700",
    "Complete": "bg-green-100 text-green-700",
    "Blocked": "bg-red-100 text-red-700",
};
export const PRESET_COLORS = ["#4c9a2a", "#3b82f6", "#8b5cf6", "#f59e0b", "#ef4444", "#ec4899", "#06b6d4", "#64748b"];

export function getDaysBetween(a: Date, b: Date) { return Math.round((b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24)); }
export function addDays(date: Date, days: number) { const d = new Date(date.getTime()); d.setUTCDate(d.getUTCDate() + days); return d; }
export function formatDate(d: Date) { return d.toISOString().split("T")[0]; }
export function getMonday(d: Date) { const c = new Date(d.getTime()); const day = c.getUTCDay(); const diff = day === 0 ? -6 : 1 - day; c.setUTCDate(c.getUTCDate() + diff); return c; }
export function isWeekend(d: Date) { const day = d.getUTCDay(); return day === 0 || day === 6; }
export function getInitials(name: string | null, email: string) { if (name) { const parts = name.split(" "); return parts.map(p => p[0]).join("").toUpperCase().slice(0, 2); } return email[0]?.toUpperCase() ?? "?"; }
export function formatCurrency(n: number) { return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n); }

export function computeCriticalPath(tasks: Task[]): Set<string> {
    if (tasks.length === 0) return new Set();
    const dur: Record<string, number> = {};
    const deps: Record<string, string[]> = {};
    const successors: Record<string, string[]> = {};
    for (const t of tasks) {
        dur[t.id] = Math.max(1, getDaysBetween(new Date(t.startDate), new Date(t.endDate)));
        deps[t.id] = t.dependencies.map(d => d.predecessorId);
        successors[t.id] = t.dependents.map(d => d.dependentId);
    }
    const ef: Record<string, number> = {};
    const topoOrder: string[] = [];
    const visited = new Set<string>();
    function visit(id: string, stack = new Set<string>()) {
        if (visited.has(id)) return;
        if (stack.has(id)) return;
        stack.add(id);
        for (const pred of (deps[id] || [])) visit(pred, stack);
        visited.add(id);
        topoOrder.push(id);
    }
    for (const t of tasks) visit(t.id);
    for (const id of topoOrder) {
        const predMaxEF = (deps[id] || []).reduce((m, pid) => Math.max(m, ef[pid] ?? 0), 0);
        ef[id] = predMaxEF + dur[id];
    }
    const projectEnd = Math.max(...Object.values(ef));
    const ls: Record<string, number> = {};
    for (const id of [...topoOrder].reverse()) {
        const succMinLS = (successors[id] || []).reduce((m, sid) => Math.min(m, ls[sid] ?? Infinity), Infinity);
        const lf = succMinLS === Infinity ? projectEnd : succMinLS;
        ls[id] = lf - dur[id];
    }
    const critical = new Set<string>();
    for (const id of topoOrder) {
        const es = ef[id] - dur[id];
        if (ls[id] - es <= 0) critical.add(id);
    }
    return critical;
}
