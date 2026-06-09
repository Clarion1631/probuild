import { withAuth } from "next-auth/middleware";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// CORS Configuration
const CORS_PATH_PREFIXES = [
    "/api/mobile",
    "/api/projects",
    "/api/time-entries",
    "/api/files",
    "/api/expenses",
    "/api/receipts",
    "/api/manager",
];

const STATIC_ALLOWED_ORIGINS = [
    "https://app.goldentouchremodeling.com",
    "https://probuild-amber.vercel.app",
];

const ALLOWED_ORIGIN_SUFFIXES = [".lovable.app", ".lovableproject.com", ".lovable.dev"];

function isAllowedOrigin(origin: string | null): boolean {
    if (!origin) return false;
    if (STATIC_ALLOWED_ORIGINS.includes(origin)) return true;

    const envOrigins = (process.env.MOBILE_CORS_ORIGINS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    if (envOrigins.includes(origin)) return true;

    try {
        const { hostname, protocol } = new URL(origin);
        if (protocol !== "https:") return false;
        return ALLOWED_ORIGIN_SUFFIXES.some((suffix) => hostname.endsWith(suffix));
    } catch {
        return false;
    }
}

function corsHeaders(origin: string): Record<string, string> {
    return {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept",
        "Access-Control-Max-Age": "86400",
        Vary: "Origin",
    };
}

export default async function middleware(req: NextRequest, event: any) {
    const pathname = req.nextUrl.pathname;

    // 1. CORS check (runs first for specific API routes)
    const isCorsEligible = CORS_PATH_PREFIXES.some(
        (p) => pathname === p || pathname.startsWith(p + "/")
    );
    if (isCorsEligible) {
        const origin = req.headers.get("origin");
        if (origin && isAllowedOrigin(origin)) {
            if (req.method === "OPTIONS") {
                return new NextResponse(null, { status: 204, headers: corsHeaders(origin) });
            }
            const res = NextResponse.next();
            for (const [key, value] of Object.entries(corsHeaders(origin))) {
                res.headers.set(key, value);
            }
            return res;
        }
    }

    // 2. Dev mode bypass
    if (process.env.NODE_ENV === 'development') {
        return NextResponse.next();
    }

    // 3. Mobile auth header bypass
    const authHeader = req.headers?.get?.("authorization");
    if (typeof authHeader === "string" && authHeader.toLowerCase().startsWith("bearer ")) {
        return NextResponse.next();
    }

    // 4. Authentication logic matcher check
    // We only authenticate non-public browser routes.
    const isPublicRoute = [
        "api/auth", "api/cron", "api/twilio", "api/webhook", "api/payments",
        "api/portal", "api/pdf/estimates", "api/pdf/invoices", "api/sub-portal",
        "api/mobile", "login", "portal", "sub-portal"
    ].some(p => pathname.startsWith(`/${p}`) || pathname === `/${p}`);

    if (isPublicRoute) {
        return NextResponse.next();
    }

    // Run auth middleware
    const authMiddleware = withAuth({
        pages: {
            signIn: "/login",
        },
    });

    return authMiddleware(req as any, event);
}

export const config = {
    // Match everything except assets, static files and images
    matcher: [
        "/((?!_next/static|_next/image|favicon.ico|.*\\.png|.*\\.jpg|.*\\.svg).*)",
    ],
};
