/**
 * Scene Renderer Service v4.0
 *
 * Changes over v3:
 *   - Multi-image scenes: scene.mediaPaths[] (array) supported in addition to
 *     scene.mediaPath (string). renderOneScene resolves both.
 *   - Face-aware crop: if scene.visualFeatures has face_bbox, uses buildFaceCrop()
 *     to derive a precise FFmpeg crop centred on the detected face.
 *   - Magnetic mask: if scene.composition === "magnetic_mask", calls Python
 *     /remove-bg, then composites the subject PNG over a blurred background.
 *   - Cache key includes all mediaPaths so multi-image scenes are keyed correctly.
 *   - All v3 behaviour (22 compositions, cache, export, SSE) preserved.
 */

"use strict";

const { exec }   = require("child_process");
const crypto     = require("crypto");
const path       = require("path");
const fs         = require("fs");
const os         = require("os");
const axios      = require("axios");
const { v4: uuidv4 } = require("uuid");

const {
  MOTION_EFFECTS, TRANSITIONS, COLOR_GRADES, OVERLAYS,
  buildColorGrade, buildOverlay, buildSceneFilterChain,
  mapTransition, getTransitionDuration,
  resolveLegacyEffect, resolveLegacyTransition,
} = require("./effectsLibrary");

const {
  COMPOSITIONS,
  MULTI_IMAGE_COMPOSITIONS,
  buildCompositionCmd,
  buildFaceCrop,
} = require("./compositionEngine");

const db = require("./database");

const SESSIONS_DIR = path.join(__dirname, "..", "temp", "sessions");
const CACHE_DIR    = path.join(__dirname, "..", "temp", "render_cache");
const OUTPUT_DIR   = path.join(__dirname, "..", "output");
const BEAT_SERVICE = process.env.BEAT_SERVICE_URL || "http://localhost:5051";

for (const d of [SESSIONS_DIR, CACHE_DIR, OUTPUT_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function run(cmd, timeout = 120000) {
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 100 * 1024 * 1024, timeout }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`FFmpeg error: ${stderr?.slice(-800) || err.message}`));
      resolve({ stdout, stderr });
    });
  });
}

