require("dotenv").config();
const express = require("express");
const cors    = require("cors");
const path    = require("path");
const fs      = require("fs");

const scriptRoutes = require("./routes/script");
const audioRoutes  = require("./routes/audio");
const videoRoutes  = require("./routes/video");
const mediaRoutes  = require("./routes/media");
const amvRoutes    = require("./routes/amv");

const app  = express();
const PORT = process.env.PORT || 4000;

const OUTPUT_DIR   = path.join(__dirname, "output");
const SESSIONS_DIR = path.join(__dirname, "temp", "sessions");
const CACHE_DIR    = path.join(__dirname, "temp", "render_cache");

["uploads", "output", "temp", "temp/sessions", "temp/render_cache", "assets/music", "data"].forEach(dir => {
  const p = path.join(__dirname, dir);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
});

function cleanOldVideos(keep = 20) {
  try {
    const files = fs.readdirSync(OUTPUT_DIR)
      .filter(f => f.endsWith(".mp4"))
      .map(f => ({ name: f, mtime: fs.statSync(path.join(OUTPUT_DIR, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    files.slice(keep).forEach(({ name }) => { try { fs.unlinkSync(path.join(OUTPUT_DIR, name)); } catch {} });
  } catch {}
}
cleanOldVideos();

// ── Startup: prune render cache older than 3 days ─────────────────────────
try {
  const db = require("./services/database");
  const pruned = db.pruneCacheOlderThan(3);
  if (pruned > 0) console.log(`   🧹 Pruned ${pruned} stale cache entries`);
} catch {}

// ── Start job queue worker ────────────────────────────────────────────────
try {
  const { _ensureWorkerRunning } = require("./services/jobQueue");
  _ensureWorkerRunning();
} catch (e) {
  console.warn("   ⚠️  Job queue worker failed to start:", e.message);
}

app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use("/output",   express.static(OUTPUT_DIR));
app.use("/uploads",  express.static(path.join(__dirname, "uploads")));
app.use("/sessions", express.static(SESSIONS_DIR, {
  etag: false, lastModified: false,
  setHeaders: (res) => {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");
  },
}));

app.get("/health", (req, res) => {
  const hasLLM    = !!(process.env.OPENAI_API_KEY || process.env.GEMINI_API_KEY);
  const hasImages = !!(process.env.PEXELS_API_KEY  || process.env.PIXABAY_API_KEY);
  let dbStats = {};
  try { dbStats = require("./services/database").getDbStats(); } catch {}
  res.json({
    status: "ok", service: "anime-edit-studio-v6",
    config: {
      llm:    hasLLM    ? "configured" : "MISSING",
      images: hasImages ? "configured" : "MISSING",
      tts:    process.env.TTS_SERVICE_URL  || "http://localhost:5050",
      beats:  process.env.BEAT_SERVICE_URL || "http://localhost:5051",
    },
    database: dbStats,
  });
});

app.get("/api/health", (req, res) => res.redirect("/health"));

app.use("/api/script", scriptRoutes);
app.use("/api/audio",  audioRoutes);
app.use("/api/video",  videoRoutes);
app.use("/api/media",  mediaRoutes);
app.use("/api/amv",    amvRoutes);

app.use((err, req, res, next) => {
  console.error("Error:", err.message);
  res.status(500).json({ error: err.message });
});

app.listen(PORT, () => {
  console.log(`\n🎬 Anime Edit Studio v6`);
  console.log(`   Server:      http://localhost:${PORT}`);
  console.log(`   Sessions:    http://localhost:${PORT}/sessions/{id}/scene_N.mp4`);
  console.log(`   Job Queue:   http://localhost:${PORT}/api/amv/jobs/{jobId}/progress (SSE)`);
  console.log(`   Marketplace: http://localhost:${PORT}/api/amv/compositions`);
  console.log("   Gemini Key:", process.env.GEMINI_API_KEY ? "Loaded ✅" : "Missing ❌");
});
