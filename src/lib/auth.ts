import { NextAuthOptions } from "next-auth";
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
        error: "/login?error=AccessDenied", // Redirect here if signin blocked
    },
    callbacks: {
        async signIn({ user, account, profile }) {
            if (account?.provider === "google") {
                const email = user.email;
                if (!email) return false;

                // Only allow login if the email is already in the database
                const existingUser = await prisma.user.findUnique({
                    where: { email: email.toLowerCase() }
                });

                if (!existingUser) {
                    // Returns false or an error string (or URL) to reject
                    return "/login?error=AccessDenied";
                }
            }
            return true;
        },
        async jwt({ token, user }) {
            if (user?.email) {
                const dbUser = await prisma.user.findUnique({
                    where: { email: user.email.toLowerCase() }
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
