/**
 * AMV Generator Service v4
 *
 * NOW USES effectsLibrary.js for all effects, transitions, color grades, and overlays.
 *
 * v4 changes:
 *   - Effects/transitions/grades/overlays from effectsLibrary
 *   - EMOTION_PALETTES replaces EMOTION_EFFECTS (richer palettes)
 *   - Color grade and overlay auto-selection per scene
 *   - Legacy one-shot render path updated to use new filter chains
 */

const { exec, execSync } = require("child_process");
const path    = require("path");
const fs      = require("fs");
const os      = require("os");
const { v4: uuidv4 } = require("uuid");
const axios   = require("axios");

const {
  MOTION_EFFECTS,
  TRANSITIONS,
  COLOR_GRADES,
  OVERLAYS,
  EMOTION_PALETTES,
  buildMotionFilter,
  buildSceneFilterChain,
  buildColorGrade,
  buildOverlay,
  mapTransition,
  getTransitionDuration,
  resolveLegacyEffect,
  resolveLegacyTransition,
} = require("./effectsLibrary");

const { applyStutterCuts } = require("./stutterCutEngine");
const { suggestEffects } = require("./editClassifier");

const OUTPUT_DIR  = path.join(__dirname, "..", "output");
const TEMP_DIR    = path.join(__dirname, "..", "temp");
const UPLOADS_DIR = path.join(__dirname, "..", "uploads");
[OUTPUT_DIR, TEMP_DIR, UPLOADS_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

const BEAT_SERVICE = process.env.BEAT_SERVICE_URL || "http://localhost:5051";

// ─── BEAT ANALYSIS ────────────────────────────────────────────────────────────

async function analyzeBeatData(audioPath, sensitivity = 0.5) {
  try {
    await axios.get(`${BEAT_SERVICE}/health`, { timeout: 3000 });
    const res = await axios.post(
      `${BEAT_SERVICE}/analyze`,
      { audio_path: audioPath, sensitivity },
      { timeout: 90000 }
    );
    return res.data;
  } catch (err) {
    console.warn(`   ⚠️  Beat service unavailable (${err.message}) — uniform fallback`);
    return null;
  }
}

function uniformFallback(duration, bpm = 120) {
  const secPerBeat = 60 / bpm;
  const beats = [], strengths = [];
  for (let t = 0; t < duration; t += secPerBeat) {
    beats.push(parseFloat(t.toFixed(3)));
    strengths.push(t % (secPerBeat * 4) < 0.01 ? 0.9 : 0.5);
  }
  const drops = [], dropStr = [];
  for (let t = 0; t < duration; t += secPerBeat * 4) {
    drops.push(parseFloat(t.toFixed(3)));
    dropStr.push(0.8);
  }
  return {
    bpm, duration, beats, beat_strengths: strengths,
    drops, drop_strengths: dropStr,
    drop_emotions:    drops.map(() => "neutral"),
    segment_emotions: drops.map(() => "neutral"),
  };
}

// ─── EMOTION-AWARE PICKERS ──────────────────────────────────────────────────

function pickEffect(emotion, dropStrength, sceneIndex, userOverride) {
  if (userOverride && MOTION_EFFECTS.has(userOverride)) return userOverride;
  const pool = (EMOTION_PALETTES[emotion] || EMOTION_PALETTES.neutral).effects;
  if (dropStrength > 0.75) return pool[0];
  if (dropStrength > 0.50) return pool[sceneIndex % 2 === 0 ? 0 : 1] || pool[0];
  if (dropStrength > 0.30) return pool[sceneIndex % pool.length] || pool[0];
  return pool[pool.length - 1] || "ken_burns";
}

function pickTransition(emotion, dropStrength, sceneIndex, userOverride) {
  if (sceneIndex === 0) return "dissolve";
  if (userOverride && TRANSITIONS.has(userOverride)) return userOverride;
  const pool = (EMOTION_PALETTES[emotion] || EMOTION_PALETTES.neutral).transitions;
  if (dropStrength > 0.80) return pool[0];
  if (dropStrength > 0.60) return pool[Math.min(1, pool.length - 1)];
  if (dropStrength > 0.40) return pool[Math.min(2, pool.length - 1)];
  return pool[pool.length - 1] || "dissolve";
}

function pickColorGrade(emotion, dropStrength, userOverride) {
  if (userOverride && COLOR_GRADES.has(userOverride)) return userOverride;
  const pool = (EMOTION_PALETTES[emotion] || EMOTION_PALETTES.neutral).grades;
  if (dropStrength > 0.70) return pool[0];
  if (dropStrength > 0.40) return pool[Math.min(1, pool.length - 1)];
  return pool[pool.length - 1] || "none";
}

function pickOverlays(emotion, dropStrength) {
  const pool = (EMOTION_PALETTES[emotion] || EMOTION_PALETTES.neutral).overlays;
  // Always include first overlay (usually vignette); add more at high intensity
  const result = [pool[0]];
  if (dropStrength > 0.6 && pool.length > 1) result.push(pool[1]);
  return result.filter(Boolean);
}

// ─── MEDIA HELPERS ────────────────────────────────────────────────────────────

function isVideo(p) { return /\.(mp4|mov|avi|mkv|webm|m4v)$/i.test(p); }

function toSafe(p) {
  if (!p || !fs.existsSync(p)) return null;
  const dst = path.join(os.tmpdir(), `amv_${uuidv4().slice(0, 8)}${path.extname(p)}`);
  fs.copyFileSync(p, dst);
  return dst;
}

function resizeToCanvas(input, width, height) {
  return new Promise((resolve, reject) => {
    const out = path.join(os.tmpdir(), `amvframe_${uuidv4().slice(0, 8)}.jpg`);
    const cmd = `ffmpeg -y -i "${input}" ` +
      `-vf "scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black" -q:v 2 "${out}"`;
    exec(cmd, { timeout: 20000 }, err => err ? reject(err) : resolve(out));
  });
}

function processVideoClip(videoPath, targetDuration, width, height) {
  return new Promise((resolve, reject) => {
    const out = path.join(os.tmpdir(), `amvclip_${uuidv4().slice(0, 8)}.mp4`);
    const cmd = `ffmpeg -y -i "${videoPath}" -t ${targetDuration.toFixed(3)} ` +
      `-vf "scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=30" ` +
      `-an -c:v libx264 -preset ultrafast -crf 23 "${out}"`;
    exec(cmd, { timeout: 60000 }, err => err ? reject(err) : resolve(out));
  });
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function generateAMV(options) {
  const {
    audioPath,
    mediaPaths   = [],
    manualDrops  = null,
    sensitivity  = 0.5,
    aspectRatio  = "9:16",
    maxDuration  = 60,
    beatMap      = {},
  } = options;

  if (!audioPath || !fs.existsSync(audioPath)) throw new Error("Audio file not found");
  if (!mediaPaths.length)                        throw new Error("No media files provided");

  const videoId     = uuidv4().slice(0, 8);
  const outFilename = `amv_${videoId}.mp4`;
  const tmpOut      = path.join(os.tmpdir(), outFilename);
  const finalOut    = path.join(OUTPUT_DIR, outFilename);

  const width  = aspectRatio === "9:16" ? 1080 : 1920;
  const height = aspectRatio === "9:16" ? 1920 : 1080;
  const fps    = 30;

  // ── 1. Beat / drop analysis ───────────────────────────────────────────────
  console.log("   🎵 Analyzing audio for drops + emotions...");
  let beatData;

  if (manualDrops && manualDrops.length > 0) {
    beatData = {
      drops:            manualDrops,
      drop_strengths:   manualDrops.map(() => 0.8),
      drop_emotions:    manualDrops.map(() => "neutral"),
      beats:            manualDrops,
      beat_strengths:   manualDrops.map(() => 0.6),
      segment_emotions: manualDrops.map(() => "neutral"),
      bpm:              120,
      duration:         manualDrops[manualDrops.length - 1] + 2,
    };
    console.log(`   ✅ Using ${manualDrops.length} manual drops`);
  } else {
    beatData = await analyzeBeatData(audioPath, sensitivity);
    if (!beatData) {
      let dur = 30;
      try {
        const p = execSync(
          `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${audioPath}"`,
          { encoding: "utf-8", timeout: 10000 }
        );
        dur = parseFloat(p.trim()) || 30;
      } catch {}
      beatData = uniformFallback(dur, 120);
      console.log(`   ⚠️  Beat service offline — uniform fallback`);
    } else {
      const emos = beatData.drop_emotions || [];
      const emoCount = emos.reduce((acc, e) => { acc[e] = (acc[e] || 0) + 1; return acc; }, {});
      console.log(`   ✅ ${beatData.bpm} BPM · ${beatData.beat_count} beats · ${beatData.drop_count} drops`);
      console.log(`   🎭 Emotions: ${JSON.stringify(emoCount)}`);
    }
  }

  const totalDur = Math.min(beatData.duration || 30, maxDuration);
  const drops    = (beatData.drops || []).filter(t => t < totalDur);
  const dropStr  = beatData.drop_strengths || drops.map(() => 0.7);
  const dropEmos = beatData.drop_emotions   || drops.map(() => "neutral");
  const allBeats = (beatData.beats || []).filter(t => t < totalDur);
  const beatStr  = beatData.beat_strengths  || allBeats.map(() => 0.5);

  if (drops.length === 0) {
    console.warn("   ⚠️  No drops detected — treating every 4th beat as drop");
    drops.push(...allBeats.filter((_, i) => i % 4 === 0));
    dropStr.push(...drops.map(() => 0.7));
    dropEmos.push(...drops.map(() => "neutral"));
  }

  // ── 2. Build raw scenes ───────────────────────────────────────────────────
  const boundaries = [0, ...drops, totalDur].filter((t, i, arr) => t !== arr[i - 1]);
  const rawScenes = [];

  for (let i = 0; i < boundaries.length - 1; i++) {
    const sceneStart = boundaries[i];
    const sceneEnd   = boundaries[i + 1];
    const sceneDur   = parseFloat((sceneEnd - sceneStart).toFixed(3));
    if (sceneDur < 0.1) continue;

    const dropIdx  = i;
    const strength = dropIdx > 0 ? (dropStr[dropIdx - 1] ?? 0.7) : 0;
    const emotion  = dropIdx > 0 ? (dropEmos[dropIdx - 1] ?? "neutral") : (dropEmos[0] ?? "neutral");

    const sceneBeats = allBeats
      .filter(t => t >= sceneStart && t < sceneEnd)
      .map(t => parseFloat((t - sceneStart).toFixed(3)));
    const sceneStrengths = sceneBeats.map(bt => {
      const idx = allBeats.findIndex(t => Math.abs(t - (bt + sceneStart)) < 0.01);
      return idx >= 0 ? (beatStr[idx] ?? 0.5) : 0.5;
    });

    // Find segment features from beat detector for this scene
    const segFeats = beatData.segment_features || [];
    const segFeat  = segFeats[dropIdx] || null;

    rawScenes.push({
      index:           rawScenes.length,
      mediaPath:       mediaPaths[rawScenes.length % mediaPaths.length],
      isVideo:         isVideo(mediaPaths[rawScenes.length % mediaPaths.length]),
      start:           sceneStart,
      end:             sceneEnd,
      duration:        sceneDur,
      dropStrength:    strength,
      emotion,
      beatsInScene:    sceneBeats,
      beatStrengths:   sceneStrengths,
      segmentFeatures: segFeat,
      mediaIndex:      rawScenes.length % mediaPaths.length,
    });
  }

  // ── 2a. Apply classifier with variety enforcement ─────────────────────
  const globalFeatures = {
    bpm:      beatData.bpm || 120,
    energy:   0.5,
    centroid: 0.5,
    onset:    0.5,
  };
  const suggestedScenes = suggestEffects(rawScenes, globalFeatures, beatData);

  // Apply beatMap overrides
  const scenes = suggestedScenes.map((scene, i) => {
    const overrideKey = String(i);
    const override    = beatMap[overrideKey] || {};
    return {
      ...scene,
      effect:     override.effect     || scene.effect,
      transition: override.transition || scene.transition,
      colorGrade: override.colorGrade || scene.colorGrade || "none",
      overlays:   override.overlays   || scene.overlays   || [],
    };
  });

  const emoSummary = scenes.map(s => `${s.emotion}:${s.effect}/${s.transition}/${s.colorGrade}`).join(", ");
  console.log(`   🎬 ${scenes.length} scenes built`);
  console.log(`   🎭 Scene plan: ${emoSummary}`);

  // ── 2b. Apply stutter cuts (split rapid-beat scenes into micro-cuts) ────
  const finalScenes = applyStutterCuts(scenes, allBeats, {
    bpm: beatData.bpm || 120,
    enabled: true,
  });
  finalScenes.forEach((s, i) => { s.mediaIndex = s.mediaIndex ?? (i % mediaPaths.length); });

  // ── 3. Pre-process media ──────────────────────────────────────────────────
  console.log("   🖼️  Pre-processing media...");
  const resizeCache = new Map();
  const processed   = [];

  for (const scene of finalScenes) {
    let pPath;
    if (scene.isVideo) {
      pPath = await processVideoClip(scene.mediaPath, scene.duration, width, height);
    } else {
      if (resizeCache.has(scene.mediaPath)) {
        pPath = resizeCache.get(scene.mediaPath);
      } else {
        pPath = await resizeToCanvas(scene.mediaPath, width, height);
        resizeCache.set(scene.mediaPath, pPath);
      }
    }
    processed.push({ ...scene, processedPath: pPath });
  }

  // ── 4. Build FFmpeg command ───────────────────────────────────────────────
  const safeAudio = toSafe(audioPath);
  const cmd = buildFFmpegCmd(processed, safeAudio, { width, height, fps, totalDur, outputPath: tmpOut });
  console.log(`   🔧 FFmpeg: ${cmd.length} chars, ${processed.length} inputs`);

  // ── 5. Render ─────────────────────────────────────────────────────────────
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 300 * 1024 * 1024, timeout: 600000 }, (err, _stdout, stderr) => {
      [...resizeCache.values()].forEach(p => { try { fs.unlinkSync(p); } catch {} });
      processed.filter(s => s.isVideo && s.processedPath)
        .forEach(s => { try { fs.unlinkSync(s.processedPath); } catch {} });
      if (safeAudio) try { fs.unlinkSync(safeAudio); } catch {}

      if (fs.existsSync(tmpOut)) {
        fs.copyFileSync(tmpOut, finalOut);
        try { fs.unlinkSync(tmpOut); } catch {}
      }

      if (err) {
        console.error("   ❌ FFmpeg stderr:", stderr?.slice(-1000));
        return reject(new Error(`FFmpeg failed: ${err.message}`));
      }
      if (!fs.existsSync(finalOut)) {
        return reject(new Error("FFmpeg produced no output"));
      }

      const mb = (fs.statSync(finalOut).size / 1024 / 1024).toFixed(1);
      console.log(`   ✅ ${outFilename} (${mb}MB)`);
      resolve({
        videoId, videoPath: finalOut,
        videoUrl:   `/output/${outFilename}`,
        filename:   outFilename,
        duration:   totalDur,
        sceneCount: processed.length,
        bpm:        beatData.bpm,
        dropCount:  drops.length,
        emotions:   finalScenes.map(s => s.emotion),
      });
    });
  });
}

