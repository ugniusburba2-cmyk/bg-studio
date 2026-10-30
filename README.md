# BG Studio

Personal app for resellers: drop in product photos, get the **same realistic background on every photo** — product untouched, lighting matched. Runs on Gemini (Nano Banana) with your own API key. Works as an iPhone home-screen app.

## What it does
- **Projects** — one per product, saved on your phone (survives closing the app).
- **Backgrounds** — ✨ AI suggests 4 that fit your product, or upload your own, or type one. Your background is adapted to each photo (angle, perspective, shadows), not pasted flat.
- **One prompt → all photos** — "New background" regenerates every photo; "Add / edit" (e.g. *add a small plant*) — AI decides which photos it fits (skips close-ups / tag shots), you can tick/untick.
- **Project memory** — edits with "Remember" on get re-applied every time you regenerate.
- **🎲 New variation set** — fresh versions of all photos for re-listing the same product.
- **Version history** per photo — tap a photo to switch versions, redo, edit just that one, or save.
- **Save all** — iPhone share sheet → "Save Images" to Photos.
- **Backup** — Settings → Export / Import.

## Setup (10 minutes)

### 1. API key
1. Go to **aistudio.google.com** → **Get API key** → create key.
2. Turn on billing for that key's project — image generation through the API isn't free (it's cheap per image).

### 2. Put it on GitHub
1. github.com → **New repository** → name it `bg-studio` → Public → Create.
2. **Add file → Upload files** → drag in everything in this folder (keep the `js` and `icons` folders) → Commit.
3. Repo **Settings → Pages** → Source: *Deploy from a branch* → Branch: `main`, folder `/ (root)` → Save.
4. Wait ~1 minute. Your app is at `https://YOUR-USERNAME.github.io/bg-studio/`.

### 3. Put it on your iPhone
1. Open that link in **Safari**.
2. Share button → **Add to Home Screen**.
3. Open it from the home screen → ⚙︎ Settings → paste your key → **Test key** (it auto-picks the best available models).

## Tips
- Take photos with the product fully in frame and good light; the AI keeps the product as-is, so a better input = better output.
- Keep the app open while it generates (iOS pauses apps in the background).
- Export a backup now and then.
- Optional safety: in Google Cloud Console → Credentials, restrict your key to the website `https://YOUR-USERNAME.github.io/*`.
- If Google renames models, just tap **Test key** again in Settings.

## Files
`index.html`, `styles.css` — UI · `js/app.js` — screens & logic · `js/gemini.js` — API · `js/prompts.js` — all AI prompts (tweak here) · `js/db.js` — on-device storage · `sw.js`, `manifest.json`, `icons/` — home-screen app bits.
