/**
 * AMV Routes v6.0 — Real-Time Multi-User Architecture
 *
 * NEW IN v6:
 *   - POST /api/amv/prepare  → returns jobId immediately (non-blocking)
 *   - GET  /api/amv/jobs/:jobId/progress  → SSE stream of render progress per scene
 *   - GET  /api/amv/jobs/:jobId  → poll job status + result
 *   - GET  /api/amv/compositions  → list DB-driven composition marketplace
 *   - POST /api/amv/compositions  → submit new composition (user/admin)
 *   - POST /api/amv/compositions/:id/vote  → community upvote
 *   - PATCH /api/amv/compositions/:id/toggle  → admin enable/disable
 *   - GET  /api/amv/cache/stats  → render cache stats
 *   - POST /api/amv/cache/prune  → prune old cache entries
 *   - All original v5 endpoints preserved
 */

const express   = require("express");
const router    = express.Router();
const multer    = require("multer");
const path      = require("path");
const fs        = require("fs");
const axios     = require("axios");
const { v4: uuidv4 } = require("uuid");

const { generateAMV, EMOTION_PALETTES }  = require("../services/amvGenerator");
const { prepareSession, rerenderScene, exportSession, cleanSession, listSessions, previewTransition } = require("../services/sceneRenderer");
const { suggestEffects, getPatterns, getModelInfo } = require("../services/editClassifier");
const { applyStutterCuts } = require("../services/stutterCutEngine");
const { adviseScenesWithLLM } = require("../services/llmEditAdvisor");
const { COMPOSITIONS, COMPOSITION_CATEGORIES } = require("../services/compositionEngine");
const { enqueueJob, sseProgressHandler } = require("../services/jobQueue");
const db = require("../services/database");

const {
  MOTION_EFFECTS, TRANSITIONS, COLOR_GRADES, OVERLAYS,
  EFFECT_CATEGORIES, TRANSITION_CATEGORIES, GRADE_CATEGORIES,
} = require("../services/effectsLibrary");

const UPLOADS_DIR  = path.join(__dirname, "..", "uploads");
const BEAT_SERVICE = process.env.BEAT_SERVICE_URL || "http://localhost:5051";
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Seed built-in compositions into DB on startup
try {
  db.seedBuiltinCompositions([...COMPOSITIONS], COMPOSITION_CATEGORIES);
} catch {}

