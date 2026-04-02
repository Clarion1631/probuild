"use client";

import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, Legend, ResponsiveContainer } from "recharts";

export default function CashFlowTrackerChart({ timeline }: { timeline: any[] }) {
    const formatCurrency = (val: number) => 
        new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(val || 0);

    return (
        <div className="w-full h-[350px]">
            <ResponsiveContainer width="100%" height="100%">
                <BarChart
                    data={timeline}
                    margin={{ top: 20, right: 30, left: 20, bottom: 5 }}
                >
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis 
                        dataKey="date" 
                        axisLine={false}
                        tickLine={false}
                        tick={{fontSize: 12, fill: "#6b7280"}}
                        dy={10}
                    />
                    <YAxis 
                        tickFormatter={(value) => formatCurrency(value)}
                        axisLine={false}
                        tickLine={false}
                        tick={{fontSize: 12, fill: "#6b7280"}}
                        dx={-10}
                    />
                    <RechartsTooltip 
                        formatter={(value: any) => formatCurrency(value)}
                        cursor={{fill: "#f3f4f6"}}
                        contentStyle={{borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)'}}
                    />
                    <Legend 
                        wrapperStyle={{ paddingTop: "20px" }}
                        iconType="circle"
                    />
                    
                    <Bar name="Incoming Payments" dataKey="incomingPayments" stackId="incoming" fill="#22c55e" radius={[0, 0, 4, 4]} barSize={20} />
                    <Bar name="Forecasted Incoming" dataKey="forecastedIncoming" stackId="incoming" fill="#86efac" radius={[4, 4, 0, 0]} barSize={20} />
                    
                    <Bar name="Outgoing Payments" dataKey="outgoingPayments" stackId="outgoing" fill="#f59e0b" radius={[0, 0, 4, 4]} barSize={20} />
                    <Bar name="Forecasted Outgoing" dataKey="forecastedOutgoing" stackId="outgoing" fill="#818cf8" radius={[4, 4, 0, 0]} barSize={20} />
                    
                    <Bar name="Overdue" dataKey="overdue" stackId="incoming" fill="#f87171" radius={[0, 0, 0, 0]} barSize={20} />
                </BarChart>
            </ResponsiveContainer>
        </div>
    );
}
