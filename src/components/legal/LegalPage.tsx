import Link from "next/link";

// Shared shell for the public legal pages (/privacy, /terms, /account-deletion).
// These render outside AppLayout — no sidebar, no session — because the app
// stores require them to be reachable by a logged-out reviewer.
export default function LegalPage({
    title,
    effective,
    children,
}: {
    title: string;
    effective: string;
    children: React.ReactNode;
}) {
    return (
        <div className="min-h-screen bg-white text-slate-800">
            <div className="mx-auto max-w-3xl px-5 py-12 sm:px-8 sm:py-16">
                <header className="mb-10 border-b border-slate-200 pb-8">
                    <p className="text-sm font-semibold tracking-wide text-slate-500 uppercase">
                        ProBuild
                    </p>
                    <h1 className="mt-2 text-3xl font-bold text-slate-900 sm:text-4xl">{title}</h1>
                    <p className="mt-3 text-sm text-slate-500">Effective {effective}</p>
                </header>

                <div className="text-[15px] leading-7">{children}</div>

                <footer className="mt-14 border-t border-slate-200 pt-6 text-sm text-slate-500">
                    <nav className="flex flex-wrap gap-x-5 gap-y-2">
                        <Link href="/privacy" className="hover:text-slate-800">
                            Privacy Policy
                        </Link>
                        <Link href="/terms" className="hover:text-slate-800">
                            Terms of Service
                        </Link>
                        <Link href="/account-deletion" className="hover:text-slate-800">
                            Delete Account
                        </Link>
                        <Link href="/support" className="hover:text-slate-800">
                            Support
                        </Link>
                    </nav>
                    <p className="mt-4">
                        &copy; {new Date().getFullYear()} Golden Touch Remodeling LLC. All rights
                        reserved.
                    </p>
                </footer>
            </div>
        </div>
    );
}

export function H2({ children }: { children: React.ReactNode }) {
    return (
        <h2 className="mt-10 mb-3 text-xl font-semibold text-slate-900 first:mt-0">{children}</h2>
    );
}

export function P({ children }: { children: React.ReactNode }) {
    return <p className="mb-4">{children}</p>;
}

export function UL({ items }: { items: React.ReactNode[] }) {
    return (
        <ul className="mb-4 list-disc space-y-2 pl-6">
            {items.map((item, i) => (
                <li key={i}>{item}</li>
            ))}
        </ul>
    );
}
