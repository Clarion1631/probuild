# ProBuild Field App — Rollout Handoff

> Pickup doc for the iPhone/iPad field-app rollout (lead intake → LiDAR scan →
> web edit → client share/AR). Last updated June 12, 2026.
>
> ⚠️ Contains an internal login PIN. Internal use only — do not commit to a
> public remote or share outside the team.

---

## TL;DR — the ONE thing blocking go-live

The app is built, on TestFlight, installed on the iPad, and every backend
piece (leads, Drive, scan, AR, share) is live and verified. **But the app
crashes on launch.** iPadOS 18.5 / M2 iPad Pro is fully capable, so it's a
code bug in the build, not the device.

**Next action (needs Richard + the iPad):**
1. Open **ProBuild Field** → it crashes → the "ProBuild Field Crashed" dialog appears
2. Tap **"Share"** (uploads the symbolicated crash report to App Store Connect)
3. Then pull the crash + fix:
   - App Store Connect → Apps → ProBuild Field → TestFlight → the build → Crashes/Feedback, **or** Xcode Organizer
   - Diagnose the exact stack, fix, rebuild + submit (commands below), push OTA if JS-only

Top untested suspects (need the log to confirm — don't guess-build):
- expo-updates launch behavior in a release build
- reanimated 4.1.6 / react-native-worklets 0.5.1 native init (New Arch is ON and required by reanimated 4)
- a JS module throwing at top-level eval in the release bundle

---

## Status board

| Piece | Status |
|---|---|
| Apple Developer Program (Organization) | ✅ active — Golden Touch Remodeling LLC, Team ID `GY5C882C5P` |
| App Store Connect app record | ✅ "ProBuild Field", Apple app id `6779754743`, bundle `com.goldentouchremodeling.probuild`, SKU `probuild-field` |
| iOS signing (cert + profile) | ✅ created via ASC API, stored local `~/.appstoreconnect/` |
| iOS build #5 | ✅ VALID on TestFlight |
| TestFlight internal group "Field Team" | ✅ group id `0e96b2ac-ea9d-4d23-8ca9-b7a3f37e3882`; testers: ipad@ + (forward to Richard) |
| Web backend (lead APIs, Drive, USDZ/AR, renders, extension) | ✅ deployed to prod |
| Google Drive → per-lead folders | ✅ connected as **gtrsupport@goldentouchremodeling.com** ("Margaret Spencer"), verified end-to-end |
| Richard's app login (PIN) | ✅ ready — see Credentials |
| **App launches without crashing** | ❌ **BLOCKER — see TL;DR** |
| Google Play (Android) | ⏳ org account created, in Google identity verification (days). Android has NO scan/AR (Apple-only). No rush. |

---

## Credentials & IDs to resume

**Repos**
- Web: `C:\Users\jat00\workspaces\golden-touch\active\gtr-probuild-site` (branch `main`, deployed)
- Mobile: `C:\Users\jat00\workspaces\golden-touch\active\gtr-probuild-mobile`, app at `apps/mobile`, branch **`feat/room-scan`** (latest mobile work `014b6ea`/`b569e64`)

**Apple / TestFlight**
- ASC API key: `~/.appstoreconnect/AuthKey_79PF67DMKC.p8` · Key ID `79PF67DMKC` · Issuer `10d997a5-7cd0-4497-81cf-d4e1e44c7d48`
- Apple Team ID `GY5C882C5P` · bundle resource id `747HUCTXRV`
- Local signing: `~/.appstoreconnect/dist.p12` (password in `~/.appstoreconnect/p12-password.txt`), profile `probuild.mobileprovision`
- `apps/mobile/credentials.json` points EAS at the local cert/profile (gitignored)
- EAS/Expo: account `justinadkins007`, project `f87a723c-2580-4dbd-9da7-3ef7ba03f6a7`, authed via `$EXPO_TOKEN`

**Richard's app login (PIN path, no Google needed)**
- Email `rlord@goldentouchremodeling.com` · **PIN `662161`** · role ADMIN (sees Leads)
- (PIN is bcrypt-hashed in prod User.pinCode; reset by hashing a new 6-digit and UPDATE)

**Google Drive integration**
- Dedicated OAuth client "ProBuild Drive" in Cloud project **ProBuild** (`gen-lang-client-0954911963` = project# `974065480592`)
- Env: `GOOGLE_DRIVE_CLIENT_ID` / `GOOGLE_DRIVE_CLIENT_SECRET` (Vercel all envs + web `.env.local`); local JSON at `~/.google-oauth/probuild-drive-client.json`
- Connected account: **gtrsupport@goldentouchremodeling.com** (rotate its password — it passed through chat; connection survives on the stored refresh token)
- Refresh token in `CompanySettings.googleDriveRefreshToken`; lead media root = "ProBuild Leads" in that Drive

**Vercel**
- Project `prj_sd7R3WIYZCRMnu5IhAudBdc4vuIL`, scope `justins-projects-a2347a8d`, token `$VERCEL_TOKEN`

---

## Build / submit / deploy commands

**iOS build → TestFlight** (from `apps/mobile`):
```bash
npx eas-cli build -p ios --profile production --non-interactive   # ~20 min, uses local credentials.json
npx eas-cli submit -p ios --latest --non-interactive              # ascAppId 6779754743 in eas.json
# JS-only change instead of full rebuild:
npx eas-cli update --channel production --message "..."           # OTA, seconds
```

**Web deploy** (from `gtr-probuild-site`, auto-deploy is OFF by design):
```bash
vercel deploy --prod --yes --scope justins-projects-a2347a8d --token $VERCEL_TOKEN --archive=tgz
```

---

## What was built this session (architecture)

**Studio (web) — shipped earlier in session, all on prod `main`:**
- Recessed shower niches (real wall cutout + tiled liner) + optional LED strip (RectAreaLight even wash)
- Photoreal AI renders: TopBar "Photo render" → Gemini `gemini-2.5-flash-image` re-renders the live view → Supabase storage → `RoomRender`; gallery + share-page strip
- "Send to ProBuild" MV3 browser extension (`extension/`) → `/api/studio-library/clip` → Clips inbox on Settings → Design Catalog
- Product Library (`CatalogFinish`/`CatalogProduct`) + 138 TheRTAStore cabinet lines imported

**Field app (mobile `feat/room-scan` + web mobile APIs on `main`):**
- Leads list / new-lead / lead detail screens (`apps/mobile/app/leads/`)
- Notes, photos (Supabase + Drive mirror), walkthrough video (phone→Drive resumable), LiDAR scan under a lead, "View in AR" (Apple Quick Look / USDZ)
- Web APIs: `/api/mobile/leads` (+`[id]`, `/notes`, `/drive-video`), `/api/rooms/[id]/usdz`; access gated by `lib/lead-access.ts`
- Per-lead Drive folders via `lib/lead-drive.ts`; share page shows "View in AR" on iOS (`ShareStudio`)

**Key gotchas discovered**
- Web-login Google client (`907285576178…`) lives in an inaccessible Cloud project → can't add redirect URIs → that's why Drive needed its OWN client. Don't touch `GOOGLE_CLIENT_ID`.
- Setting Vercel env vars via PowerShell pipe injects a BOM+CRLF → `invalid_client`. Use bash `printf '%s' "$VAL" | vercel env add`.
- The Drive OAuth Cloud project needs **Drive API enabled** (console → APIs → Enable) or all calls 403 SERVICE_DISABLED.
- Consent app is External + Testing → only listed test users can authorize (jadkins@, rlord@, gtrsupport@, justin.t.adkins@ added).
- expo-roomplan needs iOS 17+ (`deployment_target 17.0`); iPad is 18.5 so fine.

**Memory:** see `~/.claude/projects/<proj>/memory/probuild-mobile-lead-intake.md` and `probuild-room-studio.md` for the durable version of all the above.

---

## Resume checklist

1. Get the crash log (Richard taps Share → read in ASC/Xcode) → fix → rebuild + submit.
2. Once it launches: Richard signs in (PIN 662161) → New Lead → take photos/video → Scan room → confirm folder appears in gtrsupport@ Drive + lead shows in web app.
3. Open the lead on web → Room Designer → design → Share → confirm client share page + "View in AR" on an iPhone.
4. (Optional) rotate gtrsupport@ password; enable Gmail API in the ProBuild Cloud project if email automation moves to this client.
5. (Optional) when an Android user appears: finish Play identity verification, then `eas build/submit -p android`.
