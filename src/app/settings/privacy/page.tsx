export const dynamic = "force-dynamic";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";

export default async function PrivacySettingsPage() {
    const session = await getServerSession(authOptions);
    const email = (session?.user as any)?.email ?? "—";
    const name = (session?.user as any)?.name ?? "—";

    return (
        <div className="flex-1 overflow-y-auto">
            <div className="max-w-[600px] py-8 px-6">
                <div className="mb-8">
                    <h1 className="text-2xl font-bold text-hui-textMain">Privacy &amp; Security</h1>
                    <p className="text-sm text-hui-textMuted mt-1">Manage your account access and sign-in settings.</p>
                </div>

                <div className="hui-card divide-y divide-hui-border">
                    <div className="p-6">
                        <h2 className="text-sm font-semibold text-hui-textMuted uppercase tracking-wider mb-4">Account</h2>
                        <div className="space-y-4">
                            <div className="flex items-center justify-between">
                                <div>
                                    <p className="text-sm font-medium text-hui-textMain">Name</p>
                                    <p className="text-sm text-hui-textMuted">{name}</p>
                                </div>
                            </div>
                            <div className="flex items-center justify-between">
                                <div>
                                    <p className="text-sm font-medium text-hui-textMain">Email</p>
                                    <p className="text-sm text-hui-textMuted">{email}</p>
                                </div>
                            </div>
                        </div>
                    </div>

                    <div className="p-6">
                        <h2 className="text-sm font-semibold text-hui-textMuted uppercase tracking-wider mb-4">Sign-In Method</h2>
                        <div className="flex items-center gap-3">
                            <div className="w-8 h-8 rounded-full bg-slate-100 flex items-center justify-center">
                                <svg className="w-4 h-4 text-slate-600" viewBox="0 0 24 24" fill="currentColor">
                                    <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
                                    <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                                    <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
                                    <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
                                </svg>
                            </div>
                            <div>
                                <p className="text-sm font-medium text-hui-textMain">Google</p>
                                <p className="text-xs text-hui-textMuted">Sign in with your Google account</p>
                            </div>
                            <span className="ml-auto text-xs bg-green-50 text-green-700 px-2 py-0.5 rounded-full font-medium">Connected</span>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
