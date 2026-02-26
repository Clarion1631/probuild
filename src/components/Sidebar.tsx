"use client";

import Link from "next/link";
import { useState } from "react";

export default function Sidebar({ logoUrl }: { logoUrl?: string }) {
    const [isSearchOpen, setIsSearchOpen] = useState(false);

    return (
        <aside className="w-20 bg-[#1e1e1e] text-white flex flex-col min-h-screen items-center py-4 relative z-50">
            {/* Search Flyout */}
            {isSearchOpen && (
                <div className="absolute left-20 top-0 w-64 bg-slate-50 min-h-screen shadow-xl border-r border-slate-200 text-slate-800 flex flex-col z-40">
                    <div className="p-4 border-b border-slate-200 bg-white">
                        <h2 className="font-bold text-lg mb-4">Search</h2>
                        <input type="text" placeholder="Search Houzz Pro" className="w-full border border-slate-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-slate-400" />
                    </div>
                    <div className="flex-1 overflow-y-auto w-full p-4 space-y-6">
                        <div>
                            <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Planning</h3>
                            <ul className="space-y-2 text-sm">
                                <li><Link href="#" className="hover:text-blue-600 block transition">All Contracts</Link></li>
                                <li><Link href="/projects/all/estimates" className="hover:text-blue-600 block transition">All Estimates</Link></li>
                                <li><Link href="#" className="hover:text-blue-600 block transition">All Takeoffs</Link></li>
                                <li><Link href="#" className="hover:text-blue-600 block transition">All 3D Floor Plans</Link></li>
                                <li><Link href="#" className="hover:text-blue-600 block transition">All Mood Boards</Link></li>
                                <li><Link href="#" className="hover:text-blue-600 block transition">All Selection Boards</Link></li>
                                <li><Link href="#" className="hover:text-blue-600 block transition">All Selections Tracker</Link></li>
                                <li><Link href="#" className="hover:text-blue-600 block transition">All Bids</Link></li>
                            </ul>
                        </div>
                        <div>
                            <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Management</h3>
                            <ul className="space-y-2 text-sm">
                                <li><Link href="#" className="hover:text-blue-600 block transition">Task Center</Link></li>
                                <li><Link href="#" className="hover:text-blue-600 block transition">Schedule Overview</Link></li>
                                <li><Link href="#" className="hover:text-blue-600 block transition">All Daily Logs</Link></li>
                                <li><Link href="#" className="hover:text-blue-600 block transition">Time & Expenses</Link></li>
                            </ul>
                        </div>
                        <div>
                            <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Finance</h3>
                            <ul className="space-y-2 text-sm">
                                <li><Link href="#" className="hover:text-blue-600 block transition">All Invoices</Link></li>
                                <li><Link href="#" className="hover:text-blue-600 block transition">All Purchase Orders</Link></li>
                                <li><Link href="#" className="hover:text-blue-600 block transition">All Change Orders</Link></li>
                            </ul>
                        </div>
                    </div>
                </div>
            )}

            {/* Main Global Nav */}
            <div className="mb-8 z-50">
                <Link href="/" className="block">
                    {logoUrl ? (
                        <div className="w-10 h-10 rounded-md bg-white flex items-center justify-center overflow-hidden">
                            <img src={logoUrl} alt="Company Logo" className="w-full h-full object-contain" />
                        </div>
                    ) : (
                        <div className="w-10 h-10 bg-green-500 rounded-md flex items-center justify-center font-bold text-xl hover:bg-green-600 transition">
                            h
                        </div>
                    )}
                </Link>
            </div>

            <nav className="flex-1 w-full space-y-2 flex flex-col items-center">
                <button
                    onClick={() => setIsSearchOpen(!isSearchOpen)}
                    className={`flex flex-col items-center justify-center w-full py-3 hover:bg-[#2a2a2a] transition ${isSearchOpen ? 'text-blue-400 bg-[#2a2a2a]' : 'text-slate-400'}`}
                >
                    <svg className="w-5 h-5 mb-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
                    <span className="text-[10px] uppercase font-semibold">Search</span>
                </button>

                <Link href="/" className="flex flex-col items-center justify-center w-full py-3 hover:bg-[#2a2a2a] text-slate-400 hover:text-white transition group">
                    <svg className="w-5 h-5 mb-1 group-hover:text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" /></svg>
                    <span className="text-[10px] uppercase font-semibold">Projects</span>
                </Link>
                <Link href="/leads" className="flex flex-col items-center justify-center w-full py-3 hover:bg-[#2a2a2a] text-slate-400 hover:text-white transition group">
                    <svg className="w-5 h-5 mb-1 group-hover:text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" /></svg>
                    <span className="text-[10px] uppercase font-semibold">Leads</span>
                </Link>
                <Link href="/clients" className="flex flex-col items-center justify-center w-full py-3 hover:bg-[#2a2a2a] text-slate-400 hover:text-white transition group">
                    <svg className="w-5 h-5 mb-1 group-hover:text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" /></svg>
                    <span className="text-[10px] uppercase font-semibold text-center leading-tight">Clients</span>
                </Link>
                <Link href="#" className="flex flex-col items-center justify-center w-full py-3 hover:bg-[#2a2a2a] text-slate-400 hover:text-white transition group">
                    <svg className="w-5 h-5 mb-1 group-hover:text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" /></svg>
                    <span className="text-[10px] uppercase font-semibold text-center leading-tight">Financials</span>
                </Link>
                <Link href="/time-clock" className="flex flex-col items-center justify-center w-full py-3 hover:bg-[#2a2a2a] text-slate-400 hover:text-white transition group">
                    <svg className="w-5 h-5 mb-1 group-hover:text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                    <span className="text-[10px] uppercase font-semibold text-center leading-tight">Time Clock</span>
                </Link>
                <Link href="/company/team-members" className="flex flex-col items-center justify-center w-full py-3 hover:bg-[#2a2a2a] text-slate-400 hover:text-white transition group">
                    <svg className="w-5 h-5 mb-1 group-hover:text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" /></svg>
                    <span className="text-[10px] uppercase font-semibold text-center leading-tight">Company</span>
                </Link>
                <Link href="/settings/company" className="flex flex-col items-center justify-center w-full py-3 hover:bg-[#2a2a2a] text-slate-400 hover:text-white transition group">
                    <svg className="w-5 h-5 mb-1 group-hover:text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                    <span className="text-[10px] uppercase font-semibold text-center leading-tight">Settings</span>
                </Link>
            </nav>

            <div className="w-full flex flex-col items-center space-y-2 mt-auto">
                <Link href="#" className="flex flex-col items-center justify-center w-full py-3 hover:bg-[#2a2a2a] text-blue-400 transition">
                    <svg className="w-5 h-5 mb-1" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M11.3 1.046A12.014 12.014 0 0010 1C5.029 1 1 5.029 1 10c0 4.97 4.029 9 9 9 1.488 0 2.89-.358 4.148-1.006A7.472 7.472 0 0114.5 15C14.5 9.773 18.23 5.372 23 4.296A12.062 12.062 0 0011.3 1.046zM20.5 4a6.5 6.5 0 11-13 0 6.5 6.5 0 0113 0z" clipRule="evenodd" /></svg>
                    <span className="text-[10px] uppercase font-semibold">Upgrade</span>
                </Link>
            </div>
        </aside>
    );
}
