/**
 * Video Routes — Main Pipeline Orchestrator
 *
 * POST /api/video/plan      — Prompt → LLM Scene Plan (for user approval) NEW
 * POST /api/video/generate  — Prompt (or approved_plan) → Full Video
 * GET  /api/video/list      — List all generated videos
 */

const express = require("express");
const router = express.Router();
const axios = require("axios");
const path = require("path");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");

const { generateScript } = require("../services/scriptGenerator");
const { fetchSceneImages } = require("../services/mediaService");
const { generateVideo, findMusicTrack } = require("../services/videoGenerator");
const { generateSubtitleFile } = require("../services/subtitleGenerator");

const TTS_URL = process.env.TTS_SERVICE_URL || "http://localhost:5050";
const UPLOADS_DIR = path.join(__dirname, "..", "uploads");

// ─── POST /api/video/plan ────────────────────────────────────────────────────
// Returns scene plan for user to review/edit before rendering

router.post("/plan", async (req, res) => {
  const { prompt, duration = 15 } = req.body;
  if (!prompt) return res.status(400).json({ error: "Missing 'prompt' field" });

  try {
    console.log(`\n📋 SCENE PLAN: "${prompt}"`);
    const script = await generateScript(prompt, Math.min(60, Math.max(5, duration)));
    res.json({
      success: true,
      plan: {
        title:    script.title,
        mood:     script.mood,
        duration: script.totalDuration,
        scenes:   script.scenes.map((s, i) => ({
          id:           i,
          narration:    s.narration,
          subtitle:     s.subtitle,
          visual_query: s.visual_query,
          duration:     s.duration,
          effect:       s.effect,
          transition:   s.transition,
        })),
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/video/generate ───────────────────────────────────────────────

router.post("/generate", async (req, res) => {
  const startTime = Date.now();

  try {
    const {
      prompt,
      duration = 15,
      includeAudio = true,
      voice = "male_en",
      style = "fast_cuts",
      subtitles = true,
      template = null,
      customAudioPath = null,
      customImages = [],
      approved_plan = null,   // NEW: pre-approved scene plan from /plan endpoint
    } = req.body;

    if (!prompt && !approved_plan) {
      return res.status(400).json({ error: "Missing 'prompt' or 'approved_plan' field" });
    }

    const clampedDuration = Math.min(60, Math.max(5, duration));
    console.log(`\n${"═".repeat(60)}`);
    console.log(`🎬 VIDEO GENERATION: "${prompt || approved_plan?.title}" (${clampedDuration}s)`);
    console.log(`${"═".repeat(60)}`);

    // ── Step 1: Generate or use approved Script ────────────────────────────
    console.log("\n📝 Step 1: Generating script...");
    let script;
    if (approved_plan) {
      // User edited and approved the plan — use it directly
      script = {
        title:         approved_plan.title || "Anime Edit",
        mood:          approved_plan.mood  || "epic",
        prompt:        prompt || approved_plan.title,
        totalDuration: approved_plan.scenes.reduce((s, sc) => s + (sc.duration || 4), 0),
        scenes:        approved_plan.scenes.map((s, i) => ({
          id:           i + 1,
          narration:    s.narration    || "",
          subtitle:     s.subtitle     || "",
          visual_query: s.visual_query || "warrior dark_background wallpaper",
          duration:     s.duration     || 4,
          effect:       s.effect       || "ken_burns",
          transition:   s.transition   || "fade",
          searchQuery:  s.visual_query || "warrior dark_background wallpaper",
        })),
        narration: approved_plan.scenes.map(s => s.narration || "").join(" ... "),
      };
      console.log(`   ✅ Using approved plan: ${script.scenes.length} scenes`);
    } else {
      script = await generateScript(prompt, clampedDuration, template);
    }
    console.log(`   Title:  "${script.title}"`);
    console.log(`   Mood:   ${script.mood}`);
    console.log(`   Scenes: ${script.scenes.length}`);
    console.log(`   Duration: ${script.totalDuration}s`);

    // ── Step 2: Fetch Media (per scene) ───────────────────────────────────
    console.log("\n🖼️  Step 2: Fetching scene images...");
    let scenesWithImages;

    if (customImages.length > 0) {
      // Use custom images — distribute across scenes
      scenesWithImages = script.scenes.map((scene, i) => ({
        ...scene,
        imagePath: customImages[i % customImages.length],
        imageSource: "custom",
      }));
    } else {
      scenesWithImages = await fetchSceneImages(script.scenes);
    }

    const validScenes = scenesWithImages.filter(
      (s) => s.imagePath && fs.existsSync(s.imagePath)
    );

    if (validScenes.length === 0) {
      throw new Error("Failed to fetch any images for scenes");
    }

    console.log(`   ✅ ${validScenes.length}/${script.scenes.length} scenes have images`);

    // ── Step 3: Generate Audio (TTS) ──────────────────────────────────────
    let audioPath = customAudioPath || null;
    console.log("\n🎤 Step 3: Generating narration audio...");

    if (includeAudio && !audioPath) {
      audioPath = await generateNarrationAudio(script, voice);
    }

    if (audioPath) {
      console.log(`   ✅ Audio ready: ${path.basename(audioPath)}`);
    } else {
      console.log(`   ⚠️  No audio — continuing without narration`);
    }

    // ── Step 4: Find Background Music ─────────────────────────────────────
    console.log("\n🎵 Step 4: Selecting background music...");
    const musicPath = findMusicTrack(script.mood);
    if (musicPath) {
      console.log(`   ✅ Music: ${path.basename(musicPath)} (mood: ${script.mood})`);
    } else {
      console.log(`   ℹ️  No music tracks found in assets/music/`);
      console.log(`      Add .mp3 files named by mood (e.g., epic.mp3, dark.mp3)`);
    }

    // ── Step 5: Generate Subtitles ────────────────────────────────────────
    let subtitlePath = null;
    if (subtitles) {
      console.log("\n📝 Step 5: Generating subtitles...");
      subtitlePath = generateSubtitleFile(validScenes, script.mood);
    }

    // ── Step 6: Compose Video ─────────────────────────────────────────────
    console.log("\n🎥 Step 6: Composing video with FFmpeg...");

    const result = await generateVideo({
      scenes: validScenes,
      audioPath,
      musicPath,
      subtitlePath,
      duration: script.totalDuration || clampedDuration,
      aspectRatio: "9:16",
    });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n${"═".repeat(60)}`);
    console.log(`✅ DONE in ${elapsed}s → ${result.videoUrl}`);
    console.log(`${"═".repeat(60)}\n`);

    res.json({
      success: true,
      video: {
        id: result.videoId,
        url: result.videoUrl,
        filename: result.filename,
        duration: result.duration,
      },
      script: {
        title: script.title,
        mood: script.mood,
        scenes: script.scenes.length,
        narration: script.narration?.slice(0, 200),
        _fallback: !!script._fallback,
      },
      stats: {
        mediaFetched: validScenes.length,
        hasAudio: result.hasAudio,
        hasMusic: result.hasMusic,
        hasSubtitles: !!subtitlePath,
        generationTime: `${elapsed}s`,
      },
    });
  } catch (err) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.error(`\n❌ Pipeline failed after ${elapsed}s:`, err.message);
    res.status(500).json({
      error: `Video generation failed: ${err.message}`,
      generationTime: `${elapsed}s`,
    });
  }
});

// ─── NARRATION AUDIO HELPER ─────────────────────────────────────────────────

async function generateNarrationAudio(script, voice) {
  try {
    // Check if TTS service is alive
    await axios.get(`${TTS_URL}/health`, { timeout: 5000 });

    const ttsResponse = await axios.post(
      `${TTS_URL}/tts/save`,
      {
        text: script.narration,
        voice,
        rate: "+10%",
      },
      {
        timeout: 90000,
        headers: { "Content-Type": "application/json" },
      }
    );

    if (!ttsResponse.data.success) {
      console.warn(`   ⚠️  TTS returned success=false: ${ttsResponse.data.error}`);
      return null;
    }

    // Download the audio file locally (fixes cross-service path issue)
    const downloadUrl = `${TTS_URL}${ttsResponse.data.download_url}`;
    const localFilename = `narration_${uuidv4().slice(0, 8)}.mp3`;
    const localPath = path.join(UPLOADS_DIR, localFilename);

    const audioResponse = await axios.get(downloadUrl, {
      responseType: "arraybuffer",
      timeout: 30000,
    });

    fs.writeFileSync(localPath, audioResponse.data);

    // Verify the file
    const fileSize = fs.statSync(localPath).size;
    if (fileSize < 100) {
      fs.unlinkSync(localPath);
      console.warn("   ⚠️  Downloaded audio file is too small");
      return null;
    }

    return localPath;
  } catch (err) {
    const detail = err.response
      ? `HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}`
      : err.message;
    console.warn(`   ⚠️  TTS failed (${detail}), continuing without audio`);
    return null;
  }
}

// ─── GET /api/video/list ────────────────────────────────────────────────────

router.get("/list", (req, res) => {
  const outputDir = path.join(__dirname, "..", "output");
  try {
    const files = fs.readdirSync(outputDir).filter((f) => f.endsWith(".mp4"));
    const videos = files
      .map((f) => ({
        filename: f,
        url: `/output/${f}`,
        size: fs.statSync(path.join(outputDir, f)).size,
        createdAt: fs.statSync(path.join(outputDir, f)).mtime,
      }))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json({ videos, count: videos.length });
  } catch {
    res.json({ videos: [], count: 0 });
  }
});

// ─── DELETE /api/video/:filename ────────────────────────────────────────────

router.delete("/:filename", (req, res) => {
  const safe = path.basename(req.params.filename);
  const filepath = path.join(__dirname, "..", "output", safe);
  if (fs.existsSync(filepath)) {
    fs.unlinkSync(filepath);
    res.json({ success: true, deleted: safe });
  } else {
    res.status(404).json({ error: "Video not found" });
  }
});

module.exports = router;
