// Shared "ProBuild Clip" bookmarklet builder — the in-page JSON-LD/OpenGraph
// product extraction script used by both the team clipper
// (/company/product-library -> /clip) and the client clipper (portal
// Selections tab -> /portal/clip). Originally lived as buildBookmarkletHref
// inside ProductLibraryClient.tsx; extracted here so both call sites share
// one copy instead of drifting.
//
// Extraction chain: JSON-LD schema.org/Product -> OpenGraph/meta tags. It
// reads the LIVE page DOM in the user's own browser before ever opening the
// target page — the same trick Houzz's clipper uses to beat bot walls like
// Lowe's/Home Depot's Akamai block, which returns a 403 to any server-side
// fetch regardless of User-Agent. Since the user's browser already has the
// rendered page, this never needs to fetch anything itself.
//
// Kept as one compact (not obfuscated, just short-named) IIFE so it fits
// comfortably as a draggable bookmark URL. Extraction logic verified against
// JSON-LD fixtures (array/object image, string/object brand, array offers,
// AggregateOffer.lowPrice) and a fake-DOM harness in a throwaway script
// before being embedded here — see the product-library-clipper PR
// description for the harness.
export interface BuildClipperBookmarkletOptions {
    /** Site origin, e.g. NEXT_PUBLIC_APP_URL. No trailing slash expected. */
    origin: string;
    /** Path the popup opens, e.g. "/clip" or "/portal/clip". */
    targetPath: string;
    /** Static params baked into the target URL ahead of the page-extracted
     * ones (e.g. { projectId } for the per-project client clipper). */
    extraParams?: Record<string, string>;
}

export function buildClipperBookmarklet({ origin, targetPath, extraParams }: BuildClipperBookmarkletOptions): string {
    const extraQS = extraParams
        ? Object.entries(extraParams)
              .filter(([, v]) => v)
              .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
              .join("&")
        : "";
    const openUrlPrefix = `${origin}${targetPath}?${extraQS ? `${extraQS}&` : ""}`;

    const js =
        "(function(){function I(v){if(!v)return'';if(Array.isArray(v))v=v[0];if(v&&typeof v==='object')return v.url||'';return typeof v==='string'?v:''}" +
        "function B(b){if(!b)return'';return typeof b==='string'?b:(b.name||'')}" +
        "function O(o){if(!o)return{};if(Array.isArray(o))o=o[0];if(!o)return{};var p=o.price!=null?o.price:o.lowPrice;return{p:p,c:o.priceCurrency||''}}" +
        "var nm='',im='',pr='',cu='',vd='';" +
        "var ss=document.querySelectorAll('script[type=\"application/ld+json\"]');" +
        "F:for(var i=0;i<ss.length;i++){var d;try{d=JSON.parse(ss[i].textContent)}catch(e){continue}" +
        "var cs=Array.isArray(d)?d:[d];" +
        "for(var c=0;c<cs.length;c++){var cd=cs[c];var ns=(cd&&cd['@graph'])?cd['@graph']:[cd];" +
        "for(var n=0;n<ns.length;n++){var nd=ns[n];if(!nd)continue;var t=nd['@type'];var ts=Array.isArray(t)?t:[t];" +
        "var isP=ts.some(function(x){return typeof x==='string'&&x.toLowerCase()==='product'});if(!isP)continue;" +
        "nm=nd.name||'';im=I(nd.image);var of=O(nd.offers);pr=(of.p!=null?of.p:'');cu=of.c||'';vd=B(nd.brand);break F}}}" +
        "function M(s){var e=document.querySelector(s);return e?(e.getAttribute('content')||''):''}" +
        "if(!nm)nm=M('meta[property=\"og:title\"]')||document.title||'';" +
        "if(!im)im=M('meta[property=\"og:image\"]');" +
        "if(!pr)pr=M('meta[property=\"product:price:amount\"]');" +
        "if(!cu)cu=M('meta[property=\"product:price:currency\"]');" +
        "nm=String(nm).slice(0,200);im=String(im).slice(0,1000);" +
        "var ps=[];function A(k,v){if(v)ps.push(k+'='+encodeURIComponent(v))}" +
        "A('url',location.href);A('name',nm);A('price',pr);A('currency',cu);A('image',im);A('vendor',vd);" +
        "window.open('" + openUrlPrefix + "'+ps.join('&'),'probuild-clip','width=480,height=720')" +
        "})();";
    return "javascript:" + js;
}
