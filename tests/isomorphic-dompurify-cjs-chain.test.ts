// Guard for the prod ERR_REQUIRE_ESM crash on /projects/[id]/contracts and /leads/[id]
// (2026-08-14 .. 2026-09-03). isomorphic-dompurify server-renders our client components
// through jsdom; jsdom >= 27.4 (and cssstyle >= 5) require() ESM-only packages
// (@exodus/bytes, @csstools/css-calc 3), which only works when Node's require(esm) is
// enabled. package.json pins isomorphic-dompurify 2.26.0 (declares jsdom ^26.1.0) and
// overrides jsdom to 26.1.0, the last chain that is plain CJS.
//
// Two things are checked, both in a child process started with require(esm) switched
// off, which reproduces the runtime that crashed in prod:
//   1. the module loads at all (a future bump that reintroduces an ESM-only require
//      fails here instead of in prod);
//   2. DOMPurify on this jsdom still neutralises the parser-sensitive payload classes
//      DOMPurify documents as the reason jsdom is part of its security boundary
//      (mutation XSS via SVG/MathML namespace switches, noscript, malformed nesting,
//      DOM clobbering, javascript: URLs), under each sanitize() configuration the app
//      uses. Browser-side reparsing is not reproducible in a unit test; the page-level
//      Playwright suite covers that path.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

// The three sanitize() configurations used in src/ (grep DOMPurify.sanitize):
//   default            ClientMessaging, PortalEstimateClient, SendEstimateModal
//   USE_PROFILES html  EntityContractsClient, PortalContractClient
//   allowlist          RichTextEditor.sanitizeRichHtml
const CONFIGS = {
    default: null,
    htmlProfile: { USE_PROFILES: { html: true } },
    richText: {
        ALLOWED_TAGS: ["p", "h1", "h2", "h3", "ul", "ol", "li", "strong", "em", "b", "i", "br", "a"],
        ALLOWED_ATTR: ["href", "target", "rel"],
    },
} as const;

const PAYLOADS: Record<string, string> = {
    imgOnerror: '<img src=x onerror=alert(1)><b>hi</b>',
    scriptTag: '<b>hi</b><script>alert(1)</script>',
    svgStyleMxss: '<svg><p><style><img src=x onerror=alert(1)></style></p></svg><b>hi</b>',
    mathMglyphMxss: '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)></style></mglyph></table></mtext></math><b>hi</b>',
    noscriptMxss: '<noscript><p title="</noscript><img src=x onerror=alert(1)>"></p></noscript><b>hi</b>',
    malformedNesting: '<div><p>unclosed <b>hi<i>italic</p></div></b><img src=x onerror=alert(1)',
    svgXlinkJs: '<svg><a xlink:href="javascript:alert(1)"><text>x</text></a></svg><b>hi</b>',
    javascriptHref: '<a href="javascript:alert(1)">x</a><b>hi</b>',
    iframeSrcdoc: '<iframe srcdoc="<script>alert(1)</script>"></iframe><b>hi</b>',
    domClobbering: '<form><input name="attributes"><input name="attributes"><img name="createElement"></form><b>hi</b>',
    templateMxss: '<template><img src=x onerror=alert(1)></template><b>hi</b>',
    commentBreakout: '<!--><img src=x onerror=alert(1)>--><b>hi</b>',
};

const CHILD = `
const D = require('isomorphic-dompurify');
const { configs, payloads } = JSON.parse(process.argv[1]);
const out = {};
for (const [c, cfg] of Object.entries(configs)) {
  out[c] = {};
  for (const [p, html] of Object.entries(payloads)) out[c][p] = cfg ? D.sanitize(html, cfg) : D.sanitize(html);
  out[c].__keepsSafeLink = D.sanitize('<a href="https://example.com" target="_blank" rel="noopener">y</a>', cfg || undefined);
}
process.stdout.write(JSON.stringify(out));
`;

function runInChildWithoutRequireEsm(): Record<string, Record<string, string>> {
    const r = spawnSync(
        process.execPath,
        ["--no-experimental-require-module", "-e", CHILD, JSON.stringify({ configs: CONFIGS, payloads: PAYLOADS })],
        { encoding: "utf8" },
    );
    assert.equal(r.status, 0, `isomorphic-dompurify failed to load with require(esm) disabled:\n${r.stderr}`);
    return JSON.parse(r.stdout);
}

test("isomorphic-dompurify loads with require(esm) disabled", () => {
    const out = runInChildWithoutRequireEsm();
    assert.equal(out.default.imgOnerror, '<img src="x"><b>hi</b>');
});

test("DOMPurify on the pinned jsdom neutralises parser-sensitive XSS under every app config", () => {
    const out = runInChildWithoutRequireEsm();
    for (const c of Object.keys(CONFIGS)) {
        for (const p of Object.keys(PAYLOADS)) {
            const html = out[c][p];
            const where = `${c}/${p}: ${html}`;
            assert.doesNotMatch(html, /\son[a-z]+\s*=/i, `event handler survived ${where}`);
            assert.doesNotMatch(html, /<script/i, `script survived ${where}`);
            assert.doesNotMatch(html, /javascript:/i, `javascript: URL survived ${where}`);
            assert.doesNotMatch(html, /srcdoc/i, `srcdoc survived ${where}`);
            assert.doesNotMatch(html, /name="(attributes|createElement)"/, `DOM clobbering name survived ${where}`);
            assert.doesNotMatch(html, /<(iframe|template)/i, `${where}`);
            assert.match(html, /<b>hi<\/b>|hi/, `benign content lost ${where}`);
        }
        // The rich-text allowlist must also drop every tag outside it.
        if (c === "richText") {
            for (const p of Object.keys(PAYLOADS)) {
                assert.doesNotMatch(out[c][p], /<(img|svg|math|style|form|input|noscript|div|table)\b/i, `${c}/${p}: ${out[c][p]}`);
            }
        }
        // DOMPurify strips target= by default (only the rich-text allowlist re-adds it); href must survive everywhere.
        assert.match(out[c].__keepsSafeLink, /^<a href="https:\/\/example\.com"[^>]*>y<\/a>$/, `${c} broke a safe link: ${out[c].__keepsSafeLink}`);
    }
});
