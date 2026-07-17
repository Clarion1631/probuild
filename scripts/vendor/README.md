# scripts/vendor — Room Designer CC0 asset kits

`npm run assets:download` extracts GLB models from zip kits that live in this
directory. The zips are **not** committed (see repo `.gitignore`) — each
developer or CI runner drops them here once.

## Required zips

| Filename | Source | License |
|---|---|---|
| `quaternius-ultimate-house-interior.zip` | https://quaternius.com/packs/ultimatehomeinterior.html | CC0 |
| `kenney_building-kit.zip` | https://kenney.nl/assets/building-kit | CC0 |
| `kenney_furniture-kit.zip` | https://kenney.nl/assets/furniture-kit | CC0 |

Primary coverage comes from the Quaternius pack (cabinets, appliances,
bathroom fixtures). Kenney Building Kit supplies doors and windows. Kenney
Furniture Kit is a fallback for proxy swaps later.

## Usage

1. Download the three zips from the source URLs above.
2. Drop them into this directory with the **exact filenames** above — the
   script matches by filename, not by inspecting zip contents.
3. `npm run assets:download -- --dry-run` — prints what would upload.
4. `npm run assets:download` — uploads to the `room-designer-assets` Supabase
   bucket and writes `manifest.json` at the bucket root.

## Why CC0

All three kits are public-domain; no attribution file is required. If a later
swap introduces a CC-BY asset, its manifest entry's `license` field flips to
`"CC-BY"` and an `ATTRIBUTIONS.md` must be added at repo root before shipping.
