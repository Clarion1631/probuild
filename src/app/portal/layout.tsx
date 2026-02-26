export default function PortalLayout({ children }: { children: React.ReactNode }) {
    return (
        <div className="min-h-screen bg-slate-50 flex flex-col">
            <header className="bg-white border-b border-slate-200 px-8 py-4 flex items-center shadow-sm">
                <div className="font-bold text-xl text-slate-900 tracking-tight">ProBuild</div>
            </header>
            <main className="flex-1 w-full max-w-5xl mx-auto p-4 md:p-8">
                {children}
            </main>
        </div>
    );
}
