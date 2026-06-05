"use client";

import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from "recharts";
import { formatCurrency } from "@/lib/utils";

export default function JobCostingChart({ sortedSummaries }: { sortedSummaries: any[] }) {
    return (
        <ResponsiveContainer width="100%" height={280}>
            <BarChart
                data={sortedSummaries.map(s => ({
                    name: s.code !== "N/A" ? s.code : s.name,
                    fullName: s.name,
                    Budget: parseFloat((s.budgetLabor + s.budgetMaterial).toFixed(2)),
                    Actual: parseFloat((s.actualLabor + s.actualMaterial).toFixed(2)),
                    Committed: parseFloat(s.committedMaterial.toFixed(2)),
                }))}
                margin={{ top: 4, right: 8, left: 8, bottom: 4 }}
                barCategoryGap="30%"
                barGap={2}
            >
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis dataKey="name" tick={{ fontSize: 11, fill: "#94a3b8" }} axisLine={false} tickLine={false} />
                <YAxis
                    tick={{ fontSize: 11, fill: "#94a3b8" }}
                    axisLine={false}
                    tickLine={false}
                    tickFormatter={v => `$${v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v}`}
                />
                <Tooltip
                    formatter={(value, name) => [formatCurrency(Number(value ?? 0)), String(name)]}
                    labelFormatter={(label, payload) => payload?.[0]?.payload?.fullName ?? label}
                    contentStyle={{ borderRadius: 8, border: "1px solid #e2e8f0", fontSize: 12 }}
                />
                <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="Budget" fill="#3b82f6" radius={[3, 3, 0, 0]} />
                <Bar dataKey="Actual" fill="#f97316" radius={[3, 3, 0, 0]} />
                <Bar dataKey="Committed" fill="#f59e0b" radius={[3, 3, 0, 0]} />
            </BarChart>
        </ResponsiveContainer>
    );
}
