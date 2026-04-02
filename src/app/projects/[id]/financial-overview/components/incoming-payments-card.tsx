"use client";

const Card = ({ className, children, onClick }: { className?: string, children: React.ReactNode, onClick?: () => void }) => (
    <div onClick={onClick} className={`rounded-xl border bg-white text-slate-950 shadow ${className}`}>{children}</div>
);

import { PieChart, Pie, Cell, ResponsiveContainer } from "recharts";
import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";

// Basic dropdown replacement
const DropdownMenu = ({ children }: { children: React.ReactNode }) => {
    return <div className="relative inline-block text-left">{children}</div>;
};

const DropdownMenuTrigger = ({ children, className, onClick }: any) => {
    return <button onClick={onClick} className={`cursor-pointer focus:outline-none ${className}`}>{children}</button>;
};

const DropdownMenuContent = ({ children, className, isOpen }: any) => {
    if (!isOpen) return null;
    return <div className={`absolute right-0 mt-2 w-48 rounded-md shadow-lg bg-white ring-1 ring-black ring-opacity-5 z-50 p-1 ${className}`}>{children}</div>;
};

const DropdownMenuItem = ({ children, onClick }: any) => {
    return <button onClick={onClick} className="w-full text-left block px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 cursor-pointer rounded-sm focus:outline-none">{children}</button>;
};


export default function IncomingPaymentsCard({ projectId, incoming }: { projectId: string; incoming: any }) {
    const router = useRouter();
    const [dropdownOpen, setDropdownOpen] = useState(false);
    const dropdownRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        function handleClickOutside(event: MouseEvent) {
            if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
                setDropdownOpen(false);
            }
        }
        document.addEventListener("mousedown", handleClickOutside);
        return () => document.removeEventListener("mousedown", handleClickOutside);
    }, []);

    const formatCurrency = (val: number) => 
        new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(val || 0);

    const data = [
        { name: "Current", value: incoming.current || 0, color: "#22c55e" },
        { name: "Scheduled", value: incoming.scheduled || 0, color: "#86efac" },
        { name: "Overdue", value: incoming.overdue || 0, color: "#f87171" }
    ];

    const total = data.reduce((acc, curr) => acc + curr.value, 0);

    return (
        <Card className="flex flex-col border-gray-200 bg-white h-[320px] shadow-sm overflow-hidden">
            <div className="p-4 border-b border-gray-100 flex justify-between items-center bg-gray-50/50">
                <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
                    Incoming Payments
                    <span title="Total Income: online payments/checks. Planned: future invoices/retainers. Overdue: past deadline." className="inline-flex items-center justify-center w-4 h-4 rounded-full border border-gray-300 text-gray-400 text-[10px] cursor-help">i</span>
                </h2>
                <div ref={dropdownRef} className="relative inline-block text-left">
                    <DropdownMenuTrigger onClick={() => setDropdownOpen(!dropdownOpen)} className="text-sm font-medium text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50 px-3 py-1.5 rounded transition flex items-center gap-1">
                        Add Income <svg width="10" height="6" viewBox="0 0 10 6" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M1 1L5 5L9 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent isOpen={dropdownOpen} align="end" className="w-48">
                        <DropdownMenuItem onClick={() => { setDropdownOpen(false); router.push(`/projects/${projectId}/estimates/new`); }}>New Estimate</DropdownMenuItem>
                        <DropdownMenuItem onClick={() => { setDropdownOpen(false); router.push(`/projects/${projectId}/invoices/new`); }}>New Invoice</DropdownMenuItem>
                        <DropdownMenuItem onClick={() => { setDropdownOpen(false); router.push(`/projects/${projectId}/retainers/new`); }}>New Retainer</DropdownMenuItem>
                        <DropdownMenuItem onClick={() => { setDropdownOpen(false); router.push(`/projects/${projectId}/change-orders/new`); }}>New Change Order</DropdownMenuItem>
                    </DropdownMenuContent>
                </div>
            </div>
            
            <div className="py-4 px-6 flex-1 flex flex-col justify-center">
                <div className="relative h-[120px] w-full flex justify-center">
                    {total === 0 ? (
                         <div className="absolute inset-0 flex items-center justify-center">
                            <span className="text-sm text-gray-400 mt-8">No Data</span>
                        </div>
                    ) : (
                        <ResponsiveContainer width="100%" height="100%">
                            <PieChart>
                                <Pie
                                    data={data}
                                    cx="50%"
                                    cy="100%"
                                    startAngle={180}
                                    endAngle={0}
                                    innerRadius={75}
                                    outerRadius={95}
                                    paddingAngle={2}
                                    dataKey="value"
                                    stroke="none"
                                >
                                    {data.map((entry, index) => (
                                        <Cell key={`cell-${index}`} fill={entry.color} />
                                    ))}
                                </Pie>
                            </PieChart>
                        </ResponsiveContainer>
                    )}
                    <div className="absolute bottom-2 left-1/2 -translate-x-1/2 text-center pb-2">
                        <div className="text-2xl font-bold text-gray-900 leading-none mb-1">{formatCurrency(incoming.current)}</div>
                        <div className="text-[10px] font-medium text-gray-500 uppercase tracking-wider">Forecasted: {formatCurrency(incoming.totalForecasted)}</div>
                    </div>
                </div>

                <div className="mt-4 flex gap-4 w-full">
                    <div className="flex-1 space-y-2">
                        <div className="flex justify-between items-center text-xs">
                            <div className="flex items-center gap-1.5 text-gray-600"><div className="w-2 h-2 rounded-full bg-green-500"></div>Current</div>
                            <div className="font-semibold">{formatCurrency(incoming.current)}</div>
                        </div>
                        <div className="flex justify-between items-center text-xs">
                            <div className="flex items-center gap-1.5 text-gray-600"><div className="w-2 h-2 rounded-full bg-green-300"></div>Scheduled</div>
                            <div className="font-semibold">{formatCurrency(incoming.scheduled)}</div>
                        </div>
                    </div>
                    <div className="w-px bg-gray-200"></div>
                    <div className="flex-1 space-y-2">
                        <div className="flex justify-between items-center text-xs">
                            <div className="flex items-center gap-1.5 text-gray-600"><div className="w-2 h-2 rounded-full bg-red-400"></div>Overdue</div>
                            <div className="font-semibold">{formatCurrency(incoming.overdue)}</div>
                        </div>
                        <div className="mt-2 pt-2 border-t border-gray-100 flex justify-between items-center text-[10px] text-gray-500 font-medium">
                            <span>Client Owes</span>
                            <span>{formatCurrency(incoming.clientOwes)}</span>
                        </div>
                    </div>
                </div>
            </div>
        </Card>
    );
}
