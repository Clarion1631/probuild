// Static server + API proxy for the Expo web build of the ProBuild mobile app.
//
// Mirrors production's shape: on the web the mobile app calls
// window.location.origin for every API request (a Vercel rewrite proxies /api
// in prod), so tests serve the static export and proxy /api/* to the Next dev
// server on :3000 — same-origin, no CORS, no change to the app's api client.
//
// Usage (playwright.config.mobile.ts webServer):
//   node e2e/mobile-app/serve-mobile-web.mjs
// Env:
//   MOBILE_APP_DIR   path to the gtr-probuild-mobile checkout (required)
//   MOBILE_WEB_PORT  listen port (default 19006)
//   API_TARGET       backend origin (default http://localhost:3000)
//
// The Expo export must exist first (npm run test:mobile-e2e builds it):
//   cd <MOBILE_APP_DIR>/apps/mobile && npx expo export --platform web
import { createServer, request as httpRequest } from "node:http";
import { existsSync, statSync, createReadStream } from "node:fs";
import path from "node:path";

const mobileDir = process.env.MOBILE_APP_DIR;
if (!mobileDir) {
    console.error("MOBILE_APP_DIR is required (path to the gtr-probuild-mobile checkout)");
    process.exit(1);
}
const dist = path.join(mobileDir, "apps", "mobile", "dist");
if (!existsSync(path.join(dist, "index.html"))) {
    console.error(`No Expo web export at ${dist} — run: cd ${path.join(mobileDir, "apps", "mobile")} && npx expo export --platform web`);
    process.exit(1);
}

const port = Number(process.env.MOBILE_WEB_PORT ?? 19006);
const apiTarget = new URL(process.env.API_TARGET ?? "http://localhost:3000");

const MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".map": "application/json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".wasm": "application/wasm",
};

const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);

    // API proxy — preserve method, headers (incl. Authorization), and body.
    if (url.pathname.startsWith("/api/")) {
        const upstream = httpRequest(
            {
                hostname: apiTarget.hostname,
                port: apiTarget.port,
                path: url.pathname + url.search,
                method: req.method,
                headers: { ...req.headers, host: apiTarget.host },
            },
            proxied => {
                res.writeHead(proxied.statusCode ?? 502, proxied.headers);
                proxied.pipe(res);
            },
        );
        upstream.on("error", err => {
            res.writeHead(502, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: `proxy: ${err.message}` }));
        });
        req.pipe(upstream);
        return;
    }

    // Static file, else SPA fallback to index.html (expo-router client routing).
    const safePath = path.normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, "");
    let filePath = path.join(dist, safePath);
    if (!filePath.startsWith(dist)) {
        res.writeHead(403);
        res.end();
        return;
    }
    if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
        const htmlCandidate = `${filePath.replace(/[/\\]+$/, "")}.html`;
        filePath = existsSync(htmlCandidate) ? htmlCandidate : path.join(dist, "index.html");
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "content-type": MIME[ext] ?? "application/octet-stream" });
    createReadStream(filePath).pipe(res);
});

server.listen(port, () => {
    console.log(`mobile-web: serving ${dist} on http://localhost:${port}, /api -> ${apiTarget.origin}`);
});
