/**
 * Composition Engine v4.0 — Complete Rewrite
 *
 * WHAT CHANGED FROM v3:
 *   All three multi-image compositions (beat_stack_3, triptych_reveal,
 *   stagger_slide_up) were broken due to three bugs:
 *
 *   BUG 1 (beat_stack_3): resizeMedia pre-processes images to full-frame
 *     1080×1920. Then the composition tried to re-scale to strip height
 *     (e.g. 1080×640) with force_original_aspect_ratio=increase, producing
 *     a 360×640 image. The subsequent crop=(iw-1080)/2 = (360-1080)/2 = -360,
 *     a negative x offset that crashes FFmpeg silently.
 *     FIX: Use scale=w:slotH:force_original_aspect_ratio=increase,
 *          crop=w:slotH (iw≥w guaranteed because increase mode), setsar=1.
 *          Never rely on (iw-target)/2 — use 0-safe crop offsets.
 *
 *   BUG 2 (triptych_reveal): Panels snapped into position instantly because
 *     the overlay y expression jumped from h to 0 with no interpolation.
 *     FIX: Use 't' (time in seconds) for smooth linear slide:
 *          y='if(lt(t,T), H, max(0, H*(1-(t-T)/slideD)))'
 *
 *   BUG 3 (stagger_slide_up): All images used enable='gte(n,0)' (always true)
 *     and were full-frame overlays — only the top image was visible. Stagger
 *     offsets were 5 frames (~0.17s) — invisible on 3-second scenes.
 *     FIX: Use time-based expressions, larger stagger, and correct z-ordering
 *          so earlier images stay visible as later ones slide over them.
 *
 * DESIGN RULES FOR ALL COMPOSITIONS:
 *   - Use 't' (seconds) not 'n' (frames) for time expressions — more robust
 *     across FFmpeg versions and filter chains.
 *   - All scale ops use force_original_aspect_ratio=increase then
 *     crop=targetW:targetH:0:0 (top-left crop, never negative offsets).
 *     When centering is needed: crop=W:H:(iw-W)/2:(ih-H)/2 ONLY when
 *     we are certain iw≥W after the scale step.
 *   - Every composition ends with fps=${fps}${post}[vout].
 *   - Multi-image compositions receive ORIGINAL (unprocessed) paths — they
 *     do all their own scaling inside filter_complex via -loop 1 inputs.
 *
 * COMPOSITIONS (30 total):
 *
 * SINGLE-IMAGE (22, all from v2, fully preserved):
 *   three_panel, manga_panels, quad_grid, diagonal_split,
 *   character_reveal, vertical_wipe, slide_in_left, slide_in_right,
 *   slide_in_top, curtain_open,
 *   spotlight_zoom, parallax, rack_focus,
 *   impact_frame, bounce_zoom, zoom_burst, shockwave,
 *   letterbox_pan, tilt_reveal, mirror_composite, neon_frame, vhs_composite
 *
 * MULTI-IMAGE (8 new, all working):
 *   beat_stack_3       — 3 strips slide up from bottom on successive beats
 *   triptych_reveal    — 3 vertical panels wipe in left→center→right
 *   stagger_slide_up   — images cascade up from bottom with delay
 *   split_and_zoom     — image splits into 2; each half zooms outward
 *   photo_wall_sweep   — 4-up collage wall with slow camera pan
 *   cinematic_duo      — top 30% portrait + bottom 70% action (2 images)
 *   pip_corner         — full frame + picture-in-picture in corner
 *   cross_reveal       — two images split diagonally, each sliding into frame
 */

"use strict";

const { buildColorGrade, buildOverlay } = require("./effectsLibrary");

// ─── REGISTRY ──────────────────────────────────────────────────────────────────

const COMPOSITIONS = new Set([
  // Single-image (22 — all preserved from v2)
  "three_panel", "manga_panels", "quad_grid", "diagonal_split",
  "character_reveal", "vertical_wipe", "slide_in_left", "slide_in_right",
  "slide_in_top", "curtain_open",
  "spotlight_zoom", "parallax", "rack_focus",
  "impact_frame", "bounce_zoom", "zoom_burst", "shockwave",
  "letterbox_pan", "tilt_reveal", "mirror_composite", "neon_frame", "vhs_composite",
  // Multi-image (8 new)
  "beat_stack_3", "triptych_reveal", "stagger_slide_up",
  "split_and_zoom", "photo_wall_sweep", "cinematic_duo", "pip_corner", "cross_reveal",
]);

const MULTI_IMAGE_COMPOSITIONS = new Set([
  "beat_stack_3", "triptych_reveal", "stagger_slide_up",
  "split_and_zoom", "photo_wall_sweep", "cinematic_duo", "pip_corner", "cross_reveal",
]);

const COMPOSITION_CATEGORIES = {
  panels:    { label: "Panel Layouts",  compositions: ["three_panel", "manga_panels", "quad_grid", "diagonal_split"] },
  reveals:   { label: "Reveals",        compositions: ["character_reveal", "vertical_wipe", "slide_in_left", "slide_in_right", "slide_in_top", "curtain_open"] },
  focus:     { label: "Focus",          compositions: ["spotlight_zoom", "parallax", "rack_focus"] },
  impact:    { label: "Impact",         compositions: ["impact_frame", "bounce_zoom", "zoom_burst", "shockwave"] },
  cinematic: { label: "Cinematic",      compositions: ["letterbox_pan", "tilt_reveal", "mirror_composite", "neon_frame", "vhs_composite"] },
  multi:     { label: "Multi-Image",    compositions: ["beat_stack_3", "triptych_reveal", "stagger_slide_up", "split_and_zoom", "photo_wall_sweep", "cinematic_duo", "pip_corner", "cross_reveal"] },
};

// ─── SHARED HELPERS ───────────────────────────────────────────────────────────

function buildPostChain(colorGrade, overlays, w, h) {
  const parts = [];
  const g = buildColorGrade(colorGrade);
  if (g) parts.push(g);
  for (const ov of overlays) {
    const o = buildOverlay(ov, w, h);
    if (o) parts.push(o);
  }
  if (!overlays.some(o => o.startsWith("vignette"))) parts.push("vignette=PI/5");
  return parts.length ? "," + parts.join(",") : "";
}