function sessionDir(sessionId) {
  const dir = path.join(SESSIONS_DIR, sessionId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function loadMeta(sessionId) {
  const metaPath = path.join(sessionDir(sessionId), "meta.json");
  if (!fs.existsSync(metaPath)) throw new Error(`Session not found: ${sessionId}`);
  return JSON.parse(fs.readFileSync(metaPath, "utf-8"));
}

function saveMeta(sessionId, meta) {
  fs.writeFileSync(path.join(sessionDir(sessionId), "meta.json"), JSON.stringify(meta, null, 2));
}

function isVideo(p) { return /\.(mp4|mov|avi|mkv|webm|m4v)$/i.test(p || ""); }

/**
 * Resolve a scene's image paths as an array.
 * Supports both scene.mediaPaths[] (new) and scene.mediaPath (legacy).
 * Always returns at least one entry.
 */
function resolveMediaPaths(scene) {
  if (Array.isArray(scene.mediaPaths) && scene.mediaPaths.length > 0) {
    return scene.mediaPaths.filter(p => typeof p === "string" && p.length > 0);
  }
  if (typeof scene.mediaPath === "string" && scene.mediaPath.length > 0) {
    return [scene.mediaPath];
  }
  throw new Error(`Scene ${scene.index ?? "?"} has no valid mediaPath(s)`);
}

/**
 * Get a scene's primary (first) media path for cache key and legacy operations.
 */
function primaryMediaPath(scene) {
  return resolveMediaPaths(scene)[0];
}

// ─── SCENE CACHE KEY ──────────────────────────────────────────────────────────

// Bump this version whenever the render pipeline changes in a way that makes
// existing cached clips incompatible.
// v1 = original (no tail buffer in clips — tpad now lives in exportSession instead)
const CACHE_VERSION = "v1";

function buildCacheKey({ mediaPaths, effect, composition, colorGrade, overlays, duration, width, height, fps, beatsInScene = [] }) {
  // Hash first 64KB of each input file
  const fileHashes = (mediaPaths || []).map(mp => {
    let hash = "nohash";
    try {
      const fd  = fs.openSync(mp, "r");
      const buf = Buffer.alloc(65536);
      const n   = fs.readSync(fd, buf, 0, 65536, 0);
      fs.closeSync(fd);
      hash = crypto.createHash("md5").update(buf.slice(0, n)).digest("hex").slice(0, 10);
    } catch {}
    return hash;
  }).join("_");

  const beatsKey = beatsInScene.length > 0
    ? beatsInScene.map(b => Math.round(b * 20) / 20).join(",")
    : "nobeats";

  const keyStr = [
    CACHE_VERSION,           // invalidates all pre-tail-buffer cached clips
    fileHashes,
    effect || "none",
    composition || "none",
    colorGrade || "none",
    JSON.stringify((overlays || []).sort()),
    Math.round(duration * 10) / 10,
    width,
    height,
    fps,
    beatsKey,
  ].join("|");

  return crypto.createHash("sha1").update(keyStr).digest("hex").slice(0, 20);
}

// ─── MEDIA PREPROCESSING ──────────────────────────────────────────────────────

async function resizeMedia(input, width, height, targetDuration) {
  const isVid = isVideo(input);
  const out   = path.join(os.tmpdir(), `amvprep_${uuidv4().slice(0,8)}.${isVid ? "mp4" : "jpg"}`);
  if (isVid) {
    const cmd = `ffmpeg -y -i "${input}" -t ${targetDuration.toFixed(3)} ` +
      `-vf "scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=30" ` +
      `-an -c:v libx264 -preset ultrafast -crf 23 "${out}"`;
    await run(cmd, 60000);
  } else {
    const cmd = `ffmpeg -y -i "${input}" ` +
      `-vf "scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black" -q:v 2 "${out}"`;
    await run(cmd, 20000);
  }
  return out;
}

// ─── MAGNETIC MASK COMPOSITE ──────────────────────────────────────────────────

/**
 * Call the Python /remove-bg endpoint, then composite the subject (transparent
 * PNG) over a gaussian-blurred version of the background image using FFmpeg.
 *
 * Falls back to the original image if anything fails.
 *
 * @param {string}  fgPath   — foreground image path (subject)
 * @param {string}  bgPath   — background image path (blurred behind subject)
 * @param {string}  outPath  — .mp4 output path
 * @param {object}  opts     — {duration, fps, w, h, colorGrade, overlays, post}
 * @returns {boolean}  true if magnetic mask succeeded, false if fell back
 */
async function renderMagneticMask(fgPath, bgPath, outPath, opts) {
  const { duration, fps, w, h, post } = opts;
  const dur    = Math.max(0.1, duration).toFixed(3);
  const durPad = (parseFloat(dur) + 0.1).toFixed(3);
  const totalFrames = Math.max(4, Math.round(duration * fps));

  let subjectPng = null;
  const tmpPng   = path.join(os.tmpdir(), `subject_${uuidv4().slice(0,8)}.png`);

  try {
    // Ask Python service to remove background
    const resp = await axios.post(
      `${BEAT_SERVICE}/remove-bg`,
      { image_path: fgPath },
      { timeout: 60000, responseType: "arraybuffer" }
    );

    // If the service returned JSON with success:false, it's a fallback signal
    const contentType = resp.headers["content-type"] || "";
    if (contentType.includes("application/json")) {
      const json = JSON.parse(Buffer.from(resp.data).toString("utf-8"));
      if (!json.success) {
        console.log(`   ⚠️  magnetic_mask: /remove-bg returned fallback: ${json.error}`);
        return false;
      }
    }

    fs.writeFileSync(tmpPng, Buffer.from(resp.data));
    subjectPng = tmpPng;

    // Build FFmpeg composite:
    //   Input 0: background image (blurred, slow zoom)
    //   Input 1: subject PNG with alpha (centred, slight zoom)
    const fc = [
      // Background: scale to full frame, heavy gaussian blur, slow zoom
      `[0:v]scale=${w}:${h}:force_original_aspect_ratio=increase,` +
        `crop=${w}:${h}:(iw-${w})/2:(ih-${h})/2,` +
        `zoompan=z='1.04+0.02*on/${totalFrames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${w}x${h}:fps=${fps},` +
        `boxblur=28:8,setsar=1[bg]`,
      // Subject: scale with RGBA preserved, centred
      `[1:v]scale=${Math.floor(w * 0.88)}:${Math.floor(h * 0.88)}:` +
        `force_original_aspect_ratio=decrease,` +
        `pad=${Math.floor(w * 0.88)}:${Math.floor(h * 0.88)}:(ow-iw)/2:(oh-ih)/2:0x00000000,` +
        `zoompan=z='1.02+0.01*on/${totalFrames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${Math.floor(w * 0.88)}x${Math.floor(h * 0.88)}:fps=${fps}[fg]`,
      // Composite: overlay fg centred on bg
      `[bg][fg]overlay=x=(W-w)/2:y=(H-h)/2,fps=${fps}${post}[vout]`,
    ];

    const cmd = `ffmpeg -y ` +
      `-loop 1 -t ${durPad} -i "${bgPath}" ` +
      `-loop 1 -t ${durPad} -i "${subjectPng}" ` +
      `-filter_complex "${fc.join(";")}" ` +
      `-map "[vout]" ` +
      `-t ${dur} -an -c:v libx264 -preset fast -crf 20 -pix_fmt yuv420p "${outPath}"`;

    await run(cmd, 120000);
    console.log(`   ✨ magnetic_mask: composite rendered successfully`);
    return true;

  } catch (err) {
    console.warn(`   ⚠️  magnetic_mask fallback: ${err.message}`);
    return false;
  } finally {
    if (subjectPng && fs.existsSync(subjectPng)) {
      try { fs.unlinkSync(subjectPng); } catch {}
    }
  }
}

// ─── RENDER ONE SCENE ─────────────────────────────────────────────────────────

/**
 * Render one scene clip to outPath.
 *
 * Handles:
 *   1. magnetic_mask composition  → /remove-bg → FFmpeg composite
 *   2. Multi-image compositions   → compositionEngine with inputPaths[]
 *   3. Single-image compositions  → compositionEngine with inputPath
 *   4. Standard effect pipeline   → buildSceneFilterChain
 *   5. Video source pipeline      → direct video processing
 */
async function renderOneScene({ processedMediaPaths, rawMediaPaths, scene, width, height, fps, outPath, useCache = true }) {
  const {
    duration,
    effect       = "ken_burns",
    composition  = null,
    colorGrade   = "none",
    overlays     = [],
    beatsInScene = [],
    faceAware    = false,
    visualFeatures = null,
  } = scene;

  // processedMediaPaths = resized full-frame paths for single-image effects.
  // rawMediaPaths = original paths for multi-image compositions (they scale themselves).
  const allPaths    = Array.isArray(processedMediaPaths) ? processedMediaPaths : [processedMediaPaths];
  const rawPaths    = Array.isArray(rawMediaPaths) && rawMediaPaths.length > 0
    ? rawMediaPaths : allPaths;
  const primaryPath = allPaths[0];

  const resolvedEffect = resolveLegacyEffect(effect);

  // ── CHECK CACHE ────────────────────────────────────────────────────────────
  let cacheKey = null;
  if (useCache && !isVideo(primaryPath)) {
    cacheKey = buildCacheKey({
      mediaPaths:  allPaths,
      effect:      resolvedEffect,
      composition: composition || null,
      colorGrade,
      overlays,
      duration,
      width, height, fps,
      beatsInScene,
    });

    const cached = db.getCachedRender(cacheKey);
    if (cached && fs.existsSync(cached.clip_path)) {
      console.log(`   ♻️  Cache HIT: ${cacheKey.slice(0,10)}… → skipping FFmpeg`);
      fs.copyFileSync(cached.clip_path, outPath);
      return { fromCache: true, cacheKey };
    }
  }

  const dur    = Math.max(0.1, duration).toFixed(3);
  const post   = _buildPost(colorGrade, overlays, width, height);

  // ── MAGNETIC MASK (special composition) ───────────────────────────────────
  if (composition === "magnetic_mask" && !isVideo(primaryPath)) {
    // fgPath = first image (subject), bgPath = second image if available, else same
    const fgPath = primaryPath;
    const bgPath = allPaths.length > 1 ? allPaths[1] : primaryPath;

    const ok = await renderMagneticMask(fgPath, bgPath, outPath, {
      duration, fps, w: width, h: height, post,
    });

    if (!ok) {
      // Graceful fallback: render fgPath with standard ken_burns
      console.log(`   ↩  magnetic_mask fell back to standard effect for scene ${scene.index ?? "?"}`);
      const filterChain = buildSceneFilterChain({
        effect: "ken_burns", colorGrade, overlayList: overlays,
        duration, fps, w: width, h: height, beatOffsets: beatsInScene, faceAware,
      });
      await run(
        `ffmpeg -y -loop 1 -t ${(duration + 0.1).toFixed(3)} -i "${primaryPath}" ` +
        `-vf "${filterChain}" -t ${dur} -an ` +
        `-c:v libx264 -preset fast -crf 20 -pix_fmt yuv420p "${outPath}"`,
        60000
      );    }

    _saveCache(cacheKey, outPath, { primaryPath, resolvedEffect, composition, colorGrade, overlays, duration, width, height, fps });
    return { fromCache: false, cacheKey };
  }

  // ── COMPOSITION PATH (single or multi-image) ───────────────────────────────
  if (composition && COMPOSITIONS.has(composition) && !isVideo(primaryPath)) {
    // Determine face bbox for face-aware crop (if available and OpenCV was used)
    const faceBbox = (visualFeatures && visualFeatures.face_bbox) || null;

    // For multi-image compositions, collect per-image bboxes if we have them
    const faceBboxes = [faceBbox]; // Only primary has visual features currently

    // Multi-image compositions receive original (unprocessed) paths so they can
    // do their own scaling. Single-image compositions use processedMediaPaths[0].
    const compInputPaths = MULTI_IMAGE_COMPOSITIONS.has(composition) ? rawPaths : allPaths;
    const cmd = buildCompositionCmd({
      composition,
      inputPath:   compInputPaths[0],   // legacy single-image fallback
      inputPaths:  compInputPaths,      // multi-image preferred
      outPath,
      duration,
      fps,
      w: width,
      h: height,
      colorGrade,
      overlays,
      beatOffsets: beatsInScene,
      faceBboxes:  faceBboxes.filter(Boolean),
    });

    if (cmd) {
      console.log(
        `   🎬 Composition: ${composition} ` +
        `(${allPaths.length} img) | grade=${colorGrade} | dur=${duration.toFixed(1)}s`
      );
      await run(cmd, 120000);
      db.incrementCompositionUse(composition);
      _saveCache(cacheKey, outPath, { primaryPath, resolvedEffect, composition, colorGrade, overlays, duration, width, height, fps });
      return { fromCache: false, cacheKey };
    }
    // buildCompositionCmd returned null → fall through to standard path
    console.log(`   ⚠️  Composition "${composition}" returned null, using standard effect`);
  }

  // ── STANDARD PATH ─────────────────────────────────────────────────────────
  if (isVideo(primaryPath)) {
    const filters = [`setsar=1`, `fps=${fps}`];
    const gradeF  = buildColorGrade(colorGrade);
    if (gradeF) filters.push(gradeF);
    for (const ov of overlays) {
      const ovF = buildOverlay(ov, width, height);
      if (ovF) filters.push(ovF);
    }
    if (!overlays.some(o => o.startsWith("vignette"))) filters.push("vignette=PI/5");

    await run(
      `ffmpeg -y -i "${primaryPath}" ` +
      `-vf "${filters.join(",")}" ` +
      `-t ${dur} -an ` +
      `-c:v libx264 -preset fast -crf 20 -pix_fmt yuv420p "${outPath}"`,
      60000
    );
  } else {
    let facePrefix = "";
    const faceBbox = visualFeatures && visualFeatures.face_bbox;
    if (faceAware && faceBbox) {
      try {
        const probeCmd = `ffprobe -v quiet -print_format json -show_streams "${primaryPath}"`;
        const { stdout: probeOut } = await run(probeCmd, 10000);
        const probe    = JSON.parse(probeOut);
        const vidStream = probe.streams.find(s => s.codec_type === "video");
        if (vidStream) {
          const srcW = vidStream.width;
          const srcH = vidStream.height;
          facePrefix = buildFaceCrop(faceBbox, srcW, srcH, width, height) + ",";
        }
      } catch {}
    }

    const filterChain = facePrefix + buildSceneFilterChain({
      effect:      resolvedEffect,
      colorGrade,
      overlayList: overlays,
      duration,
      fps,
      w: width,
      h: height,
      beatOffsets: beatsInScene,
      faceAware:   !!faceAware && !facePrefix,
    });

    await run(
      `ffmpeg -y -loop 1 -t ${(duration + 0.1).toFixed(3)} -i "${primaryPath}" ` +
      `-vf "${filterChain}" ` +
      `-t ${dur} -an ` +
      `-c:v libx264 -preset fast -crf 20 -pix_fmt yuv420p "${outPath}"`,
      60000
    );
  }

  _saveCache(cacheKey, outPath, { primaryPath, resolvedEffect, composition: null, colorGrade, overlays, duration, width, height, fps });
  return { fromCache: false, cacheKey };
}

function _buildPost(colorGrade, overlays, w, h) {
  const { buildColorGrade, buildOverlay } = require("./effectsLibrary");
  const parts = [];
  const gf = buildColorGrade(colorGrade);
  if (gf) parts.push(gf);
  for (const ov of (overlays || [])) {
    const of_ = buildOverlay(ov, w, h);
    if (of_) parts.push(of_);
  }
  if (!(overlays || []).some(o => o.startsWith("vignette"))) parts.push("vignette=PI/5");
  return parts.length > 0 ? "," + parts.join(",") : "";
}

function _saveCache(cacheKey, outPath, meta) {
  if (!cacheKey) return;
  try {
    const cacheClipPath = path.join(CACHE_DIR, `${cacheKey}.mp4`);
    if (fs.existsSync(outPath)) {
      const size = fs.statSync(outPath).size;
      fs.copyFileSync(outPath, cacheClipPath);
      db.saveCachedRender({
        cacheKey, clipPath: cacheClipPath,
        imagePath: meta.primaryPath,
        effect: meta.resolvedEffect,
        composition: meta.composition,
        colorGrade: meta.colorGrade,
        overlays: meta.overlays,
        duration: meta.duration,
        width: meta.width, height: meta.height, fps: meta.fps,
        fileSizeBytes: size,
      });
    }
  } catch {} // cache save failure is non-fatal
}

async function makeThumbnail(sceneMp4, thumbPath) {
  try {
    await run(`ffmpeg -y -i "${sceneMp4}" -vframes 1 -q:v 3 "${thumbPath}"`, 10000);
  } catch {} // non-critical
}

// ─── PREPARE SESSION ──────────────────────────────────────────────────────────

async function prepareSession({ sessionId, scenes, audioPath, width = 1080, height = 1920, fps = 30, onSceneDone = null }) {
  const dir      = sessionDir(sessionId);
  const resCache = new Map(); // single-image processed path cache
  const processedScenes = [];
  let cacheHits  = 0;

  for (let i = 0; i < scenes.length; i++) {
    const scene     = scenes[i];
    const outPath   = path.join(dir, `scene_${i}.mp4`);
    const thumbPath = path.join(dir, `thumb_${i}.jpg`);

    // Resolve all media paths for this scene
    let rawPaths;
    try {
      rawPaths = resolveMediaPaths(scene);
    } catch (err) {
      console.error(`   ❌ Scene ${i}: ${err.message} — skipping`);
      continue;
    }

    // Preprocess each unique raw path (resize/transcode)
    const procPaths = [];
    for (const rawPath of rawPaths) {
      if (resCache.has(rawPath)) {
        procPaths.push(resCache.get(rawPath));
      } else {
        try {
          const proc = await resizeMedia(rawPath, width, height, scene.duration);
          procPaths.push(proc);
          if (!isVideo(rawPath)) resCache.set(rawPath, proc);
        } catch (err) {
          console.warn(`   ⚠️  Could not preprocess ${path.basename(rawPath)}: ${err.message}`);
          // Use original as fallback — FFmpeg may handle it directly
          procPaths.push(rawPath);
        }
      }
    }

    // Render the scene.
    // rawPaths = originals for multi-image compositions (they scale themselves).
    // procPaths = resized paths for single-image effects and cache key.
    const { fromCache } = await renderOneScene({
      processedMediaPaths: procPaths,
      rawMediaPaths:       rawPaths,
      scene,
      width, height, fps,
      outPath,
      useCache: true,
    });
    if (fromCache) cacheHits++;

    // Mux audio segment (only for scenes >= 0.5s to avoid corruption)
    if (audioPath && fs.existsSync(audioPath) && fs.existsSync(outPath) && scene.duration >= 0.5) {
      const withAudioPath = path.join(dir, `scene_${i}_audio.mp4`);
      try {
        await run(
          `ffmpeg -y -i "${outPath}" ` +
          `-ss ${(scene.start || 0).toFixed(3)} -t ${scene.duration.toFixed(3)} -i "${audioPath}" ` +
          `-c:v libx264 -preset ultrafast -crf 18 -pix_fmt yuv420p ` +
          `-c:a aac -b:a 192k -map 0:v:0 -map 1:a:0 -shortest -fflags +genpts "${withAudioPath}"`,
          30000
        );
        if (fs.existsSync(withAudioPath) && fs.statSync(withAudioPath).size > 1000) {
          fs.renameSync(withAudioPath, outPath);
        } else {
          try { fs.unlinkSync(withAudioPath); } catch {}
        }
      } catch {
        try { fs.unlinkSync(withAudioPath); } catch {}
      }
    }

    await makeThumbnail(outPath, thumbPath);

    const compLabel  = scene.composition ? ` [${scene.composition}]` : "";
    const ovsLabel   = (scene.overlays || []).join(",") || "—";
    const imgCount   = rawPaths.length;
    console.log(
      `   ✅ Scene ${i+1}/${scenes.length}${compLabel} ` +
      `(${scene.effect || "?"} | ${scene.colorGrade || "none"} | ${ovsLabel} | ${imgCount}img)` +
      `${fromCache ? " ♻️" : ""}`
    );

    const processedScene = {
      index:           i,
      mediaPath:       rawPaths[0],         // legacy field — primary path
      mediaPaths:      rawPaths,            // v3: all paths
      mediaProcPaths:  procPaths,           // preprocessed paths
      mediaProcPath:   procPaths[0],        // legacy
      start:           scene.start       || 0,
      duration:        scene.duration,
      effect:          scene.effect      || "ken_burns",
      transition:      scene.transition  || "dissolve",
      colorGrade:      scene.colorGrade  || "none",
      overlays:        scene.overlays    || [],
      composition:     scene.composition || null,
      emotion:         scene.emotion     || "neutral",
      beatsInScene:    scene.beatsInScene  || [],
      beatStrengths:   scene.beatStrengths || [],
      dropStrength:    scene.dropStrength  || 0.5,
      llmReasoning:    scene.llmReasoning  || null,
      editSource:      scene.editSource    || "patterns",
      faceAware:       scene.faceAware     || false,
      visualFeatures:  scene.visualFeatures || null,
      clipPath:        outPath,
      thumbUrl:        `/sessions/${sessionId}/thumb_${i}.jpg`,
      previewUrl:      `/sessions/${sessionId}/scene_${i}.mp4`,
    };

    processedScenes.push(processedScene);

    if (typeof onSceneDone === "function") {
      onSceneDone(i, {
        index:       i,
        previewUrl:  processedScene.previewUrl,
        thumbUrl:    processedScene.thumbUrl,
        effect:      processedScene.effect,
        composition: processedScene.composition,
      });
    }
  }

  // Cleanup temp preprocessed files (but not originals)
  for (const [orig, proc] of resCache.entries()) {
    if (proc !== orig && fs.existsSync(proc)) {
      try { fs.unlinkSync(proc); } catch {}
    }
  }

  if (cacheHits > 0) {
    console.log(`   ♻️  Cache: ${cacheHits}/${scenes.length} scenes from cache`);
  }

  const meta = { sessionId, audioPath, width, height, fps, scenes: processedScenes, createdAt: Date.now() };
  saveMeta(sessionId, meta);
  return meta;
}

// ─── RERENDER ONE SCENE ───────────────────────────────────────────────────────

async function rerenderScene(sessionId, sceneIndex, updates) {
  const meta  = loadMeta(sessionId);
  const scene = meta.scenes[sceneIndex];
  if (!scene) throw new Error(`Scene ${sceneIndex} not found in session ${sessionId}`);

  const dir     = sessionDir(sessionId);
  const outPath = path.join(dir, `scene_${sceneIndex}.mp4`);

  // Apply updates with validation
  if (updates.effect) {
    const e = MOTION_EFFECTS.has(updates.effect) ? updates.effect : resolveLegacyEffect(updates.effect);
    if (MOTION_EFFECTS.has(e)) scene.effect = e;
  }
  if (updates.transition) {
    const t = TRANSITIONS.has(updates.transition) ? updates.transition : resolveLegacyTransition(updates.transition);
    if (TRANSITIONS.has(t)) scene.transition = t;
  }
  if (updates.colorGrade && COLOR_GRADES.has(updates.colorGrade)) scene.colorGrade = updates.colorGrade;
  if (updates.overlays && Array.isArray(updates.overlays)) {
    scene.overlays = updates.overlays.filter(o => OVERLAYS.has(o));
  }
  if (updates.composition !== undefined) {
    if (updates.composition === "magnetic_mask") {
      scene.composition = "magnetic_mask"; // not in COMPOSITIONS set — handled specially
    } else {
      scene.composition = (updates.composition && COMPOSITIONS.has(updates.composition))
        ? updates.composition : null;
    }
  }
  // Allow updating mediaPaths on rerender
  if (Array.isArray(updates.mediaPaths) && updates.mediaPaths.length > 0) {
    scene.mediaPaths = updates.mediaPaths;
    scene.mediaPath  = updates.mediaPaths[0];
  }

  // Resolve + preprocess media paths
  let rawPaths;
  try {
    rawPaths = resolveMediaPaths(scene);
  } catch (err) {
    throw new Error(`Rerender scene ${sceneIndex}: ${err.message}`);
  }

  const procPaths = [];
  for (const rawPath of rawPaths) {
    let proc = scene.mediaProcPath;
    if (!proc || !fs.existsSync(proc) || rawPaths.length > 1) {
      proc = await resizeMedia(rawPath, meta.width, meta.height, scene.duration);
    }
    procPaths.push(proc);
  }
  scene.mediaProcPaths = procPaths;
  scene.mediaProcPath  = procPaths[0];

  // Rerender never uses cache (user explicitly changed something)
  await renderOneScene({
    processedMediaPaths: procPaths,
    rawMediaPaths:       rawPaths,
    scene,
    width: meta.width, height: meta.height, fps: meta.fps,
    outPath,
    useCache: false,
  });

  // Mux audio
  if (meta.audioPath && fs.existsSync(meta.audioPath) && fs.existsSync(outPath) && scene.duration >= 0.5) {
    const withAudioPath = path.join(dir, `scene_${sceneIndex}_audio.mp4`);
    try {
      await run(
        `ffmpeg -y -i "${outPath}" ` +
        `-ss ${(scene.start || 0).toFixed(3)} -t ${scene.duration.toFixed(3)} -i "${meta.audioPath}" ` +
        `-c:v libx264 -preset ultrafast -crf 18 -pix_fmt yuv420p ` +
        `-c:a aac -b:a 192k -map 0:v:0 -map 1:a:0 -shortest -fflags +genpts "${withAudioPath}"`,
        30000
      );
      if (fs.existsSync(withAudioPath) && fs.statSync(withAudioPath).size > 1000) {
        fs.renameSync(withAudioPath, outPath);
      } else {
        try { fs.unlinkSync(withAudioPath); } catch {}
      }
    } catch {
      try { fs.unlinkSync(withAudioPath); } catch {}
    }
  }

  const thumbPath = path.join(dir, `thumb_${sceneIndex}.jpg`);
  await makeThumbnail(outPath, thumbPath);

  meta.scenes[sceneIndex] = scene;
  saveMeta(sessionId, meta);

  return {
    ...scene,
    previewUrl: `/sessions/${sessionId}/scene_${sceneIndex}.mp4?t=${Date.now()}`,
    thumbUrl:   `/sessions/${sessionId}/thumb_${sceneIndex}.jpg?t=${Date.now()}`,
  };
}

// ─── EXPORT SESSION ───────────────────────────────────────────────────────────

async function exportSession(sessionId, totalDur) {
  const meta   = loadMeta(sessionId);
  const scenes = meta.scenes;

  const videoId     = uuidv4().slice(0, 8);
  const outFilename = `amv_${videoId}.mp4`;
  const tmpOut      = path.join(os.tmpdir(), outFilename);
  const finalOut    = path.join(OUTPUT_DIR, outFilename);

  const actualTotalDur = scenes.reduce((s, sc) => s + (sc.duration || 0), 0);
  const finalDur       = actualTotalDur > 0 ? actualTotalDur : (totalDur || 30);

  const getTransD = (scene, prevScene) => {
    const raw   = getTransitionDuration(scene.transition || "dissolve", scene.dropStrength || 0.5);
    // Clamp: transition can never exceed 75% of the shorter adjacent scene.
    // For very short Hard Cut scenes (0.5-0.6s) this keeps xfade offsets valid.
    const maxTd = Math.min(
      prevScene ? prevScene.duration * 0.75 : 10,
      scene.duration * 0.75
    );
    return Math.max(0.02, Math.min(raw, maxTd));
  };

  const inputs = scenes.map(s => `-i "${s.clipPath}"`);
  inputs.push(`-i "${meta.audioPath}"`);

  const filters = [];

  // Normalize every clip and add an inline tail buffer via tpad.
  // tpad=stop_mode=clone:stop_duration=0.5 appends 0.5s of frozen last-frame
  // to EVERY input stream INSIDE the filter_complex.
  // This guarantees xfade always has frames during the transition window
  // regardless of how long the clip file itself is (short scene, cached clip,
  // composition, or video source). The final -t finalDur trims the output correctly.
  const XFADE_PAD = 0.5;
  for (let i = 0; i < scenes.length; i++) {
    filters.push(
      `[${i}:v:0]fps=${meta.fps || 30},setsar=1,format=yuv420p,` +
      `tpad=stop_mode=clone:stop_duration=${XFADE_PAD}[nv${i}]`
    );
  }

  if (scenes.length === 1) {
    filters.push(`[nv0]null[vout]`);
  } else if (scenes.length === 2) {
    const transD  = getTransD(scenes[1], scenes[0]);
    const offset  = Math.max(0.03, scenes[0].duration - transD);
    const { transition: xfN } = mapTransition(scenes[1].transition || "dissolve");
    filters.push(`[nv0][nv1]xfade=transition=${xfN}:duration=${transD.toFixed(3)}:offset=${offset.toFixed(3)}[vout]`);
  } else {
    let cumOffset = 0;
    for (let i = 1; i < scenes.length; i++) {
      const prevLabel = i === 1 ? "nv0" : `xf${i - 1}`;
      const outLabel  = i === scenes.length - 1 ? "vout" : `xf${i}`;
      const transD    = getTransD(scenes[i], scenes[i - 1]);
      // FIXED: use transD (clamped) not raw duration for offset step.
      // Using scenes[i-1].duration directly causes drift when transD is clamped below raw.
      const step      = Math.max(0.03, scenes[i - 1].duration - transD);
      cumOffset      += step;
      const { transition: xfN } = mapTransition(scenes[i].transition || "dissolve");
      filters.push(
        `[${prevLabel}][nv${i}]xfade=transition=${xfN}:duration=${transD.toFixed(3)}:offset=${parseFloat(cumOffset.toFixed(3))}[${outLabel}]`
      );
    }
  }

  const audioIdx = scenes.length;
  filters.push(`[${audioIdx}:a:0]atrim=0:${finalDur.toFixed(3)},asetpts=PTS-STARTPTS,volume=1.0[aout]`);

  let cmd = `ffmpeg -y ${inputs.join(" ")} `;
  cmd += `-filter_complex "${filters.join(";\n")}" `;
  cmd += `-map "[vout]" -map "[aout]" `;
  cmd += `-t ${finalDur.toFixed(3)} `;
  cmd += `-c:v libx264 -preset fast -crf 18 -pix_fmt yuv420p `;
  cmd += `-c:a aac -b:a 320k -movflags +faststart "${tmpOut}"`;

  console.log(`   🎬 Exporting ${scenes.length} scenes, total=${finalDur.toFixed(1)}s`);

  // Debug: log xfade offset chain so we can verify no drift
  if (scenes.length > 1) {
    let debugOffset = 0;
    const offsetLog = scenes.slice(1).map((s, i) => {
      const td   = getTransD(s, scenes[i]);
      const step = Math.max(0.03, scenes[i].duration - td);
      debugOffset += step;
      return `${debugOffset.toFixed(2)}s`;
    });
    console.log(`   📐 xfade offsets: ${offsetLog.join(" → ")}`);
    console.log(`   📐 scene durations: ${scenes.map(s => s.duration.toFixed(2)+'s').join(", ")}`);
  }

  await run(cmd, 600000);

  if (!fs.existsSync(tmpOut)) throw new Error("FFmpeg produced no output");
  fs.copyFileSync(tmpOut, finalOut);
  try { fs.unlinkSync(tmpOut); } catch {}

  const mb = (fs.statSync(finalOut).size / 1024 / 1024).toFixed(1);
  console.log(`   ✅ Export: ${outFilename} (${mb} MB)`);

  return { videoId, videoUrl: `/output/${outFilename}`, filename: outFilename, duration: finalDur, sceneCount: scenes.length };
}

// ─── UTILITIES ────────────────────────────────────────────────────────────────

function cleanSession(sessionId) {
  const dir = path.join(SESSIONS_DIR, sessionId);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

async function previewTransition(sessionId, sceneIndex) {
  const meta   = loadMeta(sessionId);
  const scenes = meta.scenes;
  const idx    = parseInt(sceneIndex);

  if (idx <= 0)                throw new Error("First scene has no incoming transition");
  if (idx >= scenes.length)    throw new Error(`Scene ${idx} not found`);

  const sceneA = scenes[idx - 1];
  const sceneB = scenes[idx];

  if (!fs.existsSync(sceneA.clipPath) || !fs.existsSync(sceneB.clipPath)) {
    throw new Error("Scene clips not found on disk");
  }

  const dir     = sessionDir(sessionId);
  const outPath = path.join(dir, `trans_preview_${idx}.mp4`);
  const td      = getTransitionDuration(sceneB.transition || "dissolve", sceneB.dropStrength || 0.5);
  const { transition: xfN } = mapTransition(sceneB.transition || "dissolve");

  const clipDur = Math.min(1.5, sceneA.duration, sceneB.duration);
  const aStart  = Math.max(0, sceneA.duration - clipDur);
  const transD  = Math.min(td, clipDur * 0.8);
  const offset  = Math.max(0.02, clipDur - transD);

  const cmd = `ffmpeg -y ` +
    `-ss ${aStart.toFixed(3)} -i "${sceneA.clipPath}" ` +
    `-t ${clipDur.toFixed(3)} -i "${sceneB.clipPath}" ` +
    `-filter_complex "[0:v][1:v]xfade=transition=${xfN}:duration=${transD.toFixed(3)}:offset=${offset.toFixed(3)}[vout]" ` +
    `-map "[vout]" -an ` +
    `-c:v libx264 -preset ultrafast -crf 22 -pix_fmt yuv420p "${outPath}"`;

  await run(cmd, 30000);

  return {
    previewUrl: `/sessions/${sessionId}/trans_preview_${idx}.mp4?t=${Date.now()}`,
    transition: sceneB.transition,
    duration:   transD,
  };
}

function listSessions() {
  if (!fs.existsSync(SESSIONS_DIR)) return [];
  return fs.readdirSync(SESSIONS_DIR)
    .filter(name => fs.existsSync(path.join(SESSIONS_DIR, name, "meta.json")))
    .map(name => {
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, name, "meta.json"), "utf-8"));
        return { sessionId: name, sceneCount: meta.scenes.length, createdAt: meta.createdAt };
      } catch { return null; }
    })
    .filter(Boolean);
}

module.exports = {
  prepareSession, rerenderScene, exportSession, cleanSession, listSessions, previewTransition,
  VALID_EFFECTS:      MOTION_EFFECTS,
  VALID_TRANSITIONS:  TRANSITIONS,
};