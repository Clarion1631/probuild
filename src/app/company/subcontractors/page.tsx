"use client";
export const dynamic = "force-dynamic";
import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { toast } from "sonner";
import ManageTradesModal from "@/components/ManageTradesModal";
import TradeTagSelector from "@/components/TradeTagSelector";
import { getCompanySubcontractorTrades } from "@/lib/actions";
import { Plus, Search, MoreHorizontal, X, Check, ChevronDown, Download, Tag, Edit2, Trash2 } from "lucide-react";

interface Subcontractor {
    id: string;
    companyName: string;
    contactName: string | null;
    email: string;
    phone: string | null;
    trade: string | null;
    status: string;
    coiUploaded: boolean;
    coiExpiresAt: string | null;
    createdAt?: string;
}

export default function SubcontractorsPage() {
    const [subs, setSubs] = useState<Subcontractor[]>([]);
    const [search, setSearch] = useState("");
    const [statusFilter, setStatusFilter] = useState<"ACTIVE" | "INACTIVE" | "ALL">("ACTIVE");
    const [tradeFilterValues, setTradeFilterValues] = useState<string[]>([]);
    const [isTradeFilterOpen, setIsTradeFilterOpen] = useState(false);
    const [availableTrades, setAvailableTrades] = useState<string[]>([]);
    const [showManageTrades, setShowManageTrades] = useState(false);
    const [showActionsDropdown, setShowActionsDropdown] = useState(false);
    const [showAdd, setShowAdd] = useState(false);
    const [addForm, setAddForm] = useState({ companyName: "", firstName: "", lastName: "", email: "", phone: "", trade: "" });
    const [adding, setAdding] = useState(false);
    const [rowActionMenuId, setRowActionMenuId] = useState<string | null>(null);

    // Sorting
    const [sortField, setSortField] = useState<"company" | "contact" | "trade" | "date">("company");
    const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");

    const tradeFilterRef = useRef<HTMLDivElement>(null);

    useEffect(() => { 
        fetchSubs(); 
        fetchTrades();
    }, []);

    // Close trade filter on outside click
    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            if (tradeFilterRef.current && !tradeFilterRef.current.contains(e.target as Node)) {
                setIsTradeFilterOpen(false);
            }
        };
        document.addEventListener("mousedown", handleClickOutside);
        return () => document.removeEventListener("mousedown", handleClickOutside);
    }, []);

    async function fetchTrades() {
        const trades = await getCompanySubcontractorTrades();
        setAvailableTrades(trades);
    }

    async function fetchSubs() {
        const res = await fetch("/api/subcontractors");
        if (res.ok) setSubs(await res.json());
    }

    async function handleAdd(e: React.FormEvent) {
        e.preventDefault();
        setAdding(true);
        try {
            const res = await fetch("/api/subcontractors", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    ...addForm,
                    contactName: `${addForm.firstName} ${addForm.lastName}`.trim() || null
                }),
            });
            const data = await res.json();
            if (!res.ok) { toast.error(data.error || "Failed to add Subcontractor"); return; }
            toast.success(`Added ${data.companyName}`);
            setShowAdd(false);
            setAddForm({ companyName: "", firstName: "", lastName: "", email: "", phone: "", trade: "" });
            fetchSubs();
        } catch { toast.error("Failed to add"); } finally { setAdding(false); }
    }

    async function handleDelete(id: string) {
        if (!confirm("Delete this subcontractor permanently?")) return;
        try {
            const res = await fetch(`/api/subcontractors/${id}`, { method: "DELETE" });
            if (res.ok) {
                setSubs(subs.filter(s => s.id !== id));
                toast.success("Subcontractor deleted");
            } else {
                toast.error("Failed to delete");
            }
        } catch { toast.error("Failed to delete"); }
    }

    const filtered = subs.filter(s => {
        const matchesStatus = statusFilter === "ALL" || s.status === statusFilter;
        const matchesSearch = !search || 
            s.companyName.toLowerCase().includes(search.toLowerCase()) || 
            s.email.toLowerCase().includes(search.toLowerCase()) ||
            s.contactName?.toLowerCase().includes(search.toLowerCase());
        const matchesTrade = tradeFilterValues.length === 0 || tradeFilterValues.some(ft => {
            if (!s.trade) return false;
            const subTrades = s.trade.split(",").map(t => t.trim());
            return subTrades.includes(ft);
        });
        return matchesStatus && matchesSearch && matchesTrade;
    });

    // Sorting
    const sorted = [...filtered].sort((a, b) => {
        const dir = sortDirection === "asc" ? 1 : -1;
        switch (sortField) {
            case "company":
                return dir * (a.companyName || "").localeCompare(b.companyName || "");
            case "contact":
                return dir * (a.contactName || "").localeCompare(b.contactName || "");
            case "trade":
                return dir * (a.trade || "").localeCompare(b.trade || "");
            case "date":
                return dir * (new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime());
            default:
                return 0;
        }
    });

    const handleSort = (field: "company" | "contact" | "trade" | "date") => {
        if (sortField === field) {
            setSortDirection(prev => prev === "asc" ? "desc" : "asc");
        } else {
            setSortField(field);
            setSortDirection("asc");
        }
    };

    const toggleTradeFilter = (trade: string) => {
        setTradeFilterValues(prev => prev.includes(trade) ? prev.filter(t => t !== trade) : [...prev, trade]);
    };

    // Export CSV
    const handleExportCSV = () => {
        const headers = ["Company", "Contact", "Email", "Phone", "Trade", "COI Status", "Status"];
        const rows = filtered.map(s => [
            s.companyName || "",
            s.contactName || "",
            s.email || "",
            s.phone || "",
            s.trade || "",
            s.coiUploaded ? (s.coiExpiresAt ? `Expires ${new Date(s.coiExpiresAt).toLocaleDateString()}` : "No Expiration") : "Missing",
            s.status || ""
        ]);
        const csvContent = [headers, ...rows].map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `subcontractors_export_${new Date().toISOString().split('T')[0]}.csv`;
        a.click();
        URL.revokeObjectURL(url);
        toast.success(`Exported ${rows.length} subcontractor${rows.length !== 1 ? 's' : ''} to CSV`);
        setShowActionsDropdown(false);
    };

    const renderCoiStatus = (s: Subcontractor) => {
        if (!s.coiUploaded) return <span className="text-[10px] font-semibold px-2 py-0.5 rounded text-slate-600 bg-slate-100 border border-slate-200 uppercase tracking-wider">Missing</span>;
        if (!s.coiExpiresAt) return <span className="text-[10px] font-semibold px-2 py-0.5 rounded text-amber-700 bg-amber-50 border border-amber-200 uppercase tracking-wider">No Expiration</span>;
        
        const diff = Math.ceil((new Date(s.coiExpiresAt).getTime() - Date.now()) / 86400000);
        
        if (diff <= 0) return (
            <div className="flex flex-col items-start gap-1">
                <span className="text-[10px] font-semibold px-2 py-0.5 rounded text-red-700 bg-red-50 border border-red-200 uppercase tracking-wider">Expired</span>
                <span className="text-[10px] font-medium text-slate-500">{new Date(s.coiExpiresAt).toLocaleDateString()}</span>
            </div>
        );
        if (diff <= 30) return (
            <div className="flex flex-col items-start gap-1">
                <span className="text-[10px] font-semibold px-2 py-0.5 rounded text-amber-700 bg-amber-50 border border-amber-200 uppercase tracking-wider">Expiring Soon</span>
                <span className="text-[10px] font-medium text-slate-500">{new Date(s.coiExpiresAt).toLocaleDateString()}</span>
            </div>
        );
        return (
            <div className="flex flex-col items-start gap-1">
                <span className="text-[10px] font-semibold px-2 py-0.5 rounded text-emerald-700 bg-emerald-50 border border-emerald-200 uppercase tracking-wider">Valid</span>
                <span className="text-[10px] font-medium text-slate-500">{new Date(s.coiExpiresAt).toLocaleDateString()}</span>
            </div>
        );
    };

    return (
        <div className="max-w-[1400px] mx-auto pb-20 p-4 sm:p-6">
            {/* Header — matches Vendors */}
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-8">
                <div>
                    <h1 className="text-2xl font-bold text-hui-textMain">Subcontractors</h1>
                </div>
                <div className="flex items-center gap-3">
                    <div className="relative">
                        <button 
                            onClick={() => setShowActionsDropdown(!showActionsDropdown)}
                            className="text-sm font-semibold flex items-center gap-1 hover:bg-slate-100 px-3 py-2 rounded transition text-slate-700"
                        >
                            Actions <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
                        </button>
                        {showActionsDropdown && (
                            <>
                                <div className="fixed inset-0 z-10" onClick={() => setShowActionsDropdown(false)}></div>
                                <div className="absolute right-0 mt-2 w-48 bg-white rounded-lg shadow-lg border border-slate-100 py-1 z-20">
                                    <button onClick={handleExportCSV} className="w-full text-left px-4 py-2 text-sm text-slate-700 hover:bg-slate-50 flex items-center gap-2"><Download className="w-3.5 h-3.5"/> Export to CSV</button>
                                    <button 
                                        onClick={() => { setShowManageTrades(true); setShowActionsDropdown(false); }}
                                        className="w-full text-left px-4 py-2 text-sm text-slate-700 hover:bg-slate-50 flex items-center gap-2"
                                    >
                                        <Tag className="w-3.5 h-3.5"/> Manage Trades
                                    </button>
                                </div>
                            </>
                        )}
                    </div>
                    <button
                        onClick={() => setShowAdd(true)}
                        className="hui-btn bg-slate-900 border-slate-900 text-white hover:bg-slate-800 flex items-center gap-2 font-bold"
                    >
                        Add Subcontractor
                    </button>
                </div>
            </div>

            {/* List View — matches Vendors card */}
            <div className="bg-white rounded-xl shadow-sm border border-hui-border overflow-hidden">
                <div className="p-4 border-b border-hui-border flex items-center gap-4">
                    <div className="relative w-64">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                        <input
                            type="text"
                            placeholder="Search"
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            className="hui-input pl-9 w-full text-sm"
                        />
                    </div>
                    <div className="flex gap-2">
                        {/* Trade Filter Dropdown */}
                        <div className="relative" ref={tradeFilterRef}>
                            <button 
                                onClick={() => setIsTradeFilterOpen(!isTradeFilterOpen)} 
                                className={`hui-btn hui-btn-secondary text-xs h-9 flex items-center gap-1.5 ${
                                    tradeFilterValues.length > 0 ? 'border-slate-900 bg-slate-900 text-white hover:bg-slate-800' : ''
                                }`}
                            >
                                <Tag className="w-3 h-3"/>
                                Trades {tradeFilterValues.length > 0 && <span className="bg-white/20 text-white text-[10px] px-1.5 py-0.5 rounded-full font-bold">{tradeFilterValues.length}</span>}
                                <ChevronDown className="w-3 h-3 ml-0.5"/>
                            </button>
                            {isTradeFilterOpen && (
                                <div className="absolute left-0 mt-2 w-56 bg-white rounded-lg shadow-[0_4px_20px_-4px_rgba(0,0,0,0.15)] border border-slate-200 py-1 z-30">
                                    {availableTrades.length === 0 ? (
                                        <div className="px-4 py-3 text-sm text-slate-400">No trades created yet</div>
                                    ) : (
                                        <>
                                            {availableTrades.map(trade => (
                                                <button
                                                    key={trade}
                                                    onClick={() => toggleTradeFilter(trade)}
                                                    className="w-full text-left px-4 py-2 text-sm text-slate-700 hover:bg-slate-50 flex items-center gap-2.5"
                                                >
                                                    <span className={`w-4 h-4 rounded border flex items-center justify-center text-[10px] shrink-0 ${
                                                        tradeFilterValues.includes(trade) ? 'bg-slate-900 border-slate-900 text-white' : 'border-slate-300'
                                                    }`}>
                                                        {tradeFilterValues.includes(trade) && <Check className="w-3 h-3"/>}
                                                    </span>
                                                    {trade}
                                                </button>
                                            ))}
                                            {tradeFilterValues.length > 0 && (
                                                <>
                                                    <div className="border-t border-slate-100 my-1"/>
                                                    <button
                                                        onClick={() => { setTradeFilterValues([]); setIsTradeFilterOpen(false); }}
                                                        className="w-full text-left px-4 py-2 text-xs text-slate-500 hover:bg-slate-50 font-medium"
                                                    >
                                                        Clear all filters
                                                    </button>
                                                </>
                                            )}
                                        </>
                                    )}
                                </div>
                            )}
                        </div>
                        <select 
                            value={statusFilter}
                            onChange={(e) => setStatusFilter(e.target.value as any)}
                            className="hui-btn hui-btn-secondary text-xs h-9 pl-3 pr-8"
                        >
                            <option value="ACTIVE">Type: Active</option>
                            <option value="INACTIVE">Type: Inactive</option>
                            <option value="ALL">Type: All</option>
                        </select>
                    </div>
                </div>

                <div className="overflow-x-auto min-h-[350px]">
                    <table className="w-full text-left text-sm whitespace-nowrap min-w-max">
                        <thead className="border-b border-hui-border text-xs font-semibold text-slate-500 bg-slate-50/50">
                            <tr>
                                <th className="pl-5 py-3 font-semibold cursor-pointer select-none hover:text-slate-800 transition" onClick={() => handleSort("company")}>
                                    Company <span className={`text-[10px] ${sortField === 'company' ? 'text-slate-800' : 'opacity-50'}`}>{sortField === 'company' ? (sortDirection === 'asc' ? '↑' : '↓') : '↕'}</span>
                                </th>
                                <th className="px-5 py-3 font-semibold cursor-pointer select-none hover:text-slate-800 transition" onClick={() => handleSort("contact")}>
                                    Contact <span className={`text-[10px] ${sortField === 'contact' ? 'text-slate-800' : 'opacity-50'}`}>{sortField === 'contact' ? (sortDirection === 'asc' ? '↑' : '↓') : '↕'}</span>
                                </th>
                                <th className="px-5 py-3 font-semibold cursor-pointer select-none hover:text-slate-800 transition" onClick={() => handleSort("trade")}>
                                    Trade <span className={`text-[10px] ${sortField === 'trade' ? 'text-slate-800' : 'opacity-50'}`}>{sortField === 'trade' ? (sortDirection === 'asc' ? '↑' : '↓') : '↕'}</span>
                                </th>
                                <th className="px-5 py-3 font-semibold">COI Status</th>
                                <th className="px-5 py-3 font-semibold">Status</th>
                                <th className="px-5 py-3"></th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                            {sorted.length === 0 ? (
                                <tr>
                                    <td colSpan={6} className="px-5 py-12 text-center text-slate-400">
                                        No subcontractors found.
                                    </td>
                                </tr>
                            ) : (
                                sorted.map(s => (
                                    <tr key={s.id} className="hover:bg-slate-50/80 transition group cursor-pointer" onClick={() => window.location.href = `/company/subcontractors/${s.id}`}>
                                        <td className="pl-5 py-4 font-semibold text-hui-textMain">
                                            {s.companyName}
                                            {s.status !== 'ACTIVE' && <span className="ml-2 bg-slate-100 text-slate-500 text-[10px] uppercase px-1.5 py-0.5 rounded">Inactive</span>}
                                        </td>
                                        <td className="px-5 py-4 text-slate-600 flex items-center gap-2">
                                            {s.contactName && (
                                                <div className="w-6 h-6 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center text-[10px] font-bold">
                                                    {s.contactName.split(" ").map(n => n[0]).join("").slice(0, 2).toUpperCase()}
                                                </div>
                                            )}
                                            <div>
                                                <div>{s.contactName || "—"}</div>
                                                {s.phone && <span className="text-slate-400 text-xs">{s.phone}</span>}
                                            </div>
                                        </td>
                                        <td className="px-5 py-4">
                                            <div className="flex gap-1 flex-wrap">
                                                {s.trade ? s.trade.split(",").map(t => t.trim()).map(t => (
                                                    <span key={t} className="bg-slate-100 text-slate-600 px-2 py-0.5 rounded text-xs border border-slate-200">{t}</span>
                                                )) : <span className="text-slate-400">—</span>}
                                            </div>
                                        </td>
                                        <td className="px-5 py-4">
                                            {renderCoiStatus(s)}
                                        </td>
                                        <td className="px-5 py-4">
                                            <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${s.status === "ACTIVE" ? "text-emerald-600 bg-emerald-50" : "text-amber-600 bg-amber-50"}`}>
                                                {s.status}
                                            </span>
                                        </td>
                                        <td className="px-5 py-4 text-right relative">
                                            <button 
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    setRowActionMenuId(rowActionMenuId === s.id ? null : s.id);
                                                }} 
                                                className="text-slate-400 hover:text-slate-600 p-1 rounded hover:bg-slate-100"
                                            >
                                                <MoreHorizontal className="w-5 h-5" />
                                            </button>
                                            {rowActionMenuId === s.id && (
                                                <div className="absolute right-5 top-10 mt-1 w-36 bg-white rounded-lg shadow-[0_4px_20px_-4px_rgba(0,0,0,0.15)] border border-slate-200 py-1 z-30" onClick={(e) => e.stopPropagation()}>
                                                    <Link href={`/company/subcontractors/${s.id}`} onClick={() => setRowActionMenuId(null)} className="w-full text-left px-4 py-2 text-sm text-slate-700 hover:bg-slate-50 flex items-center gap-2"><Edit2 className="w-3.5 h-3.5"/> View Details</Link>
                                                    <button onClick={async () => {
                                                        setRowActionMenuId(null);
                                                        handleDelete(s.id);
                                                    }} className="w-full text-left px-4 py-2 text-sm text-red-600 hover:bg-red-50 flex items-center gap-2"><Trash2 className="w-3.5 h-3.5"/> Delete</button>
                                                </div>
                                            )}
                                        </td>
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                </div>
            </div>

            {/* Add Subcontractor Modal — matches Vendor modal style */}
            {showAdd && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
                    <div className="bg-white rounded-xl shadow-xl w-full max-w-3xl max-h-[95vh] flex flex-col">
                        <div className="px-8 py-5 border-b border-hui-border flex justify-between items-center bg-white z-10 shrink-0">
                            <h2 className="text-2xl font-bold text-slate-800">Add Subcontractor</h2>
                            <button onClick={() => setShowAdd(false)} className="text-slate-400 hover:text-slate-600"><X className="w-6 h-6"/></button>
                        </div>
                        
                        <div className="p-8 overflow-y-auto flex-1 bg-white">
                            <form id="sub-form" onSubmit={handleAdd} className="space-y-10 max-w-2xl">
                                {/* Company Details */}
                                <section>
                                    <h3 className="text-sm font-bold text-slate-800 uppercase tracking-wide mb-4">Company Details</h3>
                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                        <div className="sm:col-span-2">
                                            <input required type="text" placeholder="Company Name*" value={addForm.companyName} onChange={e => setAddForm(p => ({ ...p, companyName: e.target.value }))} className="hui-input w-full" />
                                        </div>
                                    </div>
                                    <div className="mt-4">
                                        <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2 block">Trade</label>
                                        <TradeTagSelector 
                                            value={addForm.trade} 
                                            onChange={val => setAddForm(p => ({ ...p, trade: val }))}
                                        />
                                    </div>
                                </section>

                                {/* Contact Info */}
                                <section>
                                    <h3 className="text-sm font-bold text-slate-800 uppercase tracking-wide mb-4">Contact Info</h3>
                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                        <input type="text" placeholder="First Name" value={addForm.firstName} onChange={e => setAddForm(p => ({ ...p, firstName: e.target.value }))} className="hui-input w-full" />
                                        <input type="text" placeholder="Last Name" value={addForm.lastName} onChange={e => setAddForm(p => ({ ...p, lastName: e.target.value }))} className="hui-input w-full" />
                                        <input type="email" required placeholder="Email Address*" value={addForm.email} onChange={e => setAddForm(p => ({ ...p, email: e.target.value }))} className="hui-input w-full" />
                                        <input type="tel" placeholder="Phone Number" value={addForm.phone} onChange={e => setAddForm(p => ({ ...p, phone: e.target.value }))} className="hui-input w-full" />
                                    </div>
                                </section>
                            </form>
                        </div>

                        <div className="p-6 border-t border-hui-border bg-slate-50 shrink-0 flex justify-end gap-3 rounded-b-xl z-10">
                            <button type="button" onClick={() => setShowAdd(false)} className="hui-btn bg-white hover:bg-slate-50 border-slate-200 text-slate-700 font-bold px-6">Cancel</button>
                            <button type="submit" form="sub-form" disabled={adding} className="hui-btn bg-slate-900 border-slate-900 text-white hover:bg-slate-800 px-8 font-bold disabled:opacity-50">
                                {adding ? 'Adding...' : 'Add Subcontractor'}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {showManageTrades && (
                <ManageTradesModal 
                    onClose={() => {
                        setShowManageTrades(false);
                        fetchTrades();
                    }} 
                />
            )}
        </div>
    );
}
