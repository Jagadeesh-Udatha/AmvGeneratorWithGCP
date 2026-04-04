# Anime Video Generator — Bug Fixes (v2.1)

## What changed and why

### 1. edge-tts 403 error (`python-tts-service/app.py`)

**Problem:** Microsoft periodically rotates the auth token embedded in
`edge-tts`. The old installed version uses a stale token, causing every
neural TTS request to fail with a WebSocket 403.

**Fix:**
- Upgraded `edge-tts` to the latest version (see `upgrade.sh`)
- Added a clear actionable error message when 403 occurs:
  `"edge-tts 403 — fix: pip install --upgrade edge-tts"`
- Added **Kokoro TTS** as a second neural-quality fallback (offline, no
  network needed). Install: `pip install kokoro soundfile`
- gTTS remains the final safety net
- Added background thread that auto-deletes TTS output files older than
  1 hour so the `output/` folder never fills up

### 2. Gemini 429 rate-limiting (`node-service/services/scriptGenerator.js`)

**Problem:** Gemini free tier has strict RPM limits. On the first 429
the pipeline silently fell back to the template generator, producing
low-quality non-AI scripts with no retry attempt.

**Fixes:**
- **Switched model** from `gemini-2.0-flash` → `gemini-1.5-flash`.
  The 1.5 Flash model has a more generous free-tier quota (15 RPM vs
  the lower limit on 2.0 Flash).
- **Exponential retry** — up to 3 attempts with 2s / 4s / 8s backoff
  before falling back to the template. A transient 429 now auto-recovers.
- Retry log: `⚠️  Gemini 429 — retrying in 2s (attempt 1/3)...`

### 3. Image search returning irrelevant results (`scriptGenerator.js`)

**Problem:** Pexels and Pixabay are stock photo APIs — they carry no
licensed anime character images. Sending queries like
`"Goku Dragon Ball Super Saiyan"` returns random landscape/person photos.

**Fixes:**
- **Visual query sanitizer** (`sanitizeVisualQuery`) strips ~60 known IP
  character names and series titles from every query before it's sent to
  the image API. Replaces them with descriptive visual terms.
- **System prompt updated** — explicitly instructs the LLM not to use
  character names in `visual_query` fields, with BAD/GOOD examples.
- **Fallback template** now uses pre-written descriptive queries instead
  of `anime ${rawPrompt}`.

### 4. Subtitles not appearing (`node-service/services/videoGenerator.js`)

**Problem:** The startup log showed `subs=none` because the ffmpeg
filter detection only checked `-filters` output. Some Homebrew builds
report these capabilities in `-buildconf` instead.

**Fixes:**
- Detection now checks **both** `ffmpeg -filters` and `ffmpeg -buildconf`
- If subtitles are still unavailable, prints specific install commands:
  ```
  ➡  To enable subtitles on macOS: brew install ffmpeg
  ➡  If already installed: brew reinstall ffmpeg
  ➡  On Linux: sudo apt install ffmpeg
  ```
- Cleanup function now wraps each `fs.unlinkSync` individually — one
  failed delete no longer aborts the others

### 5. Output videos accumulate forever (`node-service/server.js`)

**Problem:** Generated `.mp4` files in `node-service/output/` are never
removed, eventually filling the disk.

**Fix:** `cleanOldVideos(20)` runs at startup — sorts all `.mp4` files
by modification time and deletes everything beyond the 20 most recent.

---

## How to apply the fixes

The fixed files are drop-in replacements. Copy them into your project:

```bash
# From the root of this zip
cp node-service/server.js           /your/project/node-service/
cp node-service/services/scriptGenerator.js   /your/project/node-service/services/
cp node-service/services/videoGenerator.js    /your/project/node-service/services/
cp python-tts-service/app.py        /your/project/python-tts-service/

# Then upgrade edge-tts
cd /your/project/python-tts-service
pip install --upgrade edge-tts
```

Or just run:
```bash
bash upgrade.sh /your/project
```