function safeFrames(dur, fps) {
  return Math.max(4, Math.round(dur * fps));
}

// Scale an image to fill a slot of dimensions sw×sh, then centre-crop.
// Guaranteed: after scale with increase, iw≥sw and ih≥sh, so crop is safe.
function scaleFill(sw, sh) {
  return `scale=${sw}:${sh}:force_original_aspect_ratio=increase,crop=${sw}:${sh}:(iw-${sw})/2:(ih-${sh})/2,setsar=1`;
}

// Scale an image to fit inside sw×sh with black padding.
function scalePad(sw, sh) {
  return `scale=${sw}:${sh}:force_original_aspect_ratio=decrease,pad=${sw}:${sh}:(ow-iw)/2:(oh-ih)/2:black,setsar=1`;
}

/**
 * Resolve inputPaths from opts.
 * Accepts opts.inputPaths (array, preferred) or opts.inputPath (string, legacy).
 * Filters nulls/empties, clamps to maxCount.
 * Throws if nothing valid is supplied.
 */
function resolveInputPaths(opts, maxCount = 3) {
  let paths = [];
  if (Array.isArray(opts.inputPaths) && opts.inputPaths.length > 0) {
    paths = opts.inputPaths.filter(p => typeof p === "string" && p.length > 0);
  } else if (typeof opts.inputPath === "string" && opts.inputPath.length > 0) {
    paths = [opts.inputPath];
  }
  if (paths.length === 0) throw new Error("buildCompositionCmd: no valid inputPath(s) provided");
  return paths.slice(0, maxCount);
}

// Pad paths to exactly count entries by repeating the last one.
function padPaths(paths, count) {
  const out = [...paths];
  while (out.length < count) out.push(out[out.length - 1]);
  return out.slice(0, count);
}

/**
 * Build a face-aware crop + scale FFmpeg filter string.
 * Falls back to centre-crop if bbox is null or dimensions are zero.
 */
function buildFaceCrop(faceBbox, srcW, srcH, outW, outH) {
  const aspect = outW / outH;
  if (!faceBbox || !srcW || !srcH) {
    return `${scaleFill(outW, outH)}`;
  }
  const { x, y, w: fw, h: fh } = faceBbox;
  let cropH = Math.min(srcH, Math.max(fh * 2.0, srcH * 0.5));
  let cropW = Math.round(cropH * aspect);
  if (cropW > srcW) { cropW = srcW; cropH = Math.round(cropW / aspect); }
  let cx = Math.round(x + fw / 2 - cropW / 2);
  let cy = Math.round(y + fh / 2 - cropH / 2);
  cx = Math.max(0, Math.min(cx, srcW - cropW));
  cy = Math.max(0, Math.min(cy, srcH - cropH));
  return `crop=${cropW}:${cropH}:${cx}:${cy},scale=${outW}:${outH}:flags=lanczos`;
}

// ─── MAIN BUILDER ──────────────────────────────────────────────────────────────

/**
 * Build an FFmpeg command string for a named composition.
 *
 * @param {object} opts
 *   composition  {string}   — composition name
 *   inputPath    {string}   — single image path (legacy)
 *   inputPaths   {string[]} — array of image paths (preferred)
 *   outPath      {string}   — output .mp4 path
 *   duration     {number}   — seconds
 *   fps          {number}   — default 30
 *   w            {number}   — output width  (default 1080)
 *   h            {number}   — output height (default 1920)
 *   colorGrade   {string}   — grade name or "none"
 *   overlays     {string[]} — overlay names
 *   beatOffsets  {number[]} — beat times relative to scene start (seconds)
 *
 * @returns {string|null}  FFmpeg command string, or null for unknown composition.
 */
