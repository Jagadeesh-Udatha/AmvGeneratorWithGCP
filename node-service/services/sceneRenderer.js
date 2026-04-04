/**
 * Scene Renderer Service v3.0
 *
 * NEW IN v3:
 *   - Scene render cache: (imageHash+settings) → skip re-render if identical
 *   - onSceneDone callback: lets jobQueue emit real-time progress per scene
 *   - Composition path uses compositionEngine v2 (22 compositions, all bugs fixed)
 *   - Vertical_wipe crash fixed (uses shrinking black bar, not crop h=0)
 *   - All compositions/effects go through effectsLibrary for validation
 */

const { exec }   = require("child_process");
const crypto     = require("crypto");
const path       = require("path");
const fs         = require("fs");
const os         = require("os");
const { v4: uuidv4 } = require("uuid");

const {
  MOTION_EFFECTS, TRANSITIONS, COLOR_GRADES, OVERLAYS,
  buildColorGrade, buildOverlay, buildSceneFilterChain,
  mapTransition, getTransitionDuration,
  resolveLegacyEffect, resolveLegacyTransition,
} = require("./effectsLibrary");

const { COMPOSITIONS, buildCompositionCmd } = require("./compositionEngine");
const db = require("./database");

const SESSIONS_DIR = path.join(__dirname, "..", "temp", "sessions");
const CACHE_DIR    = path.join(__dirname, "..", "temp", "render_cache");
const OUTPUT_DIR   = path.join(__dirname, "..", "output");

for (const d of [SESSIONS_DIR, CACHE_DIR, OUTPUT_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function run(cmd, timeout = 120000) {
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 100 * 1024 * 1024, timeout }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`FFmpeg error: ${stderr?.slice(-600) || err.message}`));
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

function isVideo(p) { return /\.(mp4|mov|avi|mkv|webm|m4v)$/i.test(p); }

// ─── SCENE CACHE KEY ──────────────────────────────────────────────────────────

/**
 * Build a deterministic cache key for a scene render.
 * Two scenes with the same key will produce identical output, so we can skip re-rendering.
 *
 * FIX: beatsInScene is now included so beat-reactive effects (shake, zoom_pulse, etc.)
 * are not incorrectly served from cache when a different song produces different beat
 * positions for the same image+effect combination.
 */
