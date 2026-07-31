"use client";

import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, ResponsiveContainer, Cell, LabelList } from "recharts";
import { formatCurrency } from "@/lib/utils";
import type { ArAgingBucket } from "@/lib/company-financials-charts";

const fmt = (v: number) => formatCurrency(v, { decimals: 0 });

export default function ArAgingChart({ data }: { data: ArAgingBucket[] }) {
    return (
        <div className="w-full h-[320px]">
            <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data} layout="vertical" margin={{ top: 10, right: 56, left: 8, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#e5e7eb" />
                    <XAxis type="number" tickFormatter={fmt} axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: "#6b7280" }} />
                    <YAxis type="category" dataKey="bucket" axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: "#6b7280" }} width={90} />
                    <RechartsTooltip
                        formatter={((value: number) => fmt(value)) as never}
                        contentStyle={{ borderRadius: 8, border: "none", boxShadow: "0 4px 6px -1px rgb(0 0 0 / 0.1)" }}
                    />
                    <Bar dataKey="amount" barSize={22} radius={[0, 4, 4, 0]}>
                        {data.map((d) => (
                            <Cell key={d.bucket} fill={d.color} />
                        ))}
                        <LabelList
                            dataKey="amount"
                            position="right"
                            formatter={((v: number) => fmt(v)) as never}
                            style={{ fill: "#475569", fontSize: 12, fontWeight: 600 }}
                        />
                    </Bar>
                </BarChart>
            </ResponsiveContainer>
        </div>
    );
}
