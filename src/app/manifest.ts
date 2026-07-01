import type { MetadataRoute } from "next";

// Web App Manifest (served at /manifest.webmanifest) so ProBuild is installable
// to the iPad / phone home screen and launches full-screen ("standalone").
//
// Icons reference the static app/icon.png (192) and app/apple-icon.png (180)
// that Next already emits. The in-app company logo is dynamic (DB-driven via
// getCompanySettings().logoUrl) and intentionally NOT used here — A2HS install
// icons must be static and are cached by the OS at install time.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Golden Touch Remodeling Pro",
    short_name: "GTR Pro",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#f8fafc", // matches the slate-50 body background (splash)
    theme_color: "#1e1e1e", // keep in sync with viewport.themeColor
    orientation: "any",
    icons: [
      { src: "/icon.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/apple-icon.png", sizes: "180x180", type: "image/png" },
    ],
  };
}