// ─── FFMPEG COMMAND BUILDER ───────────────────────────────────────────────────

function buildFFmpegCmd(scenes, audioPath, opts) {
  const { width, height, fps, totalDur, outputPath } = opts;

  const inputs = scenes.map(scene => {
    const td = getTransitionDuration(scene.transition, scene.dropStrength || 0.5);
    if (scene.isVideo) return `-i "${scene.processedPath}"`;
    return `-loop 1 -t ${(scene.duration + td + 0.05).toFixed(3)} -i "${scene.processedPath}"`;
  });
  inputs.push(`-i "${audioPath}"`);

  const filterParts = [];

  scenes.forEach((scene, i) => {
    const td  = getTransitionDuration(scene.transition, scene.dropStrength || 0.5);
    const dur = scene.duration + td + 0.05;

    if (scene.isVideo) {
      // Video: color grade + overlays only
      const filters = [`setsar=1`, `fps=${fps}`];
      const gradeF = buildColorGrade(scene.colorGrade || "none");
      if (gradeF) filters.push(gradeF);
      for (const ov of (scene.overlays || [])) {
        const ovF = buildOverlay(ov, width, height);
        if (ovF) filters.push(ovF);
      }
      if (!(scene.overlays || []).some(o => o.startsWith("vignette"))) {
        filters.push("vignette=PI/5");
      }
      filterParts.push(`[${i}:v]${filters.join(",")}[v${i}]`);
    } else {
      // Image: full filter chain with motion + grade + overlays
      const filterChain = buildSceneFilterChain({
        effect:      scene.effect || "ken_burns",
        colorGrade:  scene.colorGrade || "none",
        overlayList: scene.overlays || [],
        duration:    dur,
        fps,
        w: width,
        h: height,
        beatOffsets: scene.beatsInScene || [],
        faceAware:   !!scene.faceAware,
      });
      filterParts.push(`[${i}:v]${filterChain}[v${i}]`);
    }
  });

  if (scenes.length === 1) {
    filterParts.push(`[v0]null[vout]`);
  } else if (scenes.length === 2) {
    const td     = getTransitionDuration(scenes[1].transition, scenes[1].dropStrength || 0.5);
    const offset = Math.max(0.02, scenes[0].duration - td);
    const { transition: xfN } = mapTransition(scenes[1].transition || "dissolve");
    filterParts.push(`[v0][v1]xfade=transition=${xfN}:duration=${td}:offset=${offset.toFixed(3)}[vout]`);
  } else {
    let cumOffset = 0;
    for (let i = 1; i < scenes.length; i++) {
      const prevLabel = i === 1 ? "v0" : `xf${i - 1}`;
      const outLabel  = i === scenes.length - 1 ? "vout" : `xf${i}`;
      const td        = getTransitionDuration(scenes[i].transition, scenes[i].dropStrength || 0.5);
      cumOffset      += scenes[i - 1].duration - td;
      const { transition: xfN } = mapTransition(scenes[i].transition || "dissolve");
      filterParts.push(
        `[${prevLabel}][v${i}]xfade=transition=${xfN}:duration=${td}:offset=${Math.max(0.02, cumOffset).toFixed(3)}[${outLabel}]`
      );
    }
  }

  const audioIdx = scenes.length;
  filterParts.push(
    `[${audioIdx}:a]atrim=0:${totalDur.toFixed(3)},asetpts=PTS-STARTPTS,volume=1.0[aout]`
  );

  let cmd = `ffmpeg -y ${inputs.join(" ")}`;
  cmd += ` -filter_complex "${filterParts.join(";\n")}"`;
  cmd += ` -map "[vout]" -map "[aout]"`;
  cmd += ` -t ${totalDur.toFixed(3)}`;
  cmd += ` -c:v libx264 -preset fast -crf 18 -pix_fmt yuv420p`;
  cmd += ` -c:a aac -b:a 320k -movflags +faststart "${outputPath}"`;
  return cmd;
}

module.exports = {
  generateAMV,
  analyzeBeatData,
  EMOTION_PALETTES,
  VALID_TRANSITIONS: TRANSITIONS,
  VALID_EFFECTS: MOTION_EFFECTS,
};
