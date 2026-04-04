/**
 * Video Generator Service v2.3
 *
 * FIXES:
 *  - More robust freetype/libass detection — checks both `ffmpeg -filters` and
 *    `ffmpeg -buildconf` so Homebrew builds are correctly detected
 *  - Prints actionable brew command when subtitles are unavailable
 *  - Temp-file cleanup now handles errors silently so a failed delete
 *    never crashes the pipeline
 */

const { exec, execSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { v4: uuidv4 } = require("uuid");

const OUTPUT_DIR = path.join(__dirname, "..", "output");
const TEMP_DIR = path.join(__dirname, "..", "temp");
const MUSIC_DIR = path.join(__dirname, "..", "assets", "music");

[OUTPUT_DIR, TEMP_DIR].forEach((d) => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ─── DETECT AVAILABLE FILTERS ────────────────────────────────────────────────
// FIX: check both -filters output AND build configuration to catch Homebrew ffmpeg
let HAS_ASS = false;
let HAS_DRAWTEXT = false;

try {
  const filters = execSync("ffmpeg -filters 2>&1", { encoding: "utf-8", timeout: 5000 });
  HAS_ASS = /\bass\b/.test(filters);
  HAS_DRAWTEXT = /\bdrawtext\b/.test(filters);

  // Secondary check: if ASS missing, look in build config (some builds hide it from -filters)
  if (!HAS_ASS) {
    try {
      const buildConf = execSync("ffmpeg -buildconf 2>&1", { encoding: "utf-8", timeout: 5000 });
      if (/--enable-libass/.test(buildConf)) HAS_ASS = true;
      if (/--enable-libfreetype/.test(buildConf)) HAS_DRAWTEXT = true;
    } catch {}
  }
} catch {}

const subMethod = HAS_ASS ? "ass" : HAS_DRAWTEXT ? "drawtext" : "none";

if (subMethod === "none") {
  console.log(`   🔍 FFmpeg subtitle support: none`);
  console.log(`      ➡  To enable subtitles on macOS: brew install ffmpeg`);
  console.log(`      ➡  If already installed: brew reinstall ffmpeg`);
  console.log(`      ➡  On Linux: sudo apt install ffmpeg`);
} else {
  console.log(`   🔍 FFmpeg subtitle support: ${subMethod} ✅`);
}

const VALID_TRANSITIONS = new Set([
  "fade", "fadeblack", "fadewhite", "wipeleft", "wiperight",
  "wipeup", "wipedown", "slidedown", "slideup", "slideleft", "slideright",
  "smoothleft", "smoothright", "smoothup", "smoothdown",
  "circlecrop", "dissolve", "pixelize", "hblur",
]);

// ─── SAFE PATH ────────────────────────────────────────────────────────────────
function toSafePath(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  const ext = path.extname(filePath);
  const safeName = `avgen_${uuidv4().slice(0, 8)}${ext}`;
  const safePath = path.join(os.tmpdir(), safeName);
  fs.copyFileSync(filePath, safePath);
  return safePath;
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function generateVideo(options) {
  const {
    scenes = [],
    audioPath = null,
    musicPath = null,
    subtitlePath = null,
    duration = 15,
    aspectRatio = "9:16",
  } = options;

  const videoId = uuidv4().slice(0, 8);
  const outputFilename = `anime_${videoId}.mp4`;
  const tmpOutputPath = path.join(os.tmpdir(), outputFilename);
  const finalOutputPath = path.join(OUTPUT_DIR, outputFilename);

  const width = aspectRatio === "9:16" ? 1080 : 1920;
  const height = aspectRatio === "9:16" ? 1920 : 1080;
  const fps = 25;

  if (scenes.length === 0) throw new Error("No scenes provided");

  const validScenes = scenes.filter((s) => s.imagePath && fs.existsSync(s.imagePath));
  if (validScenes.length === 0) throw new Error("No valid scene images found");

  const safeScenes = validScenes.map((s) => ({ ...s, imagePath: toSafePath(s.imagePath) }));
  const safeAudio = audioPath ? toSafePath(audioPath) : null;
  const safeMusic = musicPath ? toSafePath(musicPath) : null;
  const safeSubs = subtitlePath ? toSafePath(subtitlePath) : null;

  const hasAudio = !!(safeAudio && fs.statSync(safeAudio).size > 100);
  const hasMusic = !!(safeMusic && fs.statSync(safeMusic).size > 100);

  console.log(`   🎬 Composing: ${safeScenes.length} scenes, audio=${hasAudio}, music=${hasMusic}, subs=${subMethod}`);

  let ffmpegCmd;
  if (safeScenes.length === 1) {
    ffmpegCmd = buildSingleSceneCommand(safeScenes[0], {
      hasAudio, audioPath: safeAudio, hasMusic, musicPath: safeMusic,
      subtitlePath: safeSubs, allScenes: safeScenes,
      width, height, fps, duration, outputPath: tmpOutputPath,
    });
  } else {
    ffmpegCmd = buildMultiSceneCommand(safeScenes, {
      hasAudio, audioPath: safeAudio, hasMusic, musicPath: safeMusic,
      subtitlePath: safeSubs,
      width, height, fps, duration, outputPath: tmpOutputPath,
    });
  }

  console.log(`   🔧 FFmpeg cmd length: ${ffmpegCmd.length} chars`);

  return new Promise((resolve, reject) => {
    exec(ffmpegCmd, { maxBuffer: 100 * 1024 * 1024, timeout: 300000 }, (error, stdout, stderr) => {
      if (fs.existsSync(tmpOutputPath)) {
        fs.copyFileSync(tmpOutputPath, finalOutputPath);
        try { fs.unlinkSync(tmpOutputPath); } catch {}
      }
      cleanupSafe(safeScenes, safeAudio, safeMusic, safeSubs);

      if (error) {
        console.error("   ❌ FFmpeg stderr (last 500):", stderr?.slice(-500));
        reject(new Error(`FFmpeg failed: ${error.message}`));
        return;
      }
      if (!fs.existsSync(finalOutputPath)) {
        reject(new Error("FFmpeg ran but no output file created"));
        return;
      }

      const mb = (fs.statSync(finalOutputPath).size / 1024 / 1024).toFixed(1);
      console.log(`   ✅ Output: ${outputFilename} (${mb}MB)`);

      resolve({
        videoId,
        videoPath: finalOutputPath,
        videoUrl: `/output/${outputFilename}`,
        filename: outputFilename,
        duration,
        hasAudio,
        hasMusic,
        subtitleMethod: subMethod,
      });
    });
  });
}

// FIX: cleanup now wraps each delete in its own try/catch — one failure won't crash others
function cleanupSafe(scenes, audio, music, subs) {
  const tmp = os.tmpdir();
  [audio, music, subs].forEach((p) => {
    if (p && p.startsWith(tmp) && p.includes("avgen_")) {
      try { fs.unlinkSync(p); } catch {}
    }
  });
  scenes.forEach((s) => {
    if (s.imagePath?.startsWith(tmp) && s.imagePath.includes("avgen_")) {
      try { fs.unlinkSync(s.imagePath); } catch {}
    }
  });
}

// ─── SINGLE SCENE ─────────────────────────────────────────────────────────────

function buildSingleSceneCommand(scene, opts) {
  const { hasAudio, audioPath, hasMusic, musicPath, subtitlePath, allScenes, width, height, fps, duration, outputPath } = opts;

  let cmd = `ffmpeg -y -loop 1 -t ${duration} -i "${scene.imagePath}"`;
  if (hasAudio) cmd += ` -i "${audioPath}"`;
  if (hasMusic) cmd += ` -i "${musicPath}"`;

  const vf = [
    `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black`,
    `setsar=1`,
    getEffectFilter(scene.effect || "zoom_in", duration, fps, width, height),
    `fps=${fps}`,
    `vignette=PI/5`,
    ...getSubtitleFilters(subtitlePath, allScenes || [scene], width, height),
  ];

  cmd += ` -vf "${vf.filter(Boolean).join(",")}"`;
  cmd += buildAudioMapping(1, hasAudio, hasMusic);
  cmd += ` -t ${duration} -c:v libx264 -preset fast -crf 23 -pix_fmt yuv420p -c:a aac -b:a 192k -movflags +faststart "${outputPath}"`;
  return cmd;
}

// ─── MULTI-SCENE ──────────────────────────────────────────────────────────────

function buildMultiSceneCommand(scenes, opts) {
  const { hasAudio, audioPath, hasMusic, musicPath, subtitlePath, width, height, fps, duration, outputPath } = opts;
  const transitionDur = 0.4;

  const inputs = scenes.map((s) => {
    const d = s.duration + transitionDur;
    return `-loop 1 -t ${d.toFixed(2)} -i "${s.imagePath}"`;
  });
  if (hasAudio) inputs.push(`-i "${audioPath}"`);
  if (hasMusic) inputs.push(`-i "${musicPath}"`);

  const filterParts = [];

  scenes.forEach((scene, i) => {
    const d = scene.duration + transitionDur;
    const parts = [
      `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black`,
      `setsar=1`,
      getEffectFilter(scene.effect || "zoom_in", d, fps, width, height),
      `fps=${fps}`,
      `vignette=PI/5`,
    ].filter(Boolean);
    filterParts.push(`[${i}:v]${parts.join(",")}[v${i}]`);
  });

  if (scenes.length === 2) {
    const offset = Math.max(0.1, scenes[0].duration - transitionDur);
    const trans = sanitizeTransition(scenes[1].transition);
    filterParts.push(`[v0][v1]xfade=transition=${trans}:duration=${transitionDur}:offset=${offset.toFixed(2)}[vout]`);
  } else {
    let cumOffset = 0;
    for (let i = 1; i < scenes.length; i++) {
      const prevLabel = i === 1 ? "v0" : `xf${i - 1}`;
      const outLabel = i === scenes.length - 1 ? "vout" : `xf${i}`;
      cumOffset += scenes[i - 1].duration - transitionDur;
      const trans = sanitizeTransition(scenes[i].transition);
      filterParts.push(
        `[${prevLabel}][v${i}]xfade=transition=${trans}:duration=${transitionDur}:offset=${Math.max(0.1, cumOffset).toFixed(2)}[${outLabel}]`
      );
    }
  }

  const subFilters = getSubtitleFilters(subtitlePath, scenes, width, height);
  if (subFilters.length > 0) {
    filterParts.push(`[vout]${subFilters.join(",")}[vfinal]`);
  } else {
    filterParts.push(`[vout]null[vfinal]`);
  }

  const audioInputIdx = scenes.length;
  const audioFilters = [];
  const audioLabels = [];

  if (hasAudio) {
    audioFilters.push(`[${audioInputIdx}:a]volume=1.0,apad[narr]`);
    audioLabels.push("[narr]");
  }
  if (hasMusic) {
    const musicIdx = hasAudio ? audioInputIdx + 1 : audioInputIdx;
    audioFilters.push(`[${musicIdx}:a]volume=0.12,aloop=loop=-1:size=2e+09[bgloop]`);
    audioLabels.push("[bgloop]");
  }
  if (audioFilters.length > 0) filterParts.push(...audioFilters);
  if (audioLabels.length === 2) {
    filterParts.push(`${audioLabels.join("")}amix=inputs=2:duration=first:dropout_transition=2[aout]`);
  } else if (audioLabels.length === 1) {
    filterParts.push(`${audioLabels[0]}acopy[aout]`);
  }

  let cmd = `ffmpeg -y ${inputs.join(" ")}`;
  cmd += ` -filter_complex "${filterParts.join(";\n")}"`;
  cmd += ` -map "[vfinal]"`;
  if (audioLabels.length > 0) cmd += ` -map "[aout]"`;

  const totalDur = scenes.reduce((sum, s) => sum + s.duration, 0);
  cmd += ` -t ${totalDur.toFixed(1)} -c:v libx264 -preset fast -crf 23 -pix_fmt yuv420p`;
  if (audioLabels.length > 0) cmd += ` -c:a aac -b:a 192k`;
  cmd += ` -movflags +faststart "${outputPath}"`;

  return cmd;
}

// ─── SUBTITLE FILTER SELECTION ────────────────────────────────────────────────

function getSubtitleFilters(subtitlePath, scenes, width, height) {
  if (HAS_ASS && subtitlePath && fs.existsSync(subtitlePath)) {
    return [`ass=${subtitlePath}`];
  }
  if (HAS_DRAWTEXT && scenes.length > 0) {
    return buildDrawtextFilters(scenes, width, height);
  }
  return [];
}

function buildDrawtextFilters(scenes, width, height) {
  const filters = [];
  let t = 0;

  scenes.forEach((scene) => {
    const st = t + 0.2;
    const et = t + scene.duration - 0.2;

    if (scene.subtitle?.trim()) {
      const text = escDT(scene.subtitle.trim());
      filters.push(
        `drawtext=text='${text}':fontsize=60:fontcolor=white:borderw=4:bordercolor=black:x=(w-text_w)/2:y=h*0.20:enable='between(t\\,${st.toFixed(2)}\\,${et.toFixed(2)})'`
      );
    }

    if (scene.narration?.trim()) {
      let narr = scene.narration.trim();
      if (narr.length > 55) narr = narr.slice(0, 52) + "...";
      const text = escDT(narr);
      filters.push(
        `drawtext=text='${text}':fontsize=30:fontcolor=white:borderw=3:bordercolor=black:x=(w-text_w)/2:y=h*0.88:enable='between(t\\,${st.toFixed(2)}\\,${et.toFixed(2)})'`
      );
    }

    t += scene.duration;
  });

  return filters;
}

function escDT(text) {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\u2019")
    .replace(/:/g, "\\:")
    .replace(/%/g, "%%")
    .replace(/\n/g, " ");
}

// ─── EFFECTS ──────────────────────────────────────────────────────────────────

function getEffectFilter(effect, duration, fps, w, h) {
  const totalFrames = Math.floor(duration * fps);
  const s = `${w}x${h}`;

  switch (effect) {
    case "zoom_in":
      return `zoompan=z='min(zoom+0.003,1.4)':d=${totalFrames}:s=${s}:fps=${fps}`;
    case "zoom_out":
      return `zoompan=z='max(1.4-on*0.003,1.0)':d=${totalFrames}:s=${s}:fps=${fps}`;
    case "pan_left":
      return `zoompan=z=1.2:x='iw/2-(iw/zoom/2)+on*2':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${s}:fps=${fps}`;
    case "pan_right":
      return `zoompan=z=1.2:x='iw/2-(iw/zoom/2)-on*2':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${s}:fps=${fps}`;
    case "ken_burns":
      return `zoompan=z='1.0+0.002*on':x='iw/2-(iw/zoom/2)+on*0.5':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${s}:fps=${fps}`;
    case "static":
    default:
      return `zoompan=z=1.05:d=${totalFrames}:s=${s}:fps=${fps}`;
  }
}

function buildAudioMapping(videoInputCount, hasAudio, hasMusic) {
  const audioIdx = videoInputCount;
  const musicIdx = hasAudio ? audioIdx + 1 : audioIdx;

  if (hasAudio && hasMusic) {
    return ` -filter_complex "[${audioIdx}:a]volume=1.0[narr];[${musicIdx}:a]volume=0.12[bg];[narr][bg]amix=inputs=2:duration=first[aout]" -map 0:v -map "[aout]"`;
  } else if (hasAudio) {
    return ` -map 0:v -map ${audioIdx}:a`;
  } else if (hasMusic) {
    return ` -map 0:v -map ${musicIdx}:a`;
  }
  return "";
}

function sanitizeTransition(trans) {
  if (trans && VALID_TRANSITIONS.has(trans.toLowerCase())) return trans.toLowerCase();
  return "fade";
}

function findMusicTrack(mood) {
  if (!fs.existsSync(MUSIC_DIR)) return null;
  const files = fs.readdirSync(MUSIC_DIR).filter(
    (f) => f.endsWith(".mp3") || f.endsWith(".wav") || f.endsWith(".ogg")
  );
  if (files.length === 0) return null;
  const moodFile = files.find((f) => f.toLowerCase().includes(mood?.toLowerCase() || ""));
  return path.join(MUSIC_DIR, moodFile || files[0]);
}

async function getVideoInfo(videoPath) {
  return new Promise((resolve, reject) => {
    exec(`ffprobe -v quiet -print_format json -show_format -show_streams "${videoPath}"`,
      (error, stdout) => {
        if (error) reject(error);
        else resolve(JSON.parse(stdout));
      }
    );
  });
}

module.exports = { generateVideo, getVideoInfo, findMusicTrack };
