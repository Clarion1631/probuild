"use client";

import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, Legend, ResponsiveContainer } from "recharts";
import type { AutomationDayBucket } from "@/lib/automation-events";

const dayLabel = (day: string) =>
    new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const dayFull = (day: string) =>
    new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

export default function IntakeChart({ data }: { data: AutomationDayBucket[] }) {
    return (
        <div className="w-full h-[280px]">
            <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data} margin={{ top: 10, right: 16, left: 8, bottom: 0 }} barCategoryGap="20%">
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
                    <XAxis
                        dataKey="day"
                        tickFormatter={dayLabel}
                        axisLine={false}
                        tickLine={false}
                        tick={{ fontSize: 11, fill: "#6b7280" }}
                        dy={8}
                        minTickGap={24}
                    />
                    <YAxis allowDecimals={false} axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: "#6b7280" }} width={32} />
                    <RechartsTooltip
                        labelFormatter={(value) => dayFull(String(value))}
                        contentStyle={{ borderRadius: 8, border: "none", boxShadow: "0 4px 6px -1px rgb(0 0 0 / 0.1)" }}
                    />
                    <Legend wrapperStyle={{ paddingTop: 12, fontSize: 12 }} iconType="circle" />
                    {/* recharts v3 mishandles literal `false` children in a ComposedChart
                        (a conditional {cond && <Bar/>} kills the whole chart's geometry),
                        so all three series always render unconditionally — see
                        cash-flow-by-month-chart.tsx for the same note. */}
                    <Bar name="Booked automatically" dataKey="created" stackId="intake" fill="#0d9488" barSize={16} />
                    <Bar name="Email fallback" dataKey="fallback" stackId="intake" fill="#d97706" barSize={16} />
                    <Bar name="Errors" dataKey="error" stackId="intake" fill="#dc2626" barSize={16} radius={[4, 4, 0, 0]} />
                </BarChart>
            </ResponsiveContainer>
        </div>
    );
}
