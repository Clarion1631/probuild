"use client";

import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, ReferenceLine, ResponsiveContainer } from "recharts";
import type { OverheadRatioMonthPoint } from "@/lib/company-financials-charts";

const fmtPct = (v: number) => `${v.toFixed(1)}%`;

export default function OverheadRatioChart({ data }: { data: OverheadRatioMonthPoint[] }) {
    return (
        <div className="w-full h-[220px]">
            <ResponsiveContainer width="100%" height="100%">
                <LineChart data={data} margin={{ top: 10, right: 16, left: 8, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
                    <XAxis dataKey="monthLabel" axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: "#6b7280" }} dy={8} />
                    <YAxis tickFormatter={fmtPct} axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: "#6b7280" }} width={48} />
                    <RechartsTooltip
                        formatter={((value: number | null) => (value == null ? "—" : fmtPct(value))) as never}
                        labelFormatter={(_, payload) => payload?.[0]?.payload?.monthFull ?? ""}
                        contentStyle={{ borderRadius: 8, border: "none", boxShadow: "0 4px 6px -1px rgb(0 0 0 / 0.1)" }}
                    />
                    <ReferenceLine
                        y={15}
                        stroke="#9ca3af"
                        strokeDasharray="4 4"
                        label={{ value: "target", position: "insideTopRight", fill: "#9ca3af", fontSize: 11 }}
                    />
                    <Line
                        type="monotone"
                        dataKey="ratio"
                        stroke="#7c3aed"
                        strokeWidth={2}
                        dot={{ r: 4, fill: "#7c3aed" }}
                        activeDot={{ r: 6 }}
                        connectNulls={false}
                    />
                </LineChart>
            </ResponsiveContainer>
        </div>
    );
}
