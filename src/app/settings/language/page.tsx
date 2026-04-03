export default function LanguageSettingsPage() {
    return (
        <div className="flex-1 overflow-y-auto">
            <div className="max-w-[600px] py-8 px-6">
                <div className="mb-8">
                    <h1 className="text-2xl font-bold text-hui-textMain">Language</h1>
                    <p className="text-sm text-hui-textMuted mt-1">Choose the language used throughout the application.</p>
                </div>

                <div className="hui-card divide-y divide-hui-border">
                    <div className="p-6">
                        <h2 className="text-sm font-semibold text-hui-textMuted uppercase tracking-wider mb-4">Display Language</h2>
                        <div className="space-y-2">
                            {[
                                { code: "en", label: "English (United States)", active: true },
                                { code: "es", label: "Español (Spanish)", active: false },
                            ].map(lang => (
                                <label key={lang.code} className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${lang.active ? "border-hui-primary bg-hui-primary/5" : "border-hui-border hover:bg-slate-50"}`}>
                                    <input
                                        type="radio"
                                        name="language"
                                        defaultChecked={lang.active}
                                        className="w-4 h-4 text-hui-primary border-gray-300 focus:ring-hui-primary"
                                        disabled={!lang.active}
                                    />
                                    <span className="text-sm font-medium text-hui-textMain">{lang.label}</span>
                                    {!lang.active && <span className="ml-auto text-xs text-hui-textMuted">Coming soon</span>}
                                </label>
                            ))}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
