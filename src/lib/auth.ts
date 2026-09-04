import { NextAuthOptions, getServerSession } from "next-auth";
import GoogleProvider from "next-auth/providers/google";
import CredentialsProvider from "next-auth/providers/credentials";
import type { JWT } from "next-auth/jwt";
import { prisma } from "@/lib/prisma";

type StaffJWT = JWT & {
    userId?: string;
    accountDisabled?: boolean;
};

const providers: NextAuthOptions["providers"] = [
    GoogleProvider({
        clientId: process.env.GOOGLE_CLIENT_ID || "",
        clientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
    }),
];

// Test-only credentials provider — only active when PLAYWRIGHT_TEST_SECRET is set
if (process.env.PLAYWRIGHT_TEST_SECRET) {
    providers.push(
        CredentialsProvider({
            name: "Test",
            credentials: {
                email: { type: "text" },
                secret: { type: "text" },
            },
            async authorize(credentials) {
                if (credentials?.secret !== process.env.PLAYWRIGHT_TEST_SECRET) return null;
                const email = credentials?.email;
                if (!email) return null;
                const user = await prisma.user.findUnique({
                    where: { email: email.toLowerCase() },
                });
                if (!user || user.status === "DISABLED") return null;
                return { id: user.id, name: user.name, email: user.email };
            },
        })
    );
}

export const authOptions: NextAuthOptions = {
    providers,
    pages: {
        signIn: "/login",
        error: "/login?error=AccessDenied",
    },
    callbacks: {
        async signIn({ user, account, profile }) {
            if (account?.provider === "google") {
                const email = user.email;
                if (!email) return false;

                const existingUser = await prisma.user.findUnique({
                    where: { email: email.toLowerCase() }
                });

                if (!existingUser) {
                    return "/login?error=AccessDenied";
                }

                if (existingUser.status === "DISABLED") {
                    return "/login?error=AccessDenied";
                }

                // Activate user on first sign-in
                if (existingUser.status === "PENDING") {
                    // Same payroll write as the two mobile login paths: the
                    // Gusto roster is "ACTIVATED and HOURLY" or "punched", so
                    // this line can add somebody to a pay period's file, and
                    // lockPayrollPeriod hashes that file and freezes it. The
                    // transaction exists so the advisory lock has a scope --
                    // outside one it would be released before the update ran.
                    const { withPayrollUserWrite } = await import("./payroll-period");
                    await prisma.$transaction(async (tx) => {
                        const data = { status: "ACTIVATED" };
                        await withPayrollUserWrite(tx, data, () =>
                            tx.user.update({ where: { id: existingUser.id }, data })
                        );
                    });
                    // Just-activated FIELD_CREW (or CJ) joins every "In Progress"
                    // project. Awaited rather than after() — this callback is not a
                    // route handler, so after() is not available here — but the
                    // helper is fail-soft and never throws, so sign-in cannot break.
                    const { autoAssignProjectsForUser } = await import("@/lib/crew-auto-assign-sync");
                    await autoAssignProjectsForUser(existingUser.id);
                }
            }
            return true;
        },
        async jwt({ token, user, trigger }) {
            const staffToken = token as StaffJWT;
            // Always read the latest role, status, and DB id from DB.
            // token.sub on Google sign-ins is the OAuth subject, NOT the local
            // User.id, so anything storing token.sub as a User foreign key fails.
            if (token.email) {
                const dbUser = await prisma.user.findUnique({
                    where: { email: (token.email as string).toLowerCase() },
                    select: { id: true, role: true, status: true },
                });
                if (!dbUser || dbUser.status === "DISABLED") {
                    // Keep the email so a later refresh can observe reactivation
                    // or a recreated account, but strip authorization claims now.
                    delete token.role;
                    delete staffToken.userId;
                    staffToken.accountDisabled = true;
                    return token;
                }
                delete staffToken.accountDisabled;
                token.role = dbUser.role;
                staffToken.userId = dbUser.id;
            }
            return token;
        },
        async session({ session, token }) {
            const staffToken = token as StaffJWT;
            if (staffToken.accountDisabled) return {} as typeof session;
            if (session?.user) {
                // Only expose the local DB User.id. token.sub is the OAuth subject
                // (Google sub for Google sign-ins) and is NOT a valid User.id.
                (session.user as any).id = staffToken.userId ?? null;
                (session.user as any).role = token.role;
            }
            return session;
        },
    },
    secret: process.env.NEXTAUTH_SECRET,
};

const DEV_USER_EMAIL = "gtrsupport@goldentouchremodeling.com";
let cachedDevSession: any = null;
let warnedNoDevUser = false;

async function buildDevSession() {
    if (cachedDevSession) return cachedDevSession;
    const dev = await prisma.user.findUnique({
        where: { email: DEV_USER_EMAIL },
        select: { id: true, name: true, email: true, role: true },
    });
    if (!dev) {
        if (!warnedNoDevUser) {
            warnedNoDevUser = true;
            console.warn(
                `[auth] Dev session: no User row for ${DEV_USER_EMAIL}. Server actions that store the session user as a foreign key will fail. Seed this user in your local DB.`
            );
        }
        return {
            user: { id: null, name: "Dev User", email: DEV_USER_EMAIL, image: "", role: "ADMIN" },
            expires: new Date(Date.now() + 86400_000).toISOString(),
        };
    }
    cachedDevSession = {
        user: { id: dev.id, name: dev.name ?? "Dev User", email: dev.email, image: "", role: dev.role ?? "ADMIN" },
        expires: new Date(Date.now() + 86400_000).toISOString(),
    };
    return cachedDevSession;
}

/**
 * Like getServerSession but returns a mock ADMIN session in development
 * when no real session exists. Lets server components render without auth
 * during local `npm run dev` testing.
 */
export async function getDevSession() {
    if (process.env.NODE_ENV !== "development") return null;
    return await buildDevSession();
}

export async function getSessionOrDev() {
    try {
        const session = await getServerSession(authOptions);
        if (session) return session;
    } catch {
        // getServerSession can throw when NEXTAUTH_SECRET is missing, etc.
    }
    if (process.env.NODE_ENV === "development") return await buildDevSession();
    return null;
}
