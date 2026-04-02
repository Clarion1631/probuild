"use client";

const Card = ({ className, children, onClick }: { className?: string, children: React.ReactNode, onClick?: () => void }) => (
    <div onClick={onClick} className={`rounded-xl border bg-white text-slate-950 shadow ${className}`}>{children}</div>
);
import { PieChart, Pie, Cell, ResponsiveContainer } from "recharts";
import { useRouter } from "next/navigation";
import { Receipt } from "lucide-react";

export default function OutgoingPaymentsCard({ projectId, outgoing }: { projectId: string; outgoing: any }) {
    const router = useRouter();

    const formatCurrency = (val: number) => 
        new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(val || 0);

    if (!outgoing.hasExpenses) {
        return (
            <Card className="flex flex-col border-emerald-100 bg-emerald-50 h-[320px] shadow-sm items-center justify-center p-6 text-center">
                <div className="w-16 h-16 bg-white rounded-full flex items-center justify-center mb-4 shadow-sm text-emerald-600">
                    <Receipt size={32} />
                </div>
                <h3 className="text-lg font-bold text-gray-900 mb-2">Add Your First Expense!</h3>
                <p className="text-sm text-gray-600 mb-6 px-4">Once you add current expenses, they'll pop up right here.</p>
                <button 
                    onClick={() => router.push(`/projects/${projectId}/expenses/new`)}
                    className="px-6 py-2.5 bg-gray-900 hover:bg-black text-white text-sm font-medium rounded-lg transition"
                >
                    Add An Expense
                </button>
            </Card>
        );
    }

    const data = [
        { name: "Total Expenses", value: outgoing.totalExpenses || 0, color: "#f59e0b" }, // amber-500
        { name: "Planned Expenses", value: outgoing.plannedExpenses || 0, color: "#fcd34d" }, // amber-300
        { name: "Overdue", value: outgoing.overdueExpenses || 0, color: "#f87171" } // red-400
    ];

    const total = data.reduce((acc, curr) => acc + curr.value, 0);

    return (
        <Card className="flex flex-col border-gray-200 bg-white h-[320px] shadow-sm overflow-hidden">
            <div className="p-4 border-b border-gray-100 flex justify-between items-center bg-gray-50/50">
                <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
                    Outgoing Payments
                    <span title="Total Expenses: vendor payments, project costs. Planned: coming POs. Overdue: past deadline POs." className="inline-flex items-center justify-center w-4 h-4 rounded-full border border-gray-300 text-gray-400 text-[10px] cursor-help">i</span>
                </h2>
                <button 
                    onClick={() => router.push(`/projects/${projectId}/expenses/new`)}
                    className="text-sm font-medium text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50 px-3 py-1.5 rounded transition"
                >
                    Add An Expense
                </button>
            </div>
            
            <div className="p-4 flex-1 flex flex-col justify-center">
                <div className="relative h-[120px] w-full flex justify-center mt-2">
                    {total === 0 ? (
                        <div className="absolute inset-0 flex items-center justify-center">
                            <span className="text-sm text-gray-400">No Data</span>
                        </div>
                    ) : (
                        <ResponsiveContainer width="100%" height="100%">
                            <PieChart>
                                <Pie
                                    data={data}
                                    cx="50%"
                                    cy="100%"
                                    startAngle={180}
                                    endAngle={0}
                                    innerRadius={70}
                                    outerRadius={90}
                                    paddingAngle={2}
                                    dataKey="value"
                                    stroke="none"
                                >
                                    {data.map((entry, index) => (
                                        <Cell key={`cell-${index}`} fill={entry.color} />
                                    ))}
                                </Pie>
                            </PieChart>
                        </ResponsiveContainer>
                    )}
                    <div className="absolute bottom-2 left-1/2 -translate-x-1/2 text-center">
                        <div className="text-2xl font-bold text-gray-900">{formatCurrency(outgoing.totalExpenses)}</div>
                        <div className="text-[10px] font-medium text-gray-500 uppercase tracking-wider">Forecasted: {formatCurrency(outgoing.totalExpenses + outgoing.plannedExpenses)}</div>
                    </div>
                </div>

                <div className="mt-4 space-y-2">
                    <div className="flex justify-between items-center text-sm">
                        <div className="flex items-center gap-2 text-gray-600"><div className="w-2 h-2 rounded-full bg-amber-500"></div>Total Expenses</div>
                        <div className="font-semibold">{formatCurrency(outgoing.totalExpenses)}</div>
                    </div>
                    <div className="flex justify-between items-center text-sm">
                        <div className="flex items-center gap-2 text-gray-600"><div className="w-2 h-2 rounded-full bg-amber-300"></div>Planned Expenses</div>
                        <div className="font-semibold">{formatCurrency(outgoing.plannedExpenses)}</div>
                    </div>
                    <div className="flex justify-between items-center text-sm">
                        <div className="flex items-center gap-2 text-gray-600"><div className="w-2 h-2 rounded-full bg-red-400"></div>Overdue</div>
                        <div className="font-semibold">{formatCurrency(outgoing.overdueExpenses)}</div>
                    </div>
                </div>
            </div>
        </Card>
    );
}
