import { NextAuthOptions, getServerSession } from "next-auth";
import GoogleProvider from "next-auth/providers/google";
import { prisma } from "@/lib/prisma";

export const authOptions: NextAuthOptions = {
    providers: [
        GoogleProvider({
            clientId: process.env.GOOGLE_CLIENT_ID || "",
            clientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
        }),
    ],
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
            // Always read the latest role from DB (picks up admin role changes)
            if (token.email) {
                const dbUser = await prisma.user.findUnique({
                    where: { email: (token.email as string).toLowerCase() }
                });
                if (dbUser) {
                    token.role = dbUser.role;
                }
            }
            return token;
        },
        async session({ session, token }) {
            if (session?.user) {
                (session.user as any).id = token.sub;
                (session.user as any).role = token.role;
            }
            return session;
        },
    },
    secret: process.env.NEXTAUTH_SECRET,
};

const DEV_SESSION = {
    user: { name: "Dev User", email: "gtrsupport@goldentouchremodeling.com", image: "", role: "ADMIN" },
    expires: new Date(Date.now() + 86400_000).toISOString(),
};

/**
 * Like getServerSession but returns a mock ADMIN session in development
 * when no real session exists. Lets server components render without auth
 * during local `npm run dev` testing.
 */
export async function getDevSession() {
    if (process.env.NODE_ENV !== "development") return null;
    return DEV_SESSION as any;
}

export async function getSessionOrDev() {
    try {
        const session = await getServerSession(authOptions);
        if (session) return session;
    } catch {
        // getServerSession can throw when NEXTAUTH_SECRET is missing, etc.
    }
    if (process.env.NODE_ENV === "development") return DEV_SESSION as any;
    return null;
}