const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || ".bin";
    cb(null, `upload_${Date.now()}_${Math.random().toString(36).slice(2,7)}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 300 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /\.(jpg|jpeg|png|gif|webp|mp4|mov|avi|mkv|webm|mp3|wav|aac|m4a|ogg|flac)$/i.test(file.originalname);
    cb(ok ? null : new Error(`Unsupported: ${file.originalname}`), ok);
  },
});

function isVideo(p) { return /\.(mp4|mov|avi|mkv|webm|m4v)$/i.test(p); }

// ─── UPLOAD ───────────────────────────────────────────────────────────────────

router.post("/upload", upload.array("files", 50), (req, res) => {
  if (!req.files?.length) return res.status(400).json({ error: "No files uploaded" });
  res.json({
    success: true,
    files: req.files.map(f => ({
      originalName: f.originalname,
      path: f.path,
      url:  `/uploads/${f.filename}`,
      size: f.size,
      type: isVideo(f.originalname) ? "video"
          : /\.(mp3|wav|aac|m4a|ogg|flac)$/i.test(f.originalname) ? "audio"
          : "image",
    })),
  });
});

// ─── ANALYZE ──────────────────────────────────────────────────────────────────

router.post("/analyze", async (req, res) => {
  const { audio_path, sensitivity = 0.5 } = req.body;
  if (!audio_path || !fs.existsSync(audio_path))
    return res.status(400).json({ error: "audio_path not found: " + audio_path });
  try {
    const r = await axios.post(`${BEAT_SERVICE}/analyze`, { audio_path, sensitivity }, { timeout: 90000 });
    res.json({ success: true, ...r.data });
  } catch (err) {
    res.json({ success: false, fallback: true, error: err.message, bpm: 120, beats: [], drops: [] });
  }
});

// ─── OPTIONS ──────────────────────────────────────────────────────────────────

router.get("/options", (req, res) => {
  res.json({
    effects:               [...MOTION_EFFECTS],
    transitions:           [...TRANSITIONS],
    color_grades:          [...COLOR_GRADES],
    overlays:              [...OVERLAYS],
    compositions:          [...COMPOSITIONS],
    composition_categories: COMPOSITION_CATEGORIES,
    emotion_palettes:      EMOTION_PALETTES,
    effect_categories:     EFFECT_CATEGORIES,
    transition_categories: TRANSITION_CATEGORIES,
    grade_categories:      GRADE_CATEGORIES,
    edit_patterns:         getPatterns(),
  });
});

router.get("/model-info", (req, res) => {
  res.json({ success: true, classifier: getModelInfo() });
});

router.get("/db-stats", (req, res) => {
  res.json({ success: true, stats: db.getDbStats() });
});

router.post("/session/:sessionId/rate", (req, res) => {
  const { rating } = req.body;
  if (!rating || rating < 1 || rating > 5) return res.status(400).json({ error: "Rating 1-5" });
  db.rateSession(req.params.sessionId, rating);
  res.json({ success: true });
});

router.get("/edited-scenes", (req, res) => {
  const scenes = db.getEditedScenes(parseInt(req.query.limit) || 5000);
  res.json({ success: true, count: scenes.length, scenes });
});

// ─── PREPARE SESSION (async — returns jobId immediately) ───────────────────────

router.post("/prepare", async (req, res) => {
  const {
    audio_path,
    media_paths = [],
    sensitivity = 0.5,
    aspect_ratio = "9:16",
    max_duration = 60,
    beat_map = {},
    async_mode = true,  // default: async (non-blocking)
  } = req.body;

  // Extract BYOK keys from request headers (frontend sends these)
  const byokKeys = {
    anthropic: req.headers["x-anthropic-key"] || null,
    gemini:    req.headers["x-gemini-key"]    || null,
    openai:    req.headers["x-openai-key"]    || null,
  };

  if (!audio_path || !fs.existsSync(audio_path))
    return res.status(400).json({ error: "audio_path not found" });
  if (!media_paths.length)
    return res.status(400).json({ error: "No media_paths provided" });

  // ── Build scenes synchronously (fast — just beat analysis + LLM) ──────
  try {
    const t0 = Date.now();
    let beatData;
    try {
      const r = await axios.post(`${BEAT_SERVICE}/analyze`, { audio_path, sensitivity }, { timeout: 90000 });
      beatData = r.data;
    } catch {
      beatData = null;
    }

    const width  = aspect_ratio === "9:16" ? 1080 : 1920;
    const height = aspect_ratio === "9:16" ? 1920 : 1080;

    if (!beatData) {
      const bpm = 120, secPerBeat = 60 / bpm, dur = 30;
      const beats = [], drops = [];
      for (let t = 0; t < dur; t += secPerBeat) beats.push(parseFloat(t.toFixed(3)));
      for (let t = 0; t < dur; t += secPerBeat * 4) drops.push(parseFloat(t.toFixed(3)));
      beatData = { bpm, duration: dur, beats, beat_strengths: beats.map(() => 0.5), drops, drop_strengths: drops.map(() => 0.7), drop_emotions: drops.map(() => "neutral"), segment_features: [] };
    }

    const totalDur     = Math.min(beatData.duration || 30, max_duration);
    const drops        = (beatData.drops || []).filter(t => t < totalDur);
    const dropStr      = beatData.drop_strengths || drops.map(() => 0.7);
    const dropEmos     = beatData.drop_emotions  || drops.map(() => "neutral");
    const allBeats     = (beatData.beats || []).filter(t => t < totalDur);
    const beatStr      = beatData.beat_strengths || allBeats.map(() => 0.5);
    const segFeats     = beatData.segment_features || [];
    const finalDrops   = drops.length > 0 ? drops : allBeats.filter((_, i) => i % 4 === 0);
    const finalDropStr = drops.length > 0 ? dropStr : finalDrops.map(() => 0.7);
    const finalDropEmos= drops.length > 0 ? dropEmos : finalDrops.map(() => "neutral");

    const boundaries = [0, ...finalDrops, totalDur].filter((t, i, arr) => t !== arr[i - 1]);

    // ── BEAT-SYNC QUANTIZATION: snap boundaries to nearest beat ──────────
    const fps = 30;
    const frameStep = 1 / fps; // 33ms
    const quantizedBoundaries = boundaries.map(b => {
      if (b === 0 || b === totalDur) return b;
      // Find nearest beat
      let nearest = b;
      let minDist = Infinity;
      for (const beat of allBeats) {
        const dist = Math.abs(beat - b);
        if (dist < minDist) { minDist = dist; nearest = beat; }
      }
      // Only snap if within 100ms tolerance
      if (minDist < 0.1) {
        // Round to nearest frame boundary
        return Math.round(nearest * fps) / fps;
      }
      return Math.round(b * fps) / fps;
    });

    const rawScenes  = [];

    for (let i = 0; i < quantizedBoundaries.length - 1; i++) {
      const sceneStart = quantizedBoundaries[i];
      const sceneEnd   = quantizedBoundaries[i + 1];
      const sceneDur   = parseFloat((sceneEnd - sceneStart).toFixed(3));
      if (sceneDur < 0.3) continue; // Skip very short scenes — they cause playback stutters

      const dropIdx    = i;
      const strength   = dropIdx > 0 ? (finalDropStr[dropIdx - 1] ?? 0.7) : 0;
      const emotion    = dropIdx > 0 ? (finalDropEmos[dropIdx - 1] ?? "neutral") : (finalDropEmos[0] ?? "neutral");
      const segFeat    = segFeats[dropIdx] || null;

      const sceneBeats = allBeats.filter(t => t >= sceneStart && t < sceneEnd).map(t => parseFloat((t - sceneStart).toFixed(3)));
      const sceneStrengths = sceneBeats.map(bt => {
        const idx = allBeats.findIndex(t => Math.abs(t - (bt + sceneStart)) < 0.01);
        return idx >= 0 ? (beatStr[idx] ?? 0.5) : 0.5;
      });

      rawScenes.push({
        index: rawScenes.length,
        mediaPath: media_paths[rawScenes.length % media_paths.length],
        start: sceneStart, end: sceneEnd, duration: sceneDur,
        dropStrength: strength, emotion, beatsInScene: sceneBeats,
        beatStrengths: sceneStrengths, segmentFeatures: segFeat,
      });
    }

    // Visual features
    try {
      const uniquePaths = [...new Set(rawScenes.map(s => s.mediaPath))];
      const vfRes = await axios.post(`${BEAT_SERVICE}/extract-visual-batch`, { image_paths: uniquePaths }, { timeout: 30000 });
      if (vfRes.data?.success) {
        const featureMap = {};
        for (const r of vfRes.data.results) { if (r.features) featureMap[r.path] = r.features; }
        for (const scene of rawScenes) { scene.visualFeatures = featureMap[scene.mediaPath] || null; }
        console.log(`   👁  Visual features: ${Object.keys(featureMap).length} / ${uniquePaths.length} images`);
      }
    } catch (vfErr) {
      console.log(`   ⚠️  Visual features skipped: ${vfErr.message}`);
    }

    // LLM advice (primary) → pattern classifier (fallback)
    let suggestedScenes;
    try {
      const llmResult = await adviseScenesWithLLM(rawScenes, {
        byokKeys,
        audioPath: audio_path,
        imagePaths: media_paths,
      });
      suggestedScenes = llmResult || suggestEffects(rawScenes, { bpm: beatData.bpm || 120, energy: 0.5 }, beatData);
    } catch {
      suggestedScenes = suggestEffects(rawScenes, { bpm: beatData.bpm || 120, energy: 0.5 }, beatData);
    }

    // Apply beat_map overrides
    const scenesBeforeStutter = suggestedScenes.map((scene, i) => {
      const override = beat_map[String(i)] || {};
      return {
        ...scene,
        effect:     override.effect     || scene.effect,
        transition: override.transition || scene.transition,
        colorGrade: override.colorGrade || scene.colorGrade || "none",
        overlays:   override.overlays   || scene.overlays   || [],
      };
    });

    const scenes = applyStutterCuts(scenesBeforeStutter, allBeats, { bpm: beatData.bpm || 120, enabled: true });
    scenes.forEach((s, i) => { s.index = i; });

    const sessionId = uuidv4().slice(0, 12);

    // ── ASYNC MODE: enqueue FFmpeg renders, return immediately ──
    if (async_mode) {
      const jobId = enqueueJob({
        type: "prepare",
        sessionId,
        params: { sessionId, scenes, audioPath: audio_path, width, height, fps: 30 },
        priority: 5,
      });

      // Save session stub to DB
      const emoSummary = scenes.map(s => s.emotion).reduce((acc, e) => { acc[e] = (acc[e] || 0) + 1; return acc; }, {});
      db.saveSession({ sessionId, audioFile: audio_path, bpm: beatData.bpm, sceneCount: scenes.length, totalDuration: totalDur, aspectRatio: aspect_ratio, emotionSummary: JSON.stringify(emoSummary), jobId });
      db.saveScenes(sessionId, scenes);

      const analyzeTime = ((Date.now() - t0) / 1000).toFixed(1);

      const audioUrl = `/uploads/${path.basename(audio_path)}`;
      return res.json({
        success:      true,
        async:        true,
        jobId,
        sessionId,
        audioUrl,
        totalDuration: totalDur,
        bpm:          beatData.bpm,
        dropCount:    finalDrops.length,
        sceneCount:   scenes.length,
        analyzeTime:  `${analyzeTime}s`,
        message:      `Analysis complete. ${scenes.length} scenes queued for render.`,
        progressUrl:  `/api/amv/jobs/${jobId}/progress`,
        statusUrl:    `/api/amv/jobs/${jobId}`,
        scenes: scenes.map(s => ({
          index: s.index, start: s.start, duration: s.duration, emotion: s.emotion,
          effect: s.effect, transition: s.transition, colorGrade: s.colorGrade || "none",
          overlays: s.overlays || [], composition: s.composition || null,
          llmReasoning: s.llmReasoning || null, editSource: s.editSource || "patterns",
        })),
      });
    }

    // ── SYNC MODE (legacy) — blocks until all scenes rendered ──
    console.log(`\n${"═".repeat(60)}`);
    console.log(`🎬 PREPARE SESSION ${sessionId}: ${scenes.length} scenes`);
    console.log(`${"═".repeat(60)}`);

    const meta = await prepareSession({ sessionId, scenes, audioPath: audio_path, width, height, fps: 30 });
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`✅ Session ready in ${elapsed}s`);

    const emoSummary = scenes.map(s => s.emotion).reduce((acc, e) => { acc[e] = (acc[e] || 0) + 1; return acc; }, {});
    db.saveSession({ sessionId, audioFile: audio_path, bpm: beatData.bpm, sceneCount: meta.scenes.length, totalDuration: totalDur, aspectRatio: aspect_ratio, emotionSummary: JSON.stringify(emoSummary) });
    db.saveScenes(sessionId, scenes);

    res.json({
      success:       true,
      async:         false,
      sessionId,
      totalDuration: totalDur,
      bpm:           beatData.bpm,
      dropCount:     finalDrops.length,
      sceneCount:    meta.scenes.length,
      preparationTime: `${elapsed}s`,
      scenes: meta.scenes.map(s => ({
        index: s.index, start: s.start, duration: s.duration, emotion: s.emotion,
        effect: s.effect, transition: s.transition, colorGrade: s.colorGrade || "none",
        overlays: s.overlays || [], composition: s.composition || null,
        previewUrl: s.previewUrl, thumbUrl: s.thumbUrl,
        llmReasoning: s.llmReasoning || null, editSource: s.editSource || "patterns",
        isStutterCut: s.isStutterCut || false,
      })),
    });

  } catch (err) {
    console.error("❌ Prepare failed:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── JOB STATUS + SSE PROGRESS ───────────────────────────────────────────────

// SSE: real-time progress stream
router.get("/jobs/:jobId/progress", sseProgressHandler);

// Poll: current job state
router.get("/jobs/:jobId", (req, res) => {
  const job = db.getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });

  // If done, try to enrich with session meta
  let sessionData = null;
  if (job.status === "done" && job.session_id) {
    try {
      const sessionsDir = path.join(__dirname, "..", "temp", "sessions");
      const metaPath = path.join(sessionsDir, job.session_id, "meta.json");
      if (fs.existsSync(metaPath)) {
        const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
        let audioUrl = null;
        if (meta.audioPath) audioUrl = `/uploads/${path.basename(meta.audioPath)}`;
        sessionData = {
          sessionId: meta.sessionId,
          sceneCount: meta.scenes.length,
          audioUrl,
          scenes: meta.scenes.map(s => ({
            index: s.index, duration: s.duration, emotion: s.emotion,
            effect: s.effect, transition: s.transition,
            colorGrade: s.colorGrade || "none", overlays: s.overlays || [],
            composition: s.composition || null,
            previewUrl: s.previewUrl, thumbUrl: s.thumbUrl,
            start: s.start, llmReasoning: s.llmReasoning || null,
            editSource: s.editSource || "patterns",
            dropStrength: s.dropStrength || 0,
          })),
        };
      }
    } catch {}
  }

  res.json({
    success: true,
    job: {
      id:          job.id,
      type:        job.job_type,
      status:      job.status,
      pct:         job.progress_pct || 0,
      label:       job.progress_label || "Queued",
      scenesDone:  job.scenes_done || 0,
      totalScenes: job.total_scenes || 0,
      createdAt:   job.created_at,
      startedAt:   job.started_at,
      completedAt: job.completed_at,
      error:       job.error_message || null,
      result:      job.result || null,
    },
    session: sessionData,
  });
});

// Cancel a pending job
router.delete("/jobs/:jobId", (req, res) => {
  const job = db.getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });
  if (job.status === "processing") return res.status(409).json({ error: "Cannot cancel a running job" });
  db.setJobStatus(req.params.jobId, "cancelled");
  res.json({ success: true });
});

// ─── RERENDER ONE SCENE ───────────────────────────────────────────────────────

router.post("/scene/:sessionId/:sceneIndex/rerender", async (req, res) => {
  const { sessionId, sceneIndex } = req.params;
  const { effect, transition, colorGrade, overlays, composition } = req.body;
  const t0 = Date.now();

  console.log(`   🎯 Rerender request scene ${sceneIndex}: effect=${effect} transition=${transition} colorGrade=${colorGrade} overlays=${JSON.stringify(overlays)}`);

  try {
    const updated = await rerenderScene(sessionId, parseInt(sceneIndex), { effect, transition, colorGrade, overlays, composition });
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`   ✅ Re-rendered scene ${sceneIndex} in ${elapsed}s → effect=${updated.effect} grade=${updated.colorGrade} overlays=${JSON.stringify(updated.overlays)}`);
    db.recordSceneEdit(sessionId, parseInt(sceneIndex), { effect, transition, colorGrade, overlays, composition });
    res.json({ success: true, scene: updated, rerenderTime: `${elapsed}s` });
  } catch (err) {
    console.error("❌ Rerender failed:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── PREVIEW TRANSITION ───────────────────────────────────────────────────────

router.post("/scene/:sessionId/:sceneIndex/preview-transition", async (req, res) => {
  try {
    const result = await previewTransition(req.params.sessionId, parseInt(req.params.sceneIndex));
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── EXPORT SESSION ───────────────────────────────────────────────────────────

router.post("/export/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  const { total_duration, async_mode = false } = req.body;
  const t0 = Date.now();

  try {
    console.log(`\n${"═".repeat(60)}`);
    console.log(`📦 EXPORTING SESSION ${sessionId}`);
    console.log(`${"═".repeat(60)}`);

    if (async_mode) {
      const jobId = enqueueJob({
        type: "export",
        sessionId,
        params: { sessionId, totalDuration: total_duration || 30 },
        priority: 3,
      });
      return res.json({ success: true, async: true, jobId, progressUrl: `/api/amv/jobs/${jobId}/progress`, statusUrl: `/api/amv/jobs/${jobId}` });
    }

    const result  = await exportSession(sessionId, total_duration || 30);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`✅ Export done in ${elapsed}s`);
    db.updateSessionExport(sessionId, result.videoUrl);

    res.json({
      success: true,
      video:   { url: result.videoUrl, filename: result.filename, duration: result.duration },
      exportTime: `${elapsed}s`,
    });
  } catch (err) {
    console.error("❌ Export failed:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── COMPOSITION MARKETPLACE ─────────────────────────────────────────────────

// List compositions (from DB — includes built-in + user-submitted)
router.get("/compositions", (req, res) => {
  const { category, all } = req.query;
  const compositions = db.getCompositions({ category, activeOnly: all !== "true" });
  res.json({ success: true, count: compositions.length, compositions });
});

// Submit a new composition
router.post("/compositions", (req, res) => {
  const { name, slug, category, description, ffmpegTemplate, thumbnailUrl, author, notes } = req.body;
  if (!name || !slug || !category || !ffmpegTemplate) {
    return res.status(400).json({ error: "Missing required fields: name, slug, category, ffmpegTemplate" });
  }
  if (!/^[a-z0-9_]+$/.test(slug)) {
    return res.status(400).json({ error: "slug must be lowercase letters, numbers, underscores only" });
  }
  const id = uuidv4();
  const saved = db.saveComposition({ id, name, slug, category, description, ffmpegTemplate, thumbnailUrl, isBuiltin: false, author: author || "user", notes });
  if (!saved) return res.status(500).json({ error: "Failed to save composition" });
  res.json({ success: true, id, slug, message: "Composition submitted. It will be reviewed before appearing publicly." });
});

// Vote for a composition
router.post("/compositions/:id/vote", (req, res) => {
  const voterIp = req.ip || req.connection.remoteAddress || "unknown";
  const result = db.voteComposition(req.params.id, voterIp);
  res.json({ success: result.success, ...result });
});

// Admin: toggle active state
router.patch("/compositions/:slug/toggle", (req, res) => {
  const { active } = req.body;
  db.toggleComposition(req.params.slug, active !== false);
  res.json({ success: true });
});

// ─── RENDER CACHE ─────────────────────────────────────────────────────────────

router.get("/cache/stats", (req, res) => {
  res.json({ success: true, cache: db.getCacheStats() });
});

router.post("/cache/prune", (req, res) => {
  const { days = 7 } = req.body;
  const deleted = db.pruneCacheOlderThan(parseInt(days));
  res.json({ success: true, deleted, message: `Deleted ${deleted} cache entries older than ${days} days` });
});

// ─── SESSION INFO / CLEANUP ───────────────────────────────────────────────────

router.get("/session/:sessionId", (req, res) => {
  try {
    const sessionsDir = path.join(__dirname, "..", "temp", "sessions");
    const metaPath    = path.join(sessionsDir, req.params.sessionId, "meta.json");
    if (!fs.existsSync(metaPath)) return res.status(404).json({ error: "Session not found" });
    const m = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
    // Derive audio URL from audioPath
    let audioUrl = null;
    if (m.audioPath) {
      const audioFilename = path.basename(m.audioPath);
      audioUrl = `/uploads/${audioFilename}`;
    }
    res.json({ success: true, session: {
      sessionId:  m.sessionId,
      sceneCount: m.scenes.length,
      createdAt:  m.createdAt,
      audioUrl,
      scenes: m.scenes.map(s => ({
        index: s.index, duration: s.duration, emotion: s.emotion,
        effect: s.effect, transition: s.transition,
        colorGrade: s.colorGrade || "none", overlays: s.overlays || [],
        composition: s.composition || null,
        previewUrl: s.previewUrl, thumbUrl: s.thumbUrl,
        start: s.start, llmReasoning: s.llmReasoning || null,
        editSource: s.editSource || "patterns",
        dropStrength: s.dropStrength || 0,
        suggestedEffect: s.suggestedEffect || null,
        suggestedTransition: s.suggestedTransition || null,
        suggestedColorGrade: s.suggestedColorGrade || null,
      })),
    }});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/sessions", (req, res) => {
  const sessions = listSessions();
  res.json({ success: true, count: sessions.length, sessions });
});

router.delete("/session/:sessionId", (req, res) => {
  try {
    cleanSession(req.params.sessionId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── LEGACY ONE-SHOT GENERATE ─────────────────────────────────────────────────

router.post("/generate", async (req, res) => {
  const t0 = Date.now();
  const { audio_path, media_paths = [], manual_drops = null, sensitivity = 0.5, aspect_ratio = "9:16", max_duration = 60, beat_map = {} } = req.body;
  if (!audio_path) return res.status(400).json({ error: "Missing audio_path" });
  if (!media_paths.length) return res.status(400).json({ error: "No media_paths" });

  try {
    const result  = await generateAMV({ audioPath: audio_path, mediaPaths: media_paths, manualDrops: manual_drops, sensitivity, aspectRatio: aspect_ratio, maxDuration: max_duration, beatMap: beat_map });
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    res.json({
      success: true,
      video: { id: result.videoId, url: result.videoUrl, filename: result.filename, duration: result.duration },
      stats: { sceneCount: result.sceneCount, bpm: result.bpm, dropCount: result.dropCount, emotions: result.emotions, generationTime: `${elapsed}s` },
    });
  } catch (err) {
    res.status(500).json({ error: err.message, generationTime: `${((Date.now()-t0)/1000).toFixed(1)}s` });
  }
});

// ─── PRESET IMPORT / EXPORT ─────────────────────────────────────────────────

// Export a session's editing decisions as a reusable preset JSON
router.get("/preset/export/:sessionId", (req, res) => {
  try {
    const sessionsDir = path.join(__dirname, "..", "temp", "sessions");
    const metaPath    = path.join(sessionsDir, req.params.sessionId, "meta.json");
    if (!fs.existsSync(metaPath)) return res.status(404).json({ error: "Session not found" });
    const m = JSON.parse(fs.readFileSync(metaPath, "utf-8"));

    const preset = {
      version: 1,
      name: req.query.name || `Preset from ${req.params.sessionId}`,
      createdAt: new Date().toISOString(),
      sceneCount: m.scenes.length,
      scenes: m.scenes.map((s, i) => ({
        index: i,
        effect: s.effect || "ken_burns",
        transition: s.transition || "dissolve",
        colorGrade: s.colorGrade || "none",
        overlays: s.overlays || [],
        composition: s.composition || null,
        emotion: s.emotion || "neutral",
      })),
    };

    res.json({ success: true, preset });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Import a preset JSON and apply it to an existing session
router.post("/preset/import/:sessionId", async (req, res) => {
  try {
    const { preset } = req.body;
    if (!preset || !preset.scenes || !Array.isArray(preset.scenes)) {
      return res.status(400).json({ error: "Invalid preset format — must contain a scenes array" });
    }

    const sessionsDir = path.join(__dirname, "..", "temp", "sessions");
    const metaPath    = path.join(sessionsDir, req.params.sessionId, "meta.json");
    if (!fs.existsSync(metaPath)) return res.status(404).json({ error: "Session not found" });
    const m = JSON.parse(fs.readFileSync(metaPath, "utf-8"));

    const applied = [];
    for (let i = 0; i < m.scenes.length && i < preset.scenes.length; i++) {
      const p = preset.scenes[i];
      const updates = {};
      if (p.effect)      updates.effect      = p.effect;
      if (p.transition)  updates.transition  = p.transition;
      if (p.colorGrade)  updates.colorGrade  = p.colorGrade;
      if (p.overlays)    updates.overlays    = p.overlays;
      if (p.composition !== undefined) updates.composition = p.composition;

      if (Object.keys(updates).length > 0) {
        try {
          await rerenderScene(req.params.sessionId, i, updates);
          applied.push(i);
        } catch (sceneErr) {
          console.warn(`   ⚠️  Preset import: scene ${i} rerender failed: ${sceneErr.message}`);
        }
      }
    }

    res.json({
      success: true,
      appliedScenes: applied.length,
      totalPresetScenes: preset.scenes.length,
      totalSessionScenes: m.scenes.length,
      message: `Applied preset to ${applied.length} scenes`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
