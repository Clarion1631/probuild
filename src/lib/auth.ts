import { NextAuthOptions, getServerSession } from "next-auth";
import GoogleProvider from "next-auth/providers/google";
import CredentialsProvider from "next-auth/providers/credentials";
import { prisma } from "@/lib/prisma";

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
                if (!user) return null;
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
                    await prisma.user.update({
                        where: { id: existingUser.id },
                        data: { status: "ACTIVATED" },
                    });
                }
            }
            return true;
        },
        async jwt({ token, user, trigger }) {
            // Always read the latest role + DB id from DB.
            // token.sub on Google sign-ins is the OAuth subject, NOT the local
            // User.id, so anything storing token.sub as a User foreign key fails.
            if (token.email) {
                const dbUser = await prisma.user.findUnique({
                    where: { email: (token.email as string).toLowerCase() },
                    select: { id: true, role: true },
                });
                if (dbUser) {
                    token.role = dbUser.role;
                    (token as any).userId = dbUser.id;
                }
            }
            return token;
        },
        async session({ session, token }) {
            if (session?.user) {
                // Only expose the local DB User.id. token.sub is the OAuth subject
                // (Google sub for Google sign-ins) and is NOT a valid User.id.
                (session.user as any).id = (token as any).userId ?? null;
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
