"use client";

const Card = ({ className, children, onClick }: { className?: string, children: React.ReactNode, onClick?: () => void }) => (
    <div onClick={onClick} className={`rounded-xl border bg-white text-slate-950 shadow ${className}`}>{children}</div>
);
export default function CashFlowCard({ cashFlow }: { cashFlow: any }) {
    const formatCurrency = (val: number) => 
        new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(val || 0);

    return (
        <Card className="flex flex-col border-gray-200 bg-white shadow-sm overflow-hidden h-full">
            <div className="p-5 border-b border-gray-100 flex-1 flex flex-col justify-center">
                <div className="flex items-center gap-2 mb-2">
                    <h2 className="text-lg font-semibold text-gray-900">Cash Flow</h2>
                    <span className="text-xs text-gray-400 font-medium">(Incoming - Outgoing)</span>
                </div>
                <div className="mt-2">
                    <p className="text-sm text-gray-500 font-medium mb-1 uppercase tracking-wider">Current</p>
                    <div className="flex items-end gap-3 max-w-full">
                        <span className="text-3xl font-bold text-gray-900 truncate">{formatCurrency(cashFlow.currentIncoming - cashFlow.currentOutgoing)}</span>
                        <span className={`text-sm font-medium mb-1 ${cashFlow.currentMargin >= 0 ? "text-green-600" : "text-amber-600"}`}>
                            {cashFlow.currentMargin.toFixed(0)}% Margin
                        </span>
                    </div>
                </div>
            </div>
            
            <div className="p-5 flex-1 flex flex-col justify-center bg-slate-50/50">
                <div>
                    <p className="text-sm text-gray-500 font-medium mb-1 uppercase tracking-wider">Forecasted</p>
                    <div className="flex items-end gap-3 max-w-full">
                        <span className="text-3xl font-bold text-gray-900 truncate">{formatCurrency(cashFlow.forecastedIncoming - cashFlow.forecastedOutgoing)}</span>
                        <span className={`text-sm font-medium mb-1 ${cashFlow.forecastedMargin >= 0 ? "text-green-600" : "text-amber-600"}`}>
                            {cashFlow.forecastedMargin.toFixed(0)}% Margin
                        </span>
                    </div>
                </div>
            </div>
        </Card>
    );
}
