"use client";
import { useState } from "react";
import Link from "next/link";

type SerializedRow = {
    id: string;
    date: string;
    description: string;
    type: "Income" | "Expense";
    amount: number;
    projectName: string;
    projectId: string | null;
    category: string;
};

type ProjectGroup = {
    key: string;
    projectName: string;
    projectId: string | null;
    incoming: number;
    outgoing: number;
    rows: SerializedRow[];
};

function TabButton({ active, onClick, children }: {
    active: boolean; onClick: () => void; children: React.ReactNode;
}) {
    return (
        <button
            onClick={onClick}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 transition whitespace-nowrap ${
                active
                    ? "border-hui-primary text-hui-primary"
                    : "border-transparent text-hui-textMuted hover:text-hui-textMain"
            }`}
        >
            {children}
        </button>
    );
}

const fmt = (n: number) =>
    n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0 });

export default function TransactionTabs({
    rows,
    byProject,
}: {
    rows: SerializedRow[];
    byProject: ProjectGroup[];
}) {
    const [tab, setTab] = useState<"all" | "project">("all");

    return (
        <>
            {/* Tab bar */}
            <div className="flex border-b border-hui-border">
                <TabButton active={tab === "all"} onClick={() => setTab("all")}>
                    All Transactions
                </TabButton>
                <TabButton active={tab === "project"} onClick={() => setTab("project")}>
                    By Project
                </TabButton>
            </div>

            {/* All Transactions tab */}
            {tab === "all" && (
                <>
                    {rows.length === 0 ? (
                        <div className="hui-card p-12 text-center text-hui-textMuted text-sm">
                            No transactions recorded yet.
                        </div>
                    ) : (
                        <div className="hui-card overflow-hidden">
                            <div className="px-4 py-3 border-b border-hui-border bg-hui-surface flex items-center justify-between">
                                <span className="text-sm font-semibold text-hui-textMain">
                                    All Transactions
                                </span>
                                <span className="text-sm text-hui-textMuted">
                                    {rows.length} transaction{rows.length !== 1 ? "s" : ""}
                                </span>
                            </div>
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="text-left text-xs text-hui-textMuted uppercase tracking-wide border-b border-hui-border">
                                        <th className="px-4 py-2">Date</th>
                                        <th className="px-4 py-2">Description</th>
                                        <th className="px-4 py-2">Type</th>
                                        <th className="px-4 py-2">Project</th>
                                        <th className="px-4 py-2">Category</th>
                                        <th className="px-4 py-2 text-right">Amount</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {rows.map((row) => (
                                        <tr
                                            key={row.id}
                                            className="border-b border-hui-border last:border-0 hover:bg-hui-surface/50"
                                        >
                                            <td className="px-4 py-3 text-hui-textMuted">
                                                {new Date(row.date).toLocaleDateString("en-US", {
                                                    month: "short",
                                                    day: "numeric",
                                                    year: "numeric",
                                                })}
                                            </td>
                                            <td className="px-4 py-3 text-hui-textMain">
                                                {row.description}
                                            </td>
                                            <td className="px-4 py-3">
                                                <span
                                                    className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                                                        row.type === "Income"
                                                            ? "bg-green-100 text-green-700"
                                                            : "bg-red-100 text-red-700"
                                                    }`}
                                                >
                                                    {row.type}
                                                </span>
                                            </td>
                                            <td className="px-4 py-3 text-hui-textMain">
                                                {row.projectId ? (
                                                    <Link
                                                        href={`/projects/${row.projectId}`}
                                                        className="hover:underline"
                                                    >
                                                        {row.projectName}
                                                    </Link>
                                                ) : (
                                                    <span className="text-hui-textMuted">
                                                        {row.projectName}
                                                    </span>
                                                )}
                                            </td>
                                            <td className="px-4 py-3 text-hui-textMuted">
                                                {row.category}
                                            </td>
                                            <td
                                                className={`px-4 py-3 text-right font-semibold ${
                                                    row.type === "Income"
                                                        ? "text-green-600"
                                                        : "text-red-500"
                                                }`}
                                            >
                                                {row.type === "Income" ? "+" : "-"}
                                                {fmt(row.amount)}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </>
            )}

            {/* By Project tab */}
            {tab === "project" && (
                <>
                    {byProject.length === 0 ? (
                        <div className="hui-card p-12 text-center text-hui-textMuted text-sm">
                            No transactions recorded yet.
                        </div>
                    ) : (
                        byProject.map((group) => (
                            <div key={group.key} className="hui-card overflow-hidden">
                                <div className="px-4 py-3 border-b border-hui-border bg-hui-surface flex items-center justify-between">
                                    <span className="text-sm font-semibold text-hui-textMain">
                                        {group.projectId ? (
                                            <Link
                                                href={`/projects/${group.projectId}`}
                                                className="hover:underline"
                                            >
                                                {group.projectName}
                                            </Link>
                                        ) : (
                                            group.projectName
                                        )}
                                    </span>
                                    <div className="flex gap-4 text-sm">
                                        <span className="text-green-600">
                                            In: {fmt(group.incoming)}
                                        </span>
                                        <span className="text-red-500">
                                            Out: {fmt(group.outgoing)}
                                        </span>
                                        <span
                                            className={
                                                group.incoming - group.outgoing >= 0
                                                    ? "text-green-600 font-semibold"
                                                    : "text-red-500 font-semibold"
                                            }
                                        >
                                            Net: {fmt(group.incoming - group.outgoing)}
                                        </span>
                                    </div>
                                </div>
                                <table className="w-full text-sm">
                                    <thead>
                                        <tr className="text-left text-xs text-hui-textMuted uppercase tracking-wide border-b border-hui-border">
                                            <th className="px-4 py-2">Date</th>
                                            <th className="px-4 py-2">Description</th>
                                            <th className="px-4 py-2">Type</th>
                                            <th className="px-4 py-2">Category</th>
                                            <th className="px-4 py-2 text-right">Amount</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {group.rows.map((row) => (
                                            <tr
                                                key={row.id}
                                                className="border-b border-hui-border last:border-0 hover:bg-hui-surface/50"
                                            >
                                                <td className="px-4 py-3 text-hui-textMuted">
                                                    {new Date(row.date).toLocaleDateString("en-US", {
                                                        month: "short",
                                                        day: "numeric",
                                                        year: "numeric",
                                                    })}
                                                </td>
                                                <td className="px-4 py-3 text-hui-textMain">
                                                    {row.description}
                                                </td>
                                                <td className="px-4 py-3">
                                                    <span
                                                        className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                                                            row.type === "Income"
                                                                ? "bg-green-100 text-green-700"
                                                                : "bg-red-100 text-red-700"
                                                        }`}
                                                    >
                                                        {row.type}
                                                    </span>
                                                </td>
                                                <td className="px-4 py-3 text-hui-textMuted">
                                                    {row.category}
                                                </td>
                                                <td
                                                    className={`px-4 py-3 text-right font-semibold ${
                                                        row.type === "Income"
                                                            ? "text-green-600"
                                                            : "text-red-500"
                                                    }`}
                                                >
                                                    {row.type === "Income" ? "+" : "-"}
                                                    {fmt(row.amount)}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        ))
                    )}
                </>
            )}
        </>
    );
}
