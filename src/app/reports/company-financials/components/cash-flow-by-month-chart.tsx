"use client";

import { ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, Legend, ResponsiveContainer } from "recharts";
import { formatCurrency } from "@/lib/utils";
import type { CashFlowMonthPoint } from "@/lib/company-financials-charts";

const fmt = (v: number) => formatCurrency(v, { decimals: 0 });

export default function CashFlowByMonthChart({
    data,
    includeOverhead,
}: {
    data: CashFlowMonthPoint[];
    includeOverhead: boolean;
}) {
    return (
        <div className="w-full h-[320px]">
            <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={data} margin={{ top: 10, right: 16, left: 8, bottom: 0 }} barGap={4} barCategoryGap="28%">
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
                    <XAxis dataKey="monthLabel" axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: "#6b7280" }} dy={8} />
                    <YAxis tickFormatter={fmt} axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: "#6b7280" }} width={70} />
                    <RechartsTooltip
                        formatter={((value: number, name: string) => [fmt(value), name]) as never}
                        labelFormatter={(_, payload) => payload?.[0]?.payload?.monthFull ?? ""}
                        contentStyle={{ borderRadius: 8, border: "none", boxShadow: "0 4px 6px -1px rgb(0 0 0 / 0.1)" }}
                    />
                    <Legend wrapperStyle={{ paddingTop: 12, fontSize: 12 }} iconType="circle" />
                    <Bar name="Collected" dataKey="collected" stackId="in" fill="#0d9488" radius={[4, 4, 0, 0]} barSize={24} />
                    <Bar
                        name="Job costs"
                        dataKey="jobCosts"
                        stackId="out"
                        fill="#d97706"
                        radius={includeOverhead ? [0, 0, 0, 0] : [4, 4, 0, 0]}
                        barSize={24}
                    />
                    {includeOverhead && (
                        <Bar
                            name="Overhead"
                            dataKey="overhead"
                            stackId="out"
                            fill="#7c3aed"
                            radius={[4, 4, 0, 0]}
                            barSize={24}
                            stroke="#fff"
                            strokeWidth={2}
                        />
                    )}
                    <Line name="Net" type="monotone" dataKey="net" stroke="#1e293b" strokeWidth={2} dot={{ r: 3, fill: "#1e293b" }} activeDot={{ r: 5 }} />
                </ComposedChart>
            </ResponsiveContainer>
        </div>
    );
}
