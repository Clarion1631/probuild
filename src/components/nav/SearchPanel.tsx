"use client";

import Link from "next/link";
import { usePermissions } from "@/components/PermissionsProvider";

// The search input + grouped quick-links. Extracted from Sidebar so it can be
// rendered both inside the desktop rail's flyout and inside the mobile drawer.
// `onNavigate` lets the drawer close itself when a link is tapped.
export default function SearchPanel({ onNavigate }: { onNavigate?: () => void }) {
  const { permissions, loaded } = usePermissions();
  const can = (key: string) => !!permissions[key];

  return (
    <>
      <div className="p-4 border-b border-slate-200 bg-white">
        <h2 className="font-bold text-lg mb-4">Search</h2>
        <input
          type="text"
          placeholder="Search Projects"
          className="w-full border border-slate-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-slate-400"
        />
      </div>
      <div className="flex-1 overflow-y-auto w-full p-4 space-y-6">
        {!loaded ? (
          <div className="text-sm text-slate-400 text-center pt-4">Loading…</div>
        ) : (
          <>
            {/* Planning */}
            {(can("contracts") || can("estimates") || can("takeoffs") || can("roomDesigner")) && (
              <div>
                <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Planning</h3>
                <ul className="space-y-2 text-sm">
                  {can("contracts") && <li><Link href="/projects" onClick={onNavigate} className="hover:text-hui-primary block transition">All Contracts</Link></li>}
                  {can("estimates") && <li><Link href="/estimates" onClick={onNavigate} className="hover:text-hui-primary block transition">All Estimates</Link></li>}
                  {can("takeoffs") && <li><Link href="/projects" onClick={onNavigate} className="hover:text-hui-primary block transition">All Takeoffs</Link></li>}
                  {can("roomDesigner") && <li><Link href="/projects" onClick={onNavigate} className="hover:text-hui-primary block transition">All Room Designs</Link></li>}
                </ul>
              </div>
            )}
            {/* Management */}
            {(can("schedules") || can("dailyLogs") || can("timeClock") || can("clientCommunication")) && (
              <div>
                <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Management</h3>
                <ul className="space-y-2 text-sm">
                  {can("schedules") && <li><Link href="/manager/schedule" onClick={onNavigate} className="hover:text-hui-primary block transition">Schedule Overview</Link></li>}
                  {can("schedules") && <li><Link href="/manager/field-updates" onClick={onNavigate} className="hover:text-hui-primary block transition">Field Updates</Link></li>}
                  {can("dailyLogs") && <li><Link href="/projects" onClick={onNavigate} className="hover:text-hui-primary block transition">All Daily Logs</Link></li>}
                  {can("timeClock") && <li><Link href="/time-clock" onClick={onNavigate} className="hover:text-hui-primary block transition">Time &amp; Expenses</Link></li>}
                  {can("clientCommunication") && <li><Link href="/manager/inbox" onClick={onNavigate} className="hover:text-hui-primary block transition">Unmatched Inbox</Link></li>}
                </ul>
              </div>
            )}
            {/* Finance */}
            {(can("invoices") || can("changeOrders")) && (
              <div>
                <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Finance</h3>
                <ul className="space-y-2 text-sm">
                  {can("invoices") && <li><Link href="/invoices" onClick={onNavigate} className="hover:text-hui-primary block transition">All Invoices</Link></li>}
                  {can("changeOrders") && <li><Link href="/projects" onClick={onNavigate} className="hover:text-hui-primary block transition">All Change Orders</Link></li>}
                  {can("invoices") && <li><Link href="/manager/receipts" onClick={onNavigate} className="hover:text-hui-primary block transition">Receipt Queue</Link></li>}
                </ul>
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}
