import { NextRequest, NextResponse } from "next/server";

/**
 * `/automation/bank` merged into `/automation` (Unified Money Register plan
 * §3/§5 step 7). Old bookmarks/links must keep working, so this translates
 * the old page's `range` + `view` query params onto the new page's filter
 * params rather than dropping them (`bank/page.tsx` used to build these at
 * :133-138, :237-257).
 *
 * 307, NOT 308: a 308 (permanent) is cached by browsers indefinitely, which
 * would make this redirect impossible to walk back if the merge ever needed
 * to be undone. `NextResponse.redirect` is used directly (not
 * `next/navigation`'s `redirect()`) so the status code is explicit rather
 * than left to that function's context-dependent default.
 */
export const dynamic = "force-dynamic";

export function GET(request: NextRequest): NextResponse {
    const url = new URL(request.url);
    const sp = url.searchParams;

    const range = sp.get("range");
    const view = sp.get("view");

    const dest = new URL("/automation", url);
    if (range === "60" || range === "90") {
        dest.searchParams.set("range", range);
    }
    // range === "30" or missing/invalid: new page's default, no param needed.

    if (view === "review") {
        dest.searchParams.set("review", "1");
    } else if (view === "in") {
        dest.searchParams.set("type", "in");
    } else if (view === "out") {
        dest.searchParams.set("type", "out");
    }
    // view === "all" or missing/invalid: new page's default, no param needed.

    return NextResponse.redirect(dest, 307);
}
