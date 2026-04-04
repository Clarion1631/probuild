"use client";

import { useState } from "react";
import TimeTab from "./TimeTab";
import ExpensesTab from "./ExpensesTab";
import NewTimeEntryModal from "./NewTimeEntryModal";
import NewExpenseEntryModal from "./NewExpenseEntryModal";

interface Props {
    project: { id: string; name: string };
    data: {
        timeEntries: any[];
        expenses: any[];
        costCodes: { id: string; name: string; code: string }[];
        costTypes: { id: string; name: string }[];
        teamMembers: { id: string; name: string | null; email: string; hourlyRate?: any }[];
        estimates: { id: string; title: string; items: { id: string; name: string }[] }[];
    };
    currentUser: { id: string; role: string; name: string };
}

type Tab = "time" | "expenses";

export default function TimeExpensesClient({ project, data, currentUser }: Props) {
    const [activeTab, setActiveTab] = useState<Tab>("time");
    const [showTimeModal, setShowTimeModal] = useState(false);
    const [showExpenseModal, setShowExpenseModal] = useState(false);

    return (
        <div>
            {/* Header */}
            <div className="flex items-center justify-between mb-6">
                <div>
                    <h1 className="text-2xl font-bold text-hui-textMain">Time & Expenses</h1>
                    <p className="text-sm text-slate-500 mt-0.5">{project.name}</p>
                </div>
            </div>

            {/* Tab Navigation */}
            <div className="flex items-center gap-1 mb-6 border-b border-hui-border">
                <button
                    onClick={() => setActiveTab("time")}
                    className={`px-4 py-2.5 text-sm font-medium border-b-2 transition ${
                        activeTab === "time"
                            ? "border-hui-primary text-hui-primary"
                            : "border-transparent text-hui-textMuted hover:text-hui-textMain hover:border-slate-300"
                    }`}
                >
                    <span className="flex items-center gap-2">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                        Time ({data.timeEntries.length})
                    </span>
                </button>
                <button
                    onClick={() => setActiveTab("expenses")}
                    className={`px-4 py-2.5 text-sm font-medium border-b-2 transition ${
                        activeTab === "expenses"
                            ? "border-hui-primary text-hui-primary"
                            : "border-transparent text-hui-textMuted hover:text-hui-textMain hover:border-slate-300"
                    }`}
                >
                    <span className="flex items-center gap-2">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 18.75a60.07 60.07 0 0115.797 2.101c.727.198 1.453-.342 1.453-1.096V18.75M3.75 4.5v.75A.75.75 0 013 6h-.75m0 0v-.375c0-.621.504-1.125 1.125-1.125H20.25M2.25 6v9m18-10.5v.75c0 .414.336.75.75.75h.75m-1.5-1.5h.375c.621 0 1.125.504 1.125 1.125v9.75c0 .621-.504 1.125-1.125 1.125h-.375m1.5-1.5H21a.75.75 0 00-.75.75v.75m0 0H3.75m0 0h-.375a1.125 1.125 0 01-1.125-1.125V15m1.5 1.5v-.75A.75.75 0 003 15h-.75M15 10.5a3 3 0 11-6 0 3 3 0 016 0zm3 0h.008v.008H18V10.5zm-12 0h.008v.008H6V10.5z" />
                        </svg>
                        Expenses ({data.expenses.length})
                    </span>
                </button>
            </div>

            {/* Tab Content */}
            {activeTab === "time" ? (
                <TimeTab
                    projectId={project.id}
                    entries={data.timeEntries}
                    onAddNew={() => setShowTimeModal(true)}
                    currentUser={currentUser}
                />
            ) : (
                <ExpensesTab
                    projectId={project.id}
                    expenses={data.expenses}
                    onAddNew={() => setShowExpenseModal(true)}
                    currentUser={currentUser}
                />
            )}

            {/* Modals */}
            {showTimeModal && (
                <NewTimeEntryModal
                    projectId={project.id}
                    teamMembers={data.teamMembers}
                    costCodes={data.costCodes}
                    currentUserId={currentUser.id}
                    onClose={() => setShowTimeModal(false)}
                />
            )}
            {showExpenseModal && (
                <NewExpenseEntryModal
                    projectId={project.id}
                    estimates={data.estimates}
                    costCodes={data.costCodes}
                    costTypes={data.costTypes}
                    onClose={() => setShowExpenseModal(false)}
                />
            )}
        </div>
    );
}
