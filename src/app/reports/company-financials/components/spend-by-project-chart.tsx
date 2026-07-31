"use client";

import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, Legend, ResponsiveContainer } from "recharts";
import { formatCurrency } from "@/lib/utils";
import type { SpendSeriesMeta, SpendByProjectMonthPoint } from "@/lib/company-financials-charts";

const fmt = (v: number) => formatCurrency(v, { decimals: 0 });

export default function SpendByProjectChart({
    series,
    data,
}: {
    series: SpendSeriesMeta[];
    data: SpendByProjectMonthPoint[];
}) {
    return (
        <div className="w-full h-[320px]">
            <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data} margin={{ top: 10, right: 16, left: 8, bottom: 0 }} barCategoryGap="28%">
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
                    <XAxis dataKey="monthLabel" axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: "#6b7280" }} dy={8} />
                    <YAxis tickFormatter={fmt} axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: "#6b7280" }} width={70} />
                    <RechartsTooltip
                        formatter={((value: number, name: string) => [fmt(value), name]) as never}
                        labelFormatter={(_, payload) => payload?.[0]?.payload?.monthFull ?? ""}
                        contentStyle={{ borderRadius: 8, border: "none", boxShadow: "0 4px 6px -1px rgb(0 0 0 / 0.1)" }}
                    />
                    <Legend wrapperStyle={{ paddingTop: 12, fontSize: 12 }} iconType="circle" />
                    {series.map((s, i) => (
                        <Bar
                            key={s.id}
                            name={s.name}
                            dataKey={s.id}
                            stackId="spend"
                            fill={s.color}
                            barSize={24}
                            radius={i === series.length - 1 ? [4, 4, 0, 0] : [0, 0, 0, 0]}
                        />
                    ))}
                </BarChart>
            </ResponsiveContainer>
        </div>
    );
}