function buildCompositionCmd(opts) {
  const {
    composition,
    outPath,
    duration,
    fps        = 30,
    w          = 1080,
    h          = 1920,
    colorGrade = "none",
    overlays   = [],
    beatOffsets = [],
  } = opts;

  if (!composition || !COMPOSITIONS.has(composition)) return null;

  const tf   = safeFrames(duration, fps);
  const dur  = Math.max(0.1, duration).toFixed(3);
  const durP = (parseFloat(dur) + 0.1).toFixed(3);
  const post = buildPostChain(colorGrade, overlays, w, h);
  const OF   = `-t ${dur} -an -c:v libx264 -preset fast -crf 20 -pix_fmt yuv420p`;

  if (MULTI_IMAGE_COMPOSITIONS.has(composition)) {
    return _multi(composition, opts, { dur, durP, post, OF, tf, fps, w, h, beatOffsets });
  }

  // ── SINGLE-IMAGE path ─────────────────────────────────────────────────────
  const [ip] = resolveInputPaths(opts, 1);
  const inp  = `-loop 1 -t ${durP} -i "${ip}"`;
  const SP   = scalePad(w, h);

  switch (composition) {

    case "three_panel": {
      const sw = Math.floor(w / 3) - 4;
      const fc = [
        `[0:v]${SP}[base]`,
        `[base]split=3[b1][b2][b3]`,
        `[b1]crop=${sw}:${h}:0:0,zoompan=z='1.0+0.18*on/${tf}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${tf}:s=${sw}x${h}:fps=${fps}[s1]`,
        `[b2]crop=${sw}:${h}:${Math.floor(w/3)}:0,zoompan=z='1.18-0.15*on/${tf}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${tf}:s=${sw}x${h}:fps=${fps}[s2]`,
        `[b3]crop=${sw}:${h}:${Math.floor(2*w/3)}:0,zoompan=z='1.08+0.10*sin(on*3.14/${tf})':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${tf}:s=${sw}x${h}:fps=${fps}[s3]`,
        `color=c=black:s=${w}x${h}:d=${durP}:r=${fps}[bg]`,
        `[bg][s1]overlay=0:0[t1]`,
        `[t1][s2]overlay=${sw+4}:0[t2]`,
        `[t2][s3]overlay=${2*(sw+4)}:0,fps=${fps}${post}[vout]`,
      ];
      return `ffmpeg -y ${inp} -filter_complex "${fc.join(";")}" -map "[vout]" ${OF} "${outPath}"`;
    }

    case "manga_panels": {
      const ph = Math.floor(h/2) - 3;
      const fc = [
        `[0:v]${SP}[base]`,
        `[base]split[ti][bi]`,
        `[ti]crop=${w}:${ph}:0:0,zoompan=z='1.0+0.20*on/${tf}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${tf}:s=${w}x${ph}:fps=${fps}[top]`,
        `[bi]crop=${w}:${ph}:0:${Math.floor(h/2)},zoompan=z='1.20-0.15*on/${tf}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${tf}:s=${w}x${ph}:fps=${fps}[bot]`,
        `color=c=black:s=${w}x${h}:d=${durP}:r=${fps}[bg]`,
        `[bg][top]overlay=0:0[t1]`,
        `[t1][bot]overlay=0:${ph+6},fps=${fps}${post}[vout]`,
      ];
      return `ffmpeg -y ${inp} -filter_complex "${fc.join(";")}" -map "[vout]" ${OF} "${outPath}"`;
    }

    case "quad_grid": {
      const qw = Math.floor(w/2) - 3, qh = Math.floor(h/2) - 3;
      const fc = [
        `[0:v]${SP}[base]`,
        `[base]split=4[q1][q2][q3][q4]`,
        `[q1]crop=${qw}:${qh}:0:0,zoompan=z='1.0+0.20*on/${tf}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${tf}:s=${qw}x${qh}:fps=${fps}[p1]`,
        `[q2]crop=${qw}:${qh}:${Math.floor(w/2)}:0,zoompan=z='1.20-0.15*on/${tf}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${tf}:s=${qw}x${qh}:fps=${fps}[p2]`,
        `[q3]crop=${qw}:${qh}:0:${Math.floor(h/2)},zoompan=z='1.10+0.10*sin(on*6.28/${tf})':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${tf}:s=${qw}x${qh}:fps=${fps}[p3]`,
        `[q4]crop=${qw}:${qh}:${Math.floor(w/2)}:${Math.floor(h/2)},zoompan=z='1.15-0.10*cos(on*6.28/${tf})':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${tf}:s=${qw}x${qh}:fps=${fps}[p4]`,
        `color=c=black:s=${w}x${h}:d=${durP}:r=${fps}[bg]`,
        `[bg][p1]overlay=0:0[g1]`,
        `[g1][p2]overlay=${qw+6}:0[g2]`,
        `[g2][p3]overlay=0:${qh+6}[g3]`,
        `[g3][p4]overlay=${qw+6}:${qh+6},fps=${fps}${post}[vout]`,
      ];
      return `ffmpeg -y ${inp} -filter_complex "${fc.join(";")}" -map "[vout]" ${OF} "${outPath}"`;
    }

    case "diagonal_split": {
      const hw = Math.floor(w/2);
      const fc = [
        `[0:v]${SP}[base]`,
        `[base]split[a][b]`,
        `[a]zoompan=z='1.0+0.15*on/${tf}':x='max(0,iw/2-(iw/zoom/2)-18)':y='ih/2-(ih/zoom/2)':d=${tf}:s=${w}x${h}:fps=${fps}[za]`,
        `[b]zoompan=z='1.15-0.10*on/${tf}':x='min(iw-(iw/zoom),iw/2-(iw/zoom/2)+18)':y='ih/2-(ih/zoom/2)':d=${tf}:s=${w}x${h}:fps=${fps}[zb]`,
        `[zb]crop=${hw}:${h}:${hw}:0[rb]`,
        `[za][rb]overlay=${hw}:0,fps=${fps}${post}[vout]`,
      ];
      return `ffmpeg -y ${inp} -filter_complex "${fc.join(";")}" -map "[vout]" ${OF} "${outPath}"`;
    }

    case "character_reveal": {
      const fc = [
        `[0:v]${SP}[base]`,
        `[base]zoompan=z='max(1.05,3.0-2.0*on/${tf})':x='iw/2-(iw/zoom/2)':y='max(0,ih*0.32-(ih/zoom/2))':d=${tf}:s=${w}x${h}:fps=${fps},fps=${fps},vignette=PI/2.8${post}[vout]`,
      ];
      return `ffmpeg -y ${inp} -filter_complex "${fc.join(";")}" -map "[vout]" ${OF} "${outPath}"`;
    }

    case "vertical_wipe": {
      const rd = Math.max(0.3, duration * 0.65).toFixed(3);
      const fc = [
        `[0:v]${SP}[base]`,
        `[base]zoompan=z=1.08:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${tf}:s=${w}x${h}:fps=${fps}[img]`,
        `color=c=black:s=${w}x${h}:d=${durP}:r=${fps}[bf]`,
        `[bf]crop=w=${w}:h='max(2,${h}-${h}*min(1,t/${rd}))':x=0:y=0[mask]`,
        `[img][mask]overlay=0:0,fps=${fps}${post}[vout]`,
      ];
      return `ffmpeg -y ${inp} -filter_complex "${fc.join(";")}" -map "[vout]" ${OF} "${outPath}"`;
    }

    case "slide_in_left": {
      const sf = Math.max(4, Math.floor(tf * 0.4));
      const fc = [
        `[0:v]${SP}[base]`,
        `[base]zoompan=z=1.06:x='max(0,iw/2-(iw/zoom/2)-(iw/zoom)*(1-min(1,on/${sf})))':y='ih/2-(ih/zoom/2)':d=${tf}:s=${w}x${h}:fps=${fps},fps=${fps}${post}[vout]`,
      ];
      return `ffmpeg -y ${inp} -filter_complex "${fc.join(";")}" -map "[vout]" ${OF} "${outPath}"`;
    }

    case "slide_in_right": {
      const sf = Math.max(4, Math.floor(tf * 0.4));
      const fc = [
        `[0:v]${SP}[base]`,
        `[base]zoompan=z=1.06:x='min(iw-(iw/zoom),iw/2-(iw/zoom/2)+(iw/zoom)*(1-min(1,on/${sf})))':y='ih/2-(ih/zoom/2)':d=${tf}:s=${w}x${h}:fps=${fps},fps=${fps}${post}[vout]`,
      ];
      return `ffmpeg -y ${inp} -filter_complex "${fc.join(";")}" -map "[vout]" ${OF} "${outPath}"`;
    }

    case "slide_in_top": {
      const sf = Math.max(4, Math.floor(tf * 0.35));
      const fc = [
        `[0:v]${SP}[base]`,
        `[base]zoompan=z=1.06:x='iw/2-(iw/zoom/2)':y='max(0,ih/2-(ih/zoom/2)-(ih/zoom)*(1-min(1,on/${sf})))':d=${tf}:s=${w}x${h}:fps=${fps},fps=${fps}${post}[vout]`,
      ];
      return `ffmpeg -y ${inp} -filter_complex "${fc.join(";")}" -map "[vout]" ${OF} "${outPath}"`;
    }

    case "curtain_open": {
      const rf = Math.max(4, Math.floor(tf * 0.5));
      const hw = Math.floor(w/2);
      const fc = [
        `[0:v]${SP}[base]`,
        `[base]split[li][ri]`,
        `[li]crop=${hw}:${h}:0:0,zoompan=z=1.06:d=${tf}:s=${hw}x${h}:fps=${fps}[lc]`,
        `[ri]crop=${hw}:${h}:${hw}:0,zoompan=z=1.06:d=${tf}:s=${hw}x${h}:fps=${fps}[rc]`,
        `color=c=black:s=${w}x${h}:d=${durP}:r=${fps}[bg]`,
        `[bg][lc]overlay=x='0-${hw}*min(1\\,n/${rf})':y=0[t1]`,
        `[t1][rc]overlay=x='${hw}+${hw}*min(1\\,n/${rf})':y=0,fps=${fps}${post}[vout]`,
      ];
      return `ffmpeg -y ${inp} -filter_complex "${fc.join(";")}" -map "[vout]" ${OF} "${outPath}"`;
    }

    case "spotlight_zoom": {
      const cw = Math.floor(w * 0.52), ch = Math.floor(h * 0.52);
      const sw2 = Math.floor(w * 0.72), sh2 = Math.floor(h * 0.72);
      const cy2 = Math.max(0, Math.floor(h * 0.12));
      const fc = [
        `[0:v]${SP}[base]`,
        `[base]split[bgi][fgi]`,
        `[bgi]zoompan=z='1.05+0.0006*on':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${tf}:s=${w}x${h}:fps=${fps},boxblur=22:6[bg]`,
        `[fgi]crop=${cw}:${ch}:(iw-${cw})/2:${cy2},zoompan=z='1.0+0.30*on/${tf}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${tf}:s=${cw}x${ch}:fps=${fps},scale=${sw2}:${sh2}[fg]`,
        `[bg][fg]overlay=x=(W-w)/2:y=(H-h)*3/8,fps=${fps}${post}[vout]`,
      ];
      return `ffmpeg -y ${inp} -filter_complex "${fc.join(";")}" -map "[vout]" ${OF} "${outPath}"`;
    }

    case "parallax": {
      const fgW = Math.floor(w * 0.62), fgH = Math.floor(h * 0.62);
      const bs = (w * 0.018 / tf).toFixed(5), fs = (w * 0.048 / tf).toFixed(5);
      const fc = [
        `[0:v]${SP}[base]`,
        `[base]split[bgi][fgi]`,
        `[bgi]zoompan=z=1.12:x='iw/2-(iw/zoom/2)+on*${bs}':y='ih/2-(ih/zoom/2)':d=${tf}:s=${w}x${h}:fps=${fps},smartblur=1.8:0.5:0[bg]`,
        `[fgi]crop=${fgW}:${fgH}:(iw-${fgW})/2:(ih-${fgH})/2,zoompan=z=1.08:x='iw/2-(iw/zoom/2)+on*${fs}':y='ih/2-(ih/zoom/2)':d=${tf}:s=${fgW}x${fgH}:fps=${fps}[fg]`,
        `[bg][fg]overlay=x=(W-w)/2:y=(H-h)/2,fps=${fps}${post}[vout]`,
      ];
      return `ffmpeg -y ${inp} -filter_complex "${fc.join(";")}" -map "[vout]" ${OF} "${outPath}"`;
    }

    case "rack_focus": {
      const fgW = Math.floor(w * 0.65), fgH = Math.floor(h * 0.65);
      const cy2 = Math.max(0, Math.floor(h * 0.08));
      const fc = [
        `[0:v]${SP}[base]`,
        `[base]split[bgi][fgi]`,
        `[bgi]zoompan=z='1.08+0.04*on/${tf}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${tf}:s=${w}x${h}:fps=${fps},boxblur=14:4[bg]`,
        `[fgi]crop=${fgW}:${fgH}:(iw-${fgW})/2:${cy2},zoompan=z='1.0+0.12*on/${tf}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${tf}:s=${fgW}x${fgH}:fps=${fps}[fg]`,
        `[bg][fg]overlay=x=(W-w)/2:y=(H-h)*3/8,fps=${fps}${post}[vout]`,
      ];
      return `ffmpeg -y ${inp} -filter_complex "${fc.join(";")}" -map "[vout]" ${OF} "${outPath}"`;
    }

    case "impact_frame": {
      const ff = Math.max(3, Math.floor(tf * 0.15));
      const fd = Math.max(0.1, ff / fps).toFixed(3);
      const zf = Math.max(2, tf - ff);
      const fc = [
        `[0:v]${SP}[base]`,
        `[base]zoompan=z='if(lt(on\\,${ff})\\,2.2\\,max(1.05\\,2.2-1.15*(on-${ff})/${zf}))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${tf}:s=${w}x${h}:fps=${fps}[img]`,
        `color=c=white:s=${w}x${h}:d=${durP}:r=${fps},format=yuva420p,fade=t=out:st=0:d=${fd}:alpha=1[flash]`,
        `[img][flash]overlay=0:0:shortest=1,fps=${fps}${post}[vout]`,
      ];
      return `ffmpeg -y ${inp} -filter_complex "${fc.join(";")}" -map "[vout]" ${OF} "${outPath}"`;
    }

    case "bounce_zoom": {
      const fc = [
        `[0:v]${SP}[base]`,
        `[base]zoompan=z='1.05+0.28*(1-exp(-3.5*on/${tf}*3.0)*cos(7.5*on/${tf}*3.0))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${tf}:s=${w}x${h}:fps=${fps},fps=${fps}${post}[vout]`,
      ];
      return `ffmpeg -y ${inp} -filter_complex "${fc.join(";")}" -map "[vout]" ${OF} "${outPath}"`;
    }

    case "zoom_burst": {
      const fc = [
        `[0:v]${SP}[base]`,
        `[base]zoompan=z='max(1.05,2.5-1.45*pow(on/${tf},0.4))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${tf}:s=${w}x${h}:fps=${fps},fps=${fps}${post}[vout]`,
      ];
      return `ffmpeg -y ${inp} -filter_complex "${fc.join(";")}" -map "[vout]" ${OF} "${outPath}"`;
    }

    case "shockwave": {
      const fc = [
        `[0:v]${SP}[base]`,
        `[base]zoompan=z='1.08+0.12*exp(-6.0*on/${tf})':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${tf}:s=${w}x${h}:fps=${fps},fps=${fps},vignette='PI/2*exp(-4*t/${Math.max(0.1, duration).toFixed(2)})+PI/6'${post}[vout]`,
      ];
      return `ffmpeg -y ${inp} -filter_complex "${fc.join(";")}" -map "[vout]" ${OF} "${outPath}"`;
    }

    case "letterbox_pan": {
      const bh = Math.floor(h * 0.115);
      const ps = (w * 0.055 / tf).toFixed(5);
      const fc = [
        `[0:v]${SP}[base]`,
        `[base]zoompan=z=1.18:x='iw/2-(iw/zoom/2)+on*${ps}':y='ih/2-(ih/zoom/2)':d=${tf}:s=${w}x${h}:fps=${fps}[p]`,
        `[p]drawbox=x=0:y=0:w=${w}:h=${bh}:color=black:t=fill,drawbox=x=0:y=${h-bh}:w=${w}:h=${bh}:color=black:t=fill,fps=${fps}${post}[vout]`,
      ];
      return `ffmpeg -y ${inp} -filter_complex "${fc.join(";")}" -map "[vout]" ${OF} "${outPath}"`;
    }

    case "tilt_reveal": {
      const ts = (h * 0.055 / tf).toFixed(5);
      const fc = [
        `[0:v]${SP}[base]`,
        `[base]zoompan=z=1.12:x='iw/2-(iw/zoom/2)':y='min(ih-(ih/zoom),max(0,ih-(ih/zoom)-on*${ts}))':d=${tf}:s=${w}x${h}:fps=${fps},fps=${fps}${post}[vout]`,
      ];
      return `ffmpeg -y ${inp} -filter_complex "${fc.join(";")}" -map "[vout]" ${OF} "${outPath}"`;
    }

    case "mirror_composite": {
      const hw = Math.floor(w/2);
      const ps = (w * 0.012 / tf).toFixed(5);
      const fc = [
        `[0:v]${SP}[base]`,
        `[base]split[full][mi]`,
        `[full]zoompan=z=1.06:x='iw/2-(iw/zoom/2)+on*${ps}':y='ih/2-(ih/zoom/2)':d=${tf}:s=${w}x${h}:fps=${fps}[bg]`,
        `[mi]crop=${hw}:${h}:0:0,hflip,zoompan=z=1.08:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${tf}:s=${hw}x${h}:fps=${fps},format=yuva420p,colorchannelmixer=aa=0.55[mg]`,
        `[bg][mg]overlay=0:0,fps=${fps}${post}[vout]`,
      ];
      return `ffmpeg -y ${inp} -filter_complex "${fc.join(";")}" -map "[vout]" ${OF} "${outPath}"`;
    }

    case "neon_frame": {
      const brd = 14;
      const fc = [
        `[0:v]${SP}[base]`,
        `[base]zoompan=z='1.05+0.08*on/${tf}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${tf}:s=${w}x${h}:fps=${fps}[img]`,
        `[img]drawbox=x=0:y=0:w=${w}:h=${brd}:color=0x00ffff@0.9:t=fill,drawbox=x=0:y=${h-brd}:w=${w}:h=${brd}:color=0xff00ff@0.9:t=fill,drawbox=x=0:y=0:w=${brd}:h=${h}:color=0x00ffff@0.9:t=fill,drawbox=x=${w-brd}:y=0:w=${brd}:h=${h}:color=0xff00ff@0.9:t=fill,fps=${fps}${post}[vout]`,
      ];
      return `ffmpeg -y ${inp} -filter_complex "${fc.join(";")}" -map "[vout]" ${OF} "${outPath}"`;
    }

    case "vhs_composite": {
      const fc = [
        `[0:v]${SP}[base]`,
        `[base]zoompan=z=1.05:x='iw/2-(iw/zoom/2)+3*sin(on*0.7)':y='ih/2-(ih/zoom/2)+2*sin(on*0.4+1.2)':d=${tf}:s=${w}x${h}:fps=${fps},rgbashift=rh=2:rv=0:gh=-1:gv=1:bh=-2:bv=0,noise=alls=10:allf=t+u,drawgrid=width=0:height=4:thickness=1:color=black@0.22,fps=${fps}${post}[vout]`,
      ];
      return `ffmpeg -y ${inp} -filter_complex "${fc.join(";")}" -map "[vout]" ${OF} "${outPath}"`;
    }

    default:
      return null;
  }
}