function buildCacheKey({ mediaPath, effect, composition, colorGrade, overlays, duration, width, height, fps, beatsInScene = [] }) {
  // Hash the file content (first 64KB) + metadata
  let fileHash = "nohash";
  try {
    const fd  = fs.openSync(mediaPath, "r");
    const buf = Buffer.alloc(65536);
    const read = fs.readSync(fd, buf, 0, 65536, 0);
    fs.closeSync(fd);
    fileHash = crypto.createHash("md5").update(buf.slice(0, read)).digest("hex").slice(0, 12);
  } catch {}

  // Quantise beat offsets to 50ms buckets — small jitter shouldn't bust the cache
  const beatsKey = beatsInScene.length > 0
    ? beatsInScene.map(b => Math.round(b * 20) / 20).join(",")
    : "nobeats";

  const keyStr = [
    fileHash,
    effect || "none",
    composition || "none",
    colorGrade || "none",
    JSON.stringify((overlays || []).sort()),
    Math.round(duration * 10) / 10, // round to 0.1s
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
  const out   = path.join(os.tmpdir(), `amvprep_${uuidv4().slice(0,8)}.${isVid?"mp4":"jpg"}`);
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

// ─── RENDER ONE SCENE ─────────────────────────────────────────────────────────

async function renderOneScene({ processedMediaPath, scene, width, height, fps, outPath, useCache = true }) {
  const {
    duration,
    effect      = "ken_burns",
    composition = null,
    colorGrade  = "none",
    overlays    = [],
    beatsInScene = [],
    faceAware   = false,
  } = scene;

  const resolvedEffect = resolveLegacyEffect(effect);

  // ── CHECK CACHE ──────────────────────────────────────────────────────────
  let cacheKey = null;
  if (useCache && !isVideo(processedMediaPath)) {
    cacheKey = buildCacheKey({
      mediaPath:   processedMediaPath,
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

  // ── COMPOSITION PATH ─────────────────────────────────────────────────────
  let cmd;

  if (composition && COMPOSITIONS.has(composition) && !isVideo(processedMediaPath)) {
    cmd = buildCompositionCmd({
      composition,
      inputPath: processedMediaPath,
      outPath,
      duration,
      fps,
      w: width,
      h: height,
      colorGrade,
      overlays,
      beatOffsets: beatsInScene,
    });

    if (cmd) {
      console.log(`   🎬 Composition: ${composition} | grade=${colorGrade} | overlays=[${overlays}] | dur=${duration.toFixed(1)}s`);
      await run(cmd, 120000);
      db.incrementCompositionUse(composition);
      // Save to cache
      if (cacheKey) {
        const size = fs.existsSync(outPath) ? fs.statSync(outPath).size : 0;
        const cacheClipPath = path.join(CACHE_DIR, `${cacheKey}.mp4`);
        fs.copyFileSync(outPath, cacheClipPath);
        db.saveCachedRender({ cacheKey, clipPath: cacheClipPath, imagePath: processedMediaPath, effect: resolvedEffect, composition, colorGrade, overlays, duration, width, height, fps, fileSizeBytes: size });
      }
      return { fromCache: false, cacheKey };
    }
    // buildCompositionCmd returned null — fall through to standard path
  }

  // ── STANDARD PATH ────────────────────────────────────────────────────────
  if (isVideo(processedMediaPath)) {
    const filters = [`setsar=1`, `fps=${fps}`];
    const gradeF  = buildColorGrade(colorGrade);
    if (gradeF) filters.push(gradeF);
    for (const ov of overlays) {
      const ovF = buildOverlay(ov, width, height);
      if (ovF) filters.push(ovF);
    }
    if (!overlays.some(o => o.startsWith("vignette"))) filters.push("vignette=PI/5");

    cmd = `ffmpeg -y -i "${processedMediaPath}" ` +
      `-vf "${filters.join(",")}" ` +
      `-t ${duration.toFixed(3)} -an ` +
      `-c:v libx264 -preset fast -crf 20 -pix_fmt yuv420p "${outPath}"`;
  } else {
    const filterChain = buildSceneFilterChain({
      effect:      resolvedEffect,
      colorGrade,
      overlayList: overlays,
      duration,
      fps,
      w: width,
      h: height,
      beatOffsets: beatsInScene,
      faceAware:   !!faceAware,
    });
    cmd = `ffmpeg -y -loop 1 -t ${(duration + 0.1).toFixed(3)} -i "${processedMediaPath}" ` +
      `-vf "${filterChain}" ` +
      `-t ${duration.toFixed(3)} -an ` +
      `-c:v libx264 -preset fast -crf 20 -pix_fmt yuv420p "${outPath}"`;
  }

  console.log(`   🔧 FFmpeg render: effect=${resolvedEffect} grade=${colorGrade} overlays=[${overlays}] dur=${duration.toFixed(1)}s`);
  const preview = cmd.substring(cmd.indexOf('-vf "') + 5, cmd.indexOf('" -t')).substring(0, 200);
  console.log(`   📝 Filter chain: ${preview}...`);
  await run(cmd, 60000);

  // Save to cache
  if (cacheKey && !isVideo(processedMediaPath)) {
    try {
      const size = fs.existsSync(outPath) ? fs.statSync(outPath).size : 0;
      const cacheClipPath = path.join(CACHE_DIR, `${cacheKey}.mp4`);
      fs.copyFileSync(outPath, cacheClipPath);
      db.saveCachedRender({ cacheKey, clipPath: cacheClipPath, imagePath: processedMediaPath, effect: resolvedEffect, composition: null, colorGrade, overlays, duration, width, height, fps, fileSizeBytes: size });
    } catch {} // cache save failure is non-fatal
  }

  return { fromCache: false, cacheKey };
}

async function makeThumbnail(sceneMp4, thumbPath) {
  try {
    await run(`ffmpeg -y -i "${sceneMp4}" -vframes 1 -q:v 3 "${thumbPath}"`, 10000);
  } catch {} // non-critical
}

// ─── PREPARE SESSION ──────────────────────────────────────────────────────────

/**
 * Pre-render all scenes for a session.
 *
 * @param {object} params
 *   sessionId, scenes, audioPath, width, height, fps
 *   onSceneDone(sceneIdx, sceneResult) — optional progress callback for job queue
 */
async function prepareSession({ sessionId, scenes, audioPath, width = 1080, height = 1920, fps = 30, onSceneDone = null }) {
  const dir      = sessionDir(sessionId);
  const resCache = new Map();
  const processedScenes = [];
  let cacheHits  = 0;

  for (let i = 0; i < scenes.length; i++) {
    const scene     = scenes[i];
    const outPath   = path.join(dir, `scene_${i}.mp4`);
    const thumbPath = path.join(dir, `thumb_${i}.jpg`);

    // Resize/preprocess media (cached by path)
    let mediaProc;
    if (resCache.has(scene.mediaPath)) {
      mediaProc = resCache.get(scene.mediaPath);
    } else {
      mediaProc = await resizeMedia(scene.mediaPath, width, height, scene.duration);
      if (!isVideo(scene.mediaPath)) resCache.set(scene.mediaPath, mediaProc);
    }

    const { fromCache } = await renderOneScene({
      processedMediaPath: mediaProc,
      scene,
      width, height, fps,
      outPath,
      useCache: true,
    });
    if (fromCache) cacheHits++;

    // Mux audio segment into scene video (so preview plays with sound)
    // Only for scenes >= 0.5s — very short scenes get corrupted by the mux
    if (audioPath && fs.existsSync(audioPath) && fs.existsSync(outPath) && scene.duration >= 0.5) {
      const sceneStart = scene.start || 0;
      const withAudioPath = path.join(dir, `scene_${i}_audio.mp4`);
      try {
        await run(
          `ffmpeg -y -i "${outPath}" -ss ${sceneStart.toFixed(3)} -t ${scene.duration.toFixed(3)} -i "${audioPath}" ` +
          `-c:v libx264 -preset ultrafast -crf 18 -pix_fmt yuv420p -c:a aac -b:a 192k ` +
          `-map 0:v:0 -map 1:a:0 -shortest -fflags +genpts "${withAudioPath}"`,
          30000
        );
        if (fs.existsSync(withAudioPath) && fs.statSync(withAudioPath).size > 1000) {
          fs.renameSync(withAudioPath, outPath);
        } else {
          // Muxed file too small = corrupted, keep original
          try { fs.unlinkSync(withAudioPath); } catch {}
        }
      } catch (e) {
        // Non-fatal: scene works without audio
        try { fs.unlinkSync(withAudioPath); } catch {}
      }
    }

    await makeThumbnail(outPath, thumbPath);

    const ovsLabel = (scene.overlays || []).join(",") || "—";
    const compLabel = scene.composition ? ` [${scene.composition}]` : "";
    console.log(`   ✅ Scene ${i+1}/${scenes.length}${compLabel} (${scene.effect || "?"} | ${scene.colorGrade || "none"} | ${ovsLabel})${fromCache ? " ♻️" : ""}`);

    const processedScene = {
      index:         i,
      mediaPath:     scene.mediaPath,
      mediaProcPath: mediaProc,
      start:         scene.start       || 0,
      duration:      scene.duration,
      effect:        scene.effect      || "ken_burns",
      transition:    scene.transition  || "dissolve",
      colorGrade:    scene.colorGrade  || "none",
      overlays:      scene.overlays    || [],
      composition:   scene.composition || null,
      emotion:       scene.emotion     || "neutral",
      beatsInScene:  scene.beatsInScene  || [],
      beatStrengths: scene.beatStrengths || [],
      dropStrength:  scene.dropStrength  || 0.5,
      llmReasoning:  scene.llmReasoning  || null,
      editSource:    scene.editSource    || "patterns",
      faceAware:     scene.faceAware     || false,
      clipPath:      outPath,
      thumbUrl:      `/sessions/${sessionId}/thumb_${i}.jpg`,
      previewUrl:    `/sessions/${sessionId}/scene_${i}.mp4`,
    };

    processedScenes.push(processedScene);

    // Emit real-time progress (for job queue / SSE)
    if (typeof onSceneDone === "function") {
      onSceneDone(i, {
        index:      i,
        previewUrl: processedScene.previewUrl,
        thumbUrl:   processedScene.thumbUrl,
        effect:     processedScene.effect,
        composition: processedScene.composition,
      });
    }
  }

  // Cleanup preprocessed temp files
  for (const [orig, proc] of resCache.entries()) {
    if (proc !== orig) try { fs.unlinkSync(proc); } catch {}
  }

  if (cacheHits > 0) {
    console.log(`   ♻️  Cache: ${cacheHits}/${scenes.length} scenes served from cache`);
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
    scene.composition = (updates.composition && COMPOSITIONS.has(updates.composition)) ? updates.composition : null;
  }

  let mediaProc = scene.mediaProcPath;
  if (!mediaProc || !fs.existsSync(mediaProc)) {
    mediaProc = await resizeMedia(scene.mediaPath, meta.width, meta.height, scene.duration);
    scene.mediaProcPath = mediaProc;
  }

  // Rerender never uses cache (user explicitly changed something)
  await renderOneScene({
    processedMediaPath: mediaProc,
    scene,
    width: meta.width, height: meta.height, fps: meta.fps,
    outPath,
    useCache: false,
  });

  // Mux audio segment into re-rendered scene (skip short scenes)
  if (meta.audioPath && fs.existsSync(meta.audioPath) && fs.existsSync(outPath) && scene.duration >= 0.5) {
    const sceneStart = scene.start || 0;
    const withAudioPath = path.join(dir, `scene_${sceneIndex}_audio.mp4`);
    try {
      await run(
        `ffmpeg -y -i "${outPath}" -ss ${sceneStart.toFixed(3)} -t ${scene.duration.toFixed(3)} -i "${meta.audioPath}" ` +
        `-c:v libx264 -preset ultrafast -crf 18 -pix_fmt yuv420p -c:a aac -b:a 192k ` +
        `-map 0:v:0 -map 1:a:0 -shortest -fflags +genpts "${withAudioPath}"`,
        30000
      );
      if (fs.existsSync(withAudioPath) && fs.statSync(withAudioPath).size > 1000) {
        fs.renameSync(withAudioPath, outPath);
      } else {
        try { fs.unlinkSync(withAudioPath); } catch {}
      }
    } catch (e) {
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

  // FIX: Use actual scene durations rather than relying on caller-supplied totalDur
  const actualTotalDur = scenes.reduce((s, sc) => s + (sc.duration || 0), 0);
  const finalDur = actualTotalDur > 0 ? actualTotalDur : (totalDur || 30);

  const getTransD = (scene, prevScene) => {
    const raw = getTransitionDuration(scene.transition || "dissolve", scene.dropStrength || 0.5);
    const maxTd = Math.min(prevScene ? prevScene.duration * 0.8 : 10, scene.duration * 0.8);
    return Math.max(0.02, Math.min(raw, maxTd));
  };

  // FIX: Use :v:0 stream specifier so clips with muxed audio don't confuse FFmpeg
  const inputs = scenes.map(s => `-i "${s.clipPath}"`);
  inputs.push(`-i "${meta.audioPath}"`);

  const filters = [];

  // FIX: Normalise every clip to same fps/sar/format before xfade to avoid
  // "Input link ... parameters (size 1080x1920, SAR 1:1) do not match" errors.
  for (let i = 0; i < scenes.length; i++) {
    filters.push(`[${i}:v:0]fps=${meta.fps || 30},setsar=1,format=yuv420p[nv${i}]`);
  }

  if (scenes.length === 1) {
    filters.push(`[nv0]null[vout]`);
  } else if (scenes.length === 2) {
    const transD = getTransD(scenes[1], scenes[0]);
    const offset = Math.max(0.03, scenes[0].duration - transD);
    const { transition: xfN } = mapTransition(scenes[1].transition || "dissolve");
    filters.push(`[nv0][nv1]xfade=transition=${xfN}:duration=${transD.toFixed(3)}:offset=${offset.toFixed(3)}[vout]`);
  } else {
    // FIX: cumOffset must account for each transition duration being "consumed"
    // so subsequent offsets line up correctly in the concatenated timeline.
    // Correct formula: cumOffset += (sceneDuration - transitionDuration)
    // which is the amount of unique (non-overlapping) time each scene contributes.
    let cumOffset = 0;
    for (let i = 1; i < scenes.length; i++) {
      const prevLabel = i === 1 ? "nv0" : `xf${i - 1}`;
      const outLabel  = i === scenes.length - 1 ? "vout" : `xf${i}`;
      const transD    = getTransD(scenes[i], scenes[i - 1]);
      // Step = how much of scene[i-1] plays before the transition begins
      const step      = Math.max(0.03, scenes[i - 1].duration - transD);
      cumOffset      += step;
      const { transition: xfN } = mapTransition(scenes[i].transition || "dissolve");
      filters.push(
        `[${prevLabel}][nv${i}]xfade=transition=${xfN}:duration=${transD.toFixed(3)}:offset=${cumOffset.toFixed(3)}[${outLabel}]`
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

  if (idx <= 0) throw new Error("First scene has no incoming transition");
  if (idx >= scenes.length) throw new Error(`Scene ${idx} not found`);

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

  console.log(`   🔀 Transition preview: scene ${idx-1}→${idx} (${sceneB.transition})`);
  await run(cmd, 30000);

  return {
    previewUrl: `/sessions/${sessionId}/trans_preview_${idx}.mp4?t=${Date.now()}`,
    transition: sceneB.transition,
    duration: transD,
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