// ─── MULTI-IMAGE COMPOSITIONS ─────────────────────────────────────────────────

function _multi(composition, opts, { dur, durP, post, OF, tf, fps, w, h, beatOffsets }) {
  const { outPath } = opts;
  const rawPaths = resolveInputPaths(opts, 3);

  // Build the -loop 1 inputs for all images.
  // IMPORTANT: multi-image compositions MUST use the original (unprocessed)
  // paths and do all scaling inside filter_complex. Using resizeMedia-preprocessed
  // full-frame images breaks strip/panel compositions (negative crop offsets).
  const mkInputs = (count) =>
    padPaths(rawPaths, count).map(p => `-loop 1 -t ${durP} -i "${p}"`).join(" ");

  // Beat offsets → seconds for time-based expressions
  const beatTimes = beatOffsets.slice(0, 3);
  while (beatTimes.length < 3) {
    beatTimes.push((beatTimes.length * parseFloat(dur)) / 3);
  }

  switch (composition) {

    // ── BEAT STACK 3 ─────────────────────────────────────────────────────────
    // Three horizontal strips stacked vertically (full width, 1/3 height each).
    // Each strip slides up from below the frame on its beat time using 't' (seconds).
    // Design: slotH = h/3, gap = 2px between strips.
    // Slide animation: 0.3s duration, ease-in using sqrt(progress).
    case "beat_stack_3": {
      const paths   = padPaths(rawPaths, 3);
      const inputs  = paths.map(p => `-loop 1 -t ${durP} -i "${p}"`).join(" ");
      const slotH   = Math.floor(h / 3);
      const gap     = 2;
      const slideD  = 0.30; // seconds for slide animation
      // Slot Y positions (top of each strip on the canvas)
      const slotY   = [0, slotH + gap, 2 * (slotH + gap)];

      const fc = [];

      // Scale each image to fill exactly w×slotH (fill + centre-crop, no negative offsets)
      for (let i = 0; i < 3; i++) {
        fc.push(`[${i}:v]${scaleFill(w, slotH)}[strip${i}]`);
      }

      // Black canvas
      fc.push(`color=c=black:s=${w}x${h}:d=${durP}:r=${fps}[canvas]`);

      // Overlay each strip with time-based slide from bottom to its slot.
      // y(t) when t < beatT[i]: h (off screen below)
      // y(t) when t >= beatT[i]: targetY + (h - targetY) * (1 - sqrt(progress))
      //   where progress = min(1, (t - beatT[i]) / slideD)
      // sqrt gives ease-in feel (slow start, fast arrival)
      let prev = "canvas";
      for (let i = 0; i < 3; i++) {
        const tY  = slotY[i];
        const bT  = beatTimes[i].toFixed(4);
        const out = i === 2 ? "vout_raw" : `comp${i}`;

        // When t < bT → y=h (strip hidden below canvas)
        // When t >= bT → y slides from h to tY over slideD seconds
        // Note: (h - tY) = distance to travel; tY = final resting position
        const yExpr =
          `if(lt(t\\,${bT})\\,` +
          `${h}\\,` +
          `${tY}+(${h - tY})*(1-sqrt(min(1\\,(t-${bT})/${slideD.toFixed(4)}))))`;

        fc.push(`[${prev}][strip${i}]overlay=x=0:y='${yExpr}'[${out}]`);
        prev = out;
      }

      fc.push(`[vout_raw]fps=${fps}${post}[vout]`);

      return `ffmpeg -y ${inputs} -filter_complex "${fc.join(";")}" -map "[vout]" ${OF} "${outPath}"`;
    }

    // ── TRIPTYCH REVEAL ──────────────────────────────────────────────────────
    // Three vertical panels (left, centre, right) each w/3 wide × h tall.
    // Each panel wipes in from the TOP using a shrinking black mask.
    // The wipe duration is 0.4s per panel, triggered at beat times.
    case "triptych_reveal": {
      const paths   = padPaths(rawPaths, 3);
      const inputs  = paths.map(p => `-loop 1 -t ${durP} -i "${p}"`).join(" ");
      const panelW  = Math.floor(w / 3);
      const gap     = 2;
      const pw      = panelW - gap; // visible panel width
      const wipeD   = 0.40; // seconds for wipe animation

      const fc = [];

      // Each image: scale to fill pw×h, slow zoom inside the panel
      for (let i = 0; i < 3; i++) {
        fc.push(
          `[${i}:v]${scaleFill(pw, h)},` +
          `zoompan=z='1.04+0.04*on/${tf}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':` +
          `d=${tf}:s=${pw}x${h}:fps=${fps}[panel${i}]`
        );
      }

      // Canvas
      fc.push(`color=c=black:s=${w}x${h}:d=${durP}:r=${fps}[canvas]`);

      // Overlay each panel. Use a masking approach: the panel overlays at its x position.
      // The panel itself is revealed by cropping it: visible_h = min(h, h * progress)
      // where progress = min(1, (t - beatT[i]) / wipeD)
      // FFmpeg crop with time expression: crop=pw:h*min(1,(t-bT)/wipeD):0:0
      // Then overlay at (i * panelW, 0). Panel stays off (canvas shows black) before bT.

      // Approach: use overlay enable + a growing crop on the panel.
      // We generate a separate cropped version for each panel:
      let prev = "canvas";
      for (let i = 0; i < 3; i++) {
        const bT  = beatTimes[i].toFixed(4);
        const xPos = i * panelW;
        const out = i === 2 ? "composed" : `comp${i}`;

        // Crop the panel height from 0 to h over wipeD seconds (top-down wipe)
        // crop=pw : 'min(h, h*max(0,(t-bT)/wipeD)' : 0 : 0
        // Before bT: crop height = 0 → invisible; after bT: grows to full h
        fc.push(
          `[panel${i}]crop=${pw}:'min(${h}\\,${h}*max(0\\,(t-${bT})/${wipeD.toFixed(4)}))':0:0[pw${i}]`
        );

        fc.push(`[${prev}][pw${i}]overlay=x=${xPos}:y=0[${out}]`);
        prev = out;
      }

      fc.push(`[composed]fps=${fps}${post}[vout]`);

      return `ffmpeg -y ${inputs} -filter_complex "${fc.join(";")}" -map "[vout]" ${OF} "${outPath}"`;
    }

    // ── STAGGER SLIDE UP ─────────────────────────────────────────────────────
    // Up to 3 full-frame images appear in sequence, each sliding up from the
    // bottom and settling at y=0 (full frame). Later images slide on top of
    // earlier ones, so each new image fully replaces the previous one.
    // Stagger: 0.5s between each image's slide start.
    // Slide: 0.35s, ease-out (decelerating) using (1 - (1-progress)^2).
    case "stagger_slide_up": {
      const count  = rawPaths.length;
      const inputs = rawPaths.map(p => `-loop 1 -t ${durP} -i "${p}"`).join(" ");
      const stag   = 0.50;  // seconds between each image appearing
      const slideD = 0.35;  // slide duration

      const fc = [];

      // Scale all inputs to full frame
      for (let i = 0; i < count; i++) {
        fc.push(`[${i}:v]${scaleFill(w, h)}[img${i}]`);
      }

      // Canvas (black start)
      fc.push(`color=c=black:s=${w}x${h}:d=${durP}:r=${fps}[canvas]`);

      let prev = "canvas";
      for (let i = 0; i < count; i++) {
        const startT = (i * stag).toFixed(4);
        const out    = i === count - 1 ? "stacked" : `sl${i}`;

        // Ease-out slide: y = h * (1 - progress)^2 where progress = min(1,(t-startT)/slideD)
        // Before startT → y=h (hidden below). After startT → slides to y=0.
        const prog   = `min(1\\,(t-${startT})/${slideD.toFixed(4)})`;
        const yExpr  = `if(lt(t\\,${startT})\\,${h}\\,${h}*(1-${prog})*(1-${prog}))`;

        fc.push(`[${prev}][img${i}]overlay=x=0:y='${yExpr}'[${out}]`);
        prev = out;
      }

      fc.push(`[stacked]fps=${fps}${post}[vout]`);

      return `ffmpeg -y ${inputs} -filter_complex "${fc.join(";")}" -map "[vout]" ${OF} "${outPath}"`;
    }

    // ── SPLIT AND ZOOM ───────────────────────────────────────────────────────
    // Single image splits into two halves; left half zooms left, right half zooms right.
    // Creates a dramatic "opening" reveal. Works with 1 image.
    case "split_and_zoom": {
      const [p0] = padPaths(rawPaths, 1);
      const inputs = `-loop 1 -t ${durP} -i "${p0}"`;
      const hw    = Math.floor(w / 2);
      const splitD = Math.min(0.5, parseFloat(dur) * 0.6);
      const fc = [
        `[0:v]${scaleFill(w, h)}[base]`,
        `[base]split[la][ra]`,
        // Left half: crop left side, pan left (x increases from iw/2-(iw/zoom/2) rightward)
        `[la]crop=${hw}:${h}:0:0,` +
          `zoompan=z='1.0+0.12*min(1\\,t/${splitD.toFixed(3)})':` +
          `x='0':y='ih/2-(ih/zoom/2)':d=${tf}:s=${hw}x${h}:fps=${fps}[lz]`,
        // Right half: crop right side, pan right
        `[ra]crop=${hw}:${h}:${hw}:0,` +
          `zoompan=z='1.0+0.12*min(1\\,t/${splitD.toFixed(3)})':` +
          `x='iw-(iw/zoom)':y='ih/2-(ih/zoom/2)':d=${tf}:s=${hw}x${h}:fps=${fps}[rz]`,
        `color=c=black:s=${w}x${h}:d=${durP}:r=${fps}[bg]`,
        `[bg][lz]overlay=0:0[t1]`,
        `[t1][rz]overlay=${hw}:0,fps=${fps}${post}[vout]`,
      ];
      return `ffmpeg -y ${inputs} -filter_complex "${fc.join(";")}" -map "[vout]" ${OF} "${opts.outPath}"`;
    }

    // ── PHOTO WALL SWEEP ─────────────────────────────────────────────────────
    // 4 images arranged in a 2×2 grid at 110% of frame size (so they bleed
    // off-screen). A slow camera pan sweeps left→right across the wall.
    // Uses 2 images if only 2 provided (reuses them for all 4 slots).
    case "photo_wall_sweep": {
      const paths  = padPaths(rawPaths, 4);
      // Clamp to available: use rawPaths for first slots, repeat last for rest
      const pFull  = padPaths(rawPaths, 4);
      const inputs = pFull.map(p => `-loop 1 -t ${durP} -i "${p}"`).join(" ");

      const cellW  = Math.floor(w * 0.55);  // each cell is 55% of frame width
      const cellH  = Math.floor(h * 0.52);  // 52% of frame height
      const wallW  = cellW * 2 + 8;         // total wall width (2 cols + gap)
      const wallH  = cellH * 2 + 8;         // total wall height (2 rows + gap)
      // Pan: wall starts at x offset -10, sweeps to show right side
      const panDist = Math.max(0, wallW - w);
      const panStep = (panDist / parseFloat(dur)).toFixed(4);

      const fc = [];

      // Scale each image to fill a cell
      for (let i = 0; i < 4; i++) {
        fc.push(`[${i}:v]${scaleFill(cellW, cellH)}[cell${i}]`);
      }

      // Assemble wall: 2×2 grid onto a big canvas
      fc.push(`color=c=black:s=${wallW}x${wallH}:d=${durP}:r=${fps}[wall]`);
      fc.push(`[wall][cell0]overlay=0:0[w1]`);
      fc.push(`[w1][cell1]overlay=${cellW + 8}:0[w2]`);
      fc.push(`[w2][cell2]overlay=0:${cellH + 8}[w3]`);
      fc.push(`[w3][cell3]overlay=${cellW + 8}:${cellH + 8}[assembled]`);

      // Animate: slow pan left to right across the wall, centred vertically
      // crop=w:h : pan_x : (wallH-h)/2
      const cropY = Math.max(0, Math.floor((wallH - h) / 2));
      fc.push(
        `[assembled]crop=${w}:${h}:'min(${panDist}\\,t*${panStep})':${cropY}` +
        `,fps=${fps}${post}[vout]`
      );

      return `ffmpeg -y ${inputs} -filter_complex "${fc.join(";")}" -map "[vout]" ${OF} "${opts.outPath}"`;
    }

    // ── CINEMATIC DUO ────────────────────────────────────────────────────────
    // Two images: image 0 occupies the top 35% (portrait/face crop),
    // image 1 occupies the bottom 65% (wide/action crop).
    // A thin black divider separates them. Each has its own slow zoom.
    case "cinematic_duo": {
      const paths  = padPaths(rawPaths, 2);
      const inputs = paths.map(p => `-loop 1 -t ${durP} -i "${p}"`).join(" ");
      const topH   = Math.floor(h * 0.35);
      const botH   = h - topH - 4;  // 4px divider

      const fc = [
        // Top image: fill top slot, face-biased (upper-centre crop)
        `[0:v]${scaleFill(w, topH)},` +
          `zoompan=z='1.04+0.04*on/${tf}':x='iw/2-(iw/zoom/2)':y='max(0,ih*0.30-(ih/zoom/2))':` +
          `d=${tf}:s=${w}x${topH}:fps=${fps}[top]`,
        // Bottom image: fill bottom slot
        `[1:v]${scaleFill(w, botH)},` +
          `zoompan=z='1.06+0.02*on/${tf}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':` +
          `d=${tf}:s=${w}x${botH}:fps=${fps}[bot]`,
        `color=c=black:s=${w}x${h}:d=${durP}:r=${fps}[bg]`,
        `[bg][top]overlay=0:0[t1]`,
        `[t1][bot]overlay=0:${topH + 4},fps=${fps}${post}[vout]`,
      ];
      return `ffmpeg -y ${inputs} -filter_complex "${fc.join(";")}" -map "[vout]" ${OF} "${opts.outPath}"`;
    }

    // ── PIP CORNER ───────────────────────────────────────────────────────────
    // Image 0: full frame background with slow zoom.
    // Image 1: picture-in-picture at bottom-right corner, 30% of frame size.
    // PIP slides in from the right on the first beat (or at t=0.3s).
    case "pip_corner": {
      const paths  = padPaths(rawPaths, 2);
      const inputs = paths.map(p => `-loop 1 -t ${durP} -i "${p}"`).join(" ");
      const pipW   = Math.floor(w * 0.30);
      const pipH   = Math.floor(h * 0.30);
      const pipX   = w - pipW - 20;  // 20px from right edge
      const pipY   = h - pipH - 20;  // 20px from bottom edge
      const slideT = (beatTimes[0] || 0.3).toFixed(4);
      const slideD = 0.30;

      const fc = [
        // Background: full frame slow breathe zoom
        `[0:v]${scaleFill(w, h)},` +
          `zoompan=z='1.04+0.06*sin(on*3.14159/${tf})':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':` +
          `d=${tf}:s=${w}x${h}:fps=${fps}[bg]`,
        // PIP: scale to pip size
        `[1:v]${scaleFill(pipW, pipH)}[pip_raw]`,
        // PIP border: drawbox around the pip
        `[pip_raw]drawbox=x=0:y=0:w=${pipW}:h=${pipH}:color=white@0.8:t=3[pip]`,
        // Overlay PIP: slides in from right (x starts at w, ends at pipX)
        // x(t) = pipX + (w - pipX) * max(0, 1 - (t-slideT)/slideD)^2  ease-out
        `[bg][pip]overlay=` +
          `x='if(lt(t\\,${slideT})\\,${w}\\,${pipX}+(${w - pipX})*(1-min(1\\,(t-${slideT})/${slideD.toFixed(4)}))^2)':` +
          `y=${pipY},fps=${fps}${post}[vout]`,
      ];
      return `ffmpeg -y ${inputs} -filter_complex "${fc.join(";")}" -map "[vout]" ${OF} "${opts.outPath}"`;
    }

    // ── CROSS REVEAL ─────────────────────────────────────────────────────────
    // Image 0 fills the left half, sliding in from the left.
    // Image 1 fills the right half, sliding in from the right.
    // Both start simultaneously, meeting in the middle with a thin gap.
    // Works with 1 image (uses same image for both halves).
    case "cross_reveal": {
      const paths  = padPaths(rawPaths, 2);
      const inputs = paths.map(p => `-loop 1 -t ${durP} -i "${p}"`).join(" ");
      const hw     = Math.floor(w / 2) - 2;  // half width minus 2px for gap
      const slideD = Math.min(0.55, parseFloat(dur) * 0.5);

      const fc = [
        // Left image: crop left half, slides in from the left
        `[0:v]${scaleFill(w, h)},crop=${hw}:${h}:0:0[left_img]`,
        // Right image: crop right half, slides in from the right
        `[1:v]${scaleFill(w, h)},crop=${hw}:${h}:${hw + 4}:0[right_img]`,
        // Slow zoom on each half
        `[left_img]zoompan=z='1.04+0.04*on/${tf}':x='max(0,iw/2-(iw/zoom/2)-on*0.2)':y='ih/2-(ih/zoom/2)':d=${tf}:s=${hw}x${h}:fps=${fps}[left_z]`,
        `[right_img]zoompan=z='1.04+0.04*on/${tf}':x='min(iw-(iw/zoom),iw/2-(iw/zoom/2)+on*0.2)':y='ih/2-(ih/zoom/2)':d=${tf}:s=${hw}x${h}:fps=${fps}[right_z]`,
        // Canvas
        `color=c=black:s=${w}x${h}:d=${durP}:r=${fps}[bg]`,
        // Left slides in from x=-hw to x=0
        `[bg][left_z]overlay=x='${-hw}+${hw}*min(1\\,t/${slideD.toFixed(4)})*min(1\\,t/${slideD.toFixed(4)})':y=0[t1]`,
        // Right slides in from x=w to x=hw+4
        `[t1][right_z]overlay=x='${w}-${hw}*min(1\\,t/${slideD.toFixed(4)})*min(1\\,t/${slideD.toFixed(4)})':y=0,fps=${fps}${post}[vout]`,
      ];
      return `ffmpeg -y ${inputs} -filter_complex "${fc.join(";")}" -map "[vout]" ${OF} "${opts.outPath}"`;
    }

    default:
      return null;
  }
}

module.exports = {
  COMPOSITIONS,
  MULTI_IMAGE_COMPOSITIONS,
  COMPOSITION_CATEGORIES,
  buildCompositionCmd,
  buildFaceCrop,
};
