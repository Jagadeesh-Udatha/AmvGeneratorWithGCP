/**
 * Composition Engine v6.0 — Full Professional Rewrite
 *
 * ═══════════════════════════════════════════════════════════════════════
 * ARCHITECTURE PRINCIPLES
 * ═══════════════════════════════════════════════════════════════════════
 *
 * 1. MOTION SYSTEM — two separate tools, never mixed:
 *    zoompan  → ONLY for scale/zoom (Ken Burns, punch-zoom, bounce)
 *               x/y in zoompan = crop-window origin in INPUT space, not screen
 *    overlay  → ALL screen-space translation (swipes, panels, PIP, curtains)
 *               x/y in overlay = position of element on OUTPUT canvas
 *
 * 2. COORDINATE SYSTEM — single source of truth per composition:
 *    Every element is pre-scaled to its final size BEFORE placement.
 *    scaleFill(w,h) produces exactly w×h pixels — no padding, no black bars.
 *    Overlay positions are in OUTPUT canvas coordinates (0,0 = top-left).
 *
 * 3. ANIMATION MATH — standardized easing (same in FFmpeg and timeline editor):
 *    p(t, start, dur) = clamp((t - start) / dur, 0, 1)
 *    easeOutCubic(p)  = 1 - (1-p)^3   → natural deceleration, FCP default
 *    easeInCubic(p)   = p^3            → acceleration (used for exits)
 *    bounce(p)        = 1 - exp(-6p)*cos(12p)  → elastic settle
 *    FFmpeg expression: 1-(1-min(1,(t-S)/D))^3
 *
 * 4. TIMELINE SYNC — every animation is described as:
 *    { startSec, durSec, fromVal, toVal, easing }
 *    The same numbers that produce FFmpeg expressions populate the JS
 *    timeline editor keyframes. No separate logic path.
 *
 * 5. REMOVED (unfixable by design):
 *    manga_panels  — opposite-direction zooms on same split image
 *    split_and_zoom — zoompan on cropped halves destroys coordinate space
 *    stagger_slide_up — replaced by door_open (cleaner reveal mechanic)
 *
 * ═══════════════════════════════════════════════════════════════════════
 * EASING REFERENCE (used in ALL compositions below)
 * ═══════════════════════════════════════════════════════════════════════
 * easeOutCubic:  E(t,S,D) = 1-(1-min(1,max(0,(t-S)/D)))^3
 * easeInCubic:   I(t,S,D) = min(1,max(0,(t-S)/D))^3
 * easeOutBounce: B(t,S,D) = 1-exp(-6*min(1,max(0,(t-S)/D)))*cos(12*min(1,max(0,(t-S)/D)))
 * Linear:        L(t,S,D) = min(1,max(0,(t-S)/D))
 */

"use strict";

const { buildColorGrade, buildOverlay } = require("./effectsLibrary");

// ═══════════════════════════════════════════════════════════════════════════════
// REGISTRY
// ═══════════════════════════════════════════════════════════════════════════════

const COMPOSITIONS = new Set([
  // Reveals / Swipes
  "character_reveal",
  "swipe_in_left", "swipe_in_right", "swipe_in_top", "curtain_open",
  // Focus / Cinematic
  "spotlight_zoom", "neon_frame", "vhs_composite",
  // Impact
  "impact_frame", "bounce_zoom", "zoom_burst", "shockwave",
  // Multi-image
  "beat_stack_3",
  "door_open", "photo_wall_sweep", "pip_corner",
]);

const MULTI_IMAGE_COMPOSITIONS = new Set([
  "beat_stack_3",
  "door_open", "photo_wall_sweep", "pip_corner",
]);

const COMPOSITION_CATEGORIES = {
  reveals:   { label: "Reveals", compositions: ["character_reveal", "swipe_in_left", "swipe_in_right", "swipe_in_top", "curtain_open"] },
  focus:     { label: "Focus",   compositions: ["spotlight_zoom", "neon_frame", "vhs_composite"] },
  impact:    { label: "Impact",  compositions: ["impact_frame", "bounce_zoom", "zoom_burst", "shockwave"] },
  multi:     { label: "Multi",   compositions: ["beat_stack_3", "door_open", "photo_wall_sweep", "pip_corner"] },
};

// ═══════════════════════════════════════════════════════════════════════════════
// SHARED ANIMATION HELPERS
// These produce FFmpeg filter expression strings.
// The SAME numeric values (startSec, durSec, fromVal, toVal) are used in the
// timeline editor JS — no separate logic path.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Normalized progress clamped to [0,1].
 * p(t, S, D) = clamp((t - S) / D, 0, 1)
 * In FFmpeg: min(1,max(0,(t-S)/D))
 */
function p(startSec, durSec) {
  const S = startSec.toFixed(4);
  const D = durSec.toFixed(4);
  return `min(1,max(0,(t-${S})/${D}))`;
}

/**
 * easeOutCubic — natural deceleration. CapCut / FCP default for enters.
 * f(p) = 1 - (1-p)^3
 */
function eoc(startSec, durSec) {
  const prog = p(startSec, durSec);
  return `(1-(1-${prog})*(1-${prog})*(1-${prog}))`;
}

/**
 * easeInCubic — acceleration. Used for exits (element leaving frame).
 * f(p) = p^3
 */
function eic(startSec, durSec) {
  const prog = p(startSec, durSec);
  return `(${prog}*${prog}*${prog})`;
}

/**
 * easeOutBounce — elastic settle. Used for impact/bounce effects.
 * f(p) = 1 - exp(-6p)*cos(12p)
 */
function eob(startSec, durSec) {
  const prog = p(startSec, durSec);
  return `(1-exp(-6*${prog})*cos(12*${prog}))`;
}

/**
 * Lerp — linear interpolation between fromVal and toVal using an easing expr.
 * lerp(from, to, easingExpr) = from + (to - from) * easingExpr
 */
function lerp(from, to, easingExpr) {
  const delta = to - from;
  if (delta === 0) return from.toFixed(3);
  const sign = delta > 0 ? "+" : "-";
  return `(${from.toFixed(3)}${sign}${Math.abs(delta).toFixed(3)}*${easingExpr})`;
}

// ─── ORGANIC VARIATION HELPERS ───────────────────────────────────────────────

/**
 * Deterministic per-scene variation using scene seed.
 * Replaces Math.random() — same input always gives same output (cache-safe).
 * seed: any integer (use sceneIndex or a hash).
 * range: ±range around base.
 */
function seedVariance(base, range, seed) {
  // LCG pseudo-random, deterministic
  const r = ((seed * 1664525 + 1013904223) & 0xffffffff) / 0xffffffff;
  return +(base + (r * 2 - 1) * range).toFixed(4);
}

/**
 * Per-panel stagger offset in seconds.
 * Used to give multi-panel animations a subtle cascade feel.
 */
function staggerSec(i, gapSec = 0.05) {
  return +(i * gapSec).toFixed(4);
}

// ═══════════════════════════════════════════════════════════════════════════════
// INFRASTRUCTURE HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

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

/**
 * Scale image to fill slot exactly — no black bars, no padding.
 * Guarantees: output is EXACTLY sw×sh pixels.
 * Steps: scale so both dimensions >= target, then centre-crop to exact size.
 */
function scaleFill(sw, sh) {
  return `scale=${sw}:${sh}:force_original_aspect_ratio=increase:flags=lanczos,` +
         `crop=${sw}:${sh}:(iw-${sw})/2:(ih-${sh})/2,` +
         `setsar=1`;
}

/**
 * Ken Burns zoom — zoompan used ONLY for scale, centered at anchor point.
 * anchor: "center" | "top" | "face" (shifts y center upward for faces)
 * zFrom: starting zoom (>= 1.0), zTo: ending zoom
 * zoompan x/y here are in INPUT coordinate space (crop-window origin),
 * NOT screen positions. Always kept at center of the zoomed crop window.
 */
function kenBurns(w, h, totalFrames, fps, zFrom, zTo, anchor) {
  const anchorY = anchor === "face" ? "ih*0.32-(ih/zoom/2)" :
                  anchor === "top"  ? "max(0,ih*0.15-(ih/zoom/2))" :
                                      "ih/2-(ih/zoom/2)";
  // zoompan's z= expression only has access to 'on' (frame count), not 't' (seconds).
  // on/tf === t/dur === normalized progress. We use easeInOutCubic for smooth zoom.
  // easeInOutCubic(p): p<0.5 ? 4p^3 : 1-(-2p+2)^3/2
  // In frame terms: p = on/${totalFrames}
  const zExpr = zFrom === zTo
    ? `${zFrom.toFixed(4)}`
    : (() => {
        const zMin = Math.min(zFrom, zTo).toFixed(4);
        const zMax = Math.max(zFrom, zTo).toFixed(4);
        const d = (zTo - zFrom).toFixed(6);
        // easeInOutCubic in frame space.
        // FFmpeg expression evaluator uses if(cond,a,b) — NOT JS ternary ?:
        const p  = `on/${totalFrames}`;
        const eio = `if(lt(${p},0.5),4*(${p})*(${p})*(${p}),1-pow(-2*(${p})+2,3)/2)`;
        return `min(${zMax},max(${zMin},${zFrom.toFixed(4)}+${d}*${eio}))`;
      })();
  return `zoompan=z='${zExpr}':x='iw/2-(iw/zoom/2)':y='${anchorY}':d=${totalFrames}:s=${w}x${h}:fps=${fps}`;
}

function resolveInputPaths(opts, maxCount) {
  let paths = [];
  if (Array.isArray(opts.inputPaths) && opts.inputPaths.length > 0) {
    paths = opts.inputPaths.filter(p => typeof p === "string" && p.length > 0);
  } else if (typeof opts.inputPath === "string" && opts.inputPath.length > 0) {
    paths = [opts.inputPath];
  }
  if (paths.length === 0) throw new Error("buildCompositionCmd: no valid inputPath(s) provided");
  return paths.slice(0, maxCount);
}

function padPaths(paths, count) {
  const out = [...paths];
  while (out.length < count) out.push(out[out.length - 1]);
  return out.slice(0, count);
}

function buildFaceCrop(faceBbox, srcW, srcH, outW, outH) {
  if (!faceBbox || !srcW || !srcH) return scaleFill(outW, outH);
  const { x, y, w: fw, h: fh } = faceBbox;
  const aspect = outW / outH;
  let cropH = Math.min(srcH, Math.max(fh * 2.0, srcH * 0.5));
  let cropW = Math.round(cropH * aspect);
  if (cropW > srcW) { cropW = srcW; cropH = Math.round(cropW / aspect); }
  let cx = Math.max(0, Math.min(Math.round(x + fw / 2 - cropW / 2), srcW - cropW));
  let cy = Math.max(0, Math.min(Math.round(y + fh / 2 - cropH / 2), srcH - cropH));
  return `crop=${cropW}:${cropH}:${cx}:${cy},scale=${outW}:${outH}:flags=lanczos,setsar=1`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN BUILDER
// ═══════════════════════════════════════════════════════════════════════════════

function buildCompositionCmd(opts) {
  const {
    composition, outPath,
    duration, fps = 30,
    w = 1080, h = 1920,
    colorGrade = "none", overlays = [], beatOffsets = [],
  } = opts;

  if (!composition || !COMPOSITIONS.has(composition)) return null;

  const dur  = Math.max(0.3, duration);
  const durS = dur.toFixed(4);
  const durP = (dur + 0.1).toFixed(4);         // input loop duration (small pad)
  const tf   = Math.max(4, Math.round(dur * fps)); // total frames
  const post = buildPostChain(colorGrade, overlays, w, h);
  const OF   = `-t ${durS} -an -c:v libx264 -preset fast -crf 20 -pix_fmt yuv420p`;

  if (MULTI_IMAGE_COMPOSITIONS.has(composition)) {
    return _buildMulti(composition, opts, { dur, durS, durP, tf, fps, w, h, post, OF, beatOffsets });
  }

  const [ip] = resolveInputPaths(opts, 1);
  // Single image input: loop for durP seconds so filters always have frames
  const inp = `-loop 1 -t ${durP} -i "${ip}"`;
  const SF  = scaleFill(w, h);

  switch (composition) {

    // ─── THREE PANEL ──────────────────────────────────────────────────────────
    // Ref: CapCut 3-split. Image divided into 3 vertical strips.
    // Each strip is pre-scaled to its slot size, placed via overlay at fixed x.
    // Slow uniform zoom applied per-strip via zoompan (zoom only, no pan drift).
    // Fix: strip crops at correct x thirds; overlay places at correct screen x.
    case "three_panel": {
      const gap = 3;
      const sw  = Math.floor((w - gap * 2) / 3);
      const x0  = 0, x1 = Math.floor(w / 3), x2 = Math.floor(2 * w / 3);
      // Each strip zooms at a different rate: side panels subtle, center stronger.
      // Fixed values — deterministic, cache-safe.
      const kb1 = kenBurns(sw, h, tf, fps, 1.0, 1.10, "center"); // left
      const kb2 = kenBurns(sw, h, tf, fps, 1.0, 1.14, "center"); // center — dominant
      const kb3 = kenBurns(sw, h, tf, fps, 1.0, 1.07, "center"); // right
      const fc  = [
        `[0:v]${SF}[full]`,
        `[full]split=3[b1][b2][b3]`,
        `[b1]crop=${sw}:${h}:${x0}:0[c1]`,
        `[b2]crop=${sw}:${h}:${x1}:0[c2]`,
        `[b3]crop=${sw}:${h}:${x2}:0[c3]`,
        `[c1]${kb1}[s1]`,
        `[c2]${kb2}[s2]`,
        `[c3]${kb3}[s3]`,
        `color=c=black:s=${w}x${h}:d=${durP}:r=${fps}[bg]`,
        `[bg][s1]overlay=x=0:y=0[t1]`,
        `[t1][s2]overlay=x=${sw + gap}:y=0[t2]`,
        `[t2][s3]overlay=x=${2 * (sw + gap)}:y=0,fps=${fps}${post}[vout]`,
      ];
      return `ffmpeg -y ${inp} -filter_complex "${fc.join(";")}" -map "[vout]" ${OF} "${outPath}"`;
    }

    // ─── FILM STRIP ───────────────────────────────────────────────────────────
    // Two horizontal halves. Top half drifts right faster than bottom (parallax).
    // Both drift in SAME direction — no visual conflict.
    // Movement via zoompan pan within oversized scaled image (legitimate use).
    // Fix: replaced opposite-zoom manga_panels with same-direction parallax pan.
    case "film_strip": {
      const gap = 3;
      const ph  = Math.floor((h - gap) / 2);
      // Scale image slightly wider than slot so pan has room
      const pxTop = Math.floor(w * 0.06); // total pan distance top half
      const pxBot = Math.floor(w * 0.03); // total pan distance bottom half
      const wWide = w + Math.max(pxTop, pxBot) + 4;
      const fc = [
        `[0:v]scale=${wWide}:${h}:force_original_aspect_ratio=increase:flags=lanczos,crop=${wWide}:${h}:(iw-${wWide})/2:(ih-${h})/2,setsar=1[wide]`,
        `[wide]split[wa][wb]`,
        // Top: crop upper half, pan from left to right (x increases over time)
        // easeOutCubic pan: x = dist*(1-(1-on/tf)^3) — decelerates like a real camera
        `[wa]crop=${wWide}:${ph}:0:0,` +
          `zoompan=z=1.0:x='min(${wWide - w},${pxTop}*(1-(1-on/${tf})*(1-on/${tf})*(1-on/${tf})))':y='0':d=${tf}:s=${w}x${ph}:fps=${fps}[top]`,
        // Bottom: same easing, half distance
        `[wb]crop=${wWide}:${ph}:0:${ph + gap},` +
          `zoompan=z=1.0:x='min(${wWide - w},${pxBot}*(1-(1-on/${tf})*(1-on/${tf})*(1-on/${tf})))':y='0':d=${tf}:s=${w}x${ph}:fps=${fps}[bot]`,
        `color=c=black:s=${w}x${h}:d=${durP}:r=${fps}[bg]`,
        `[bg][top]overlay=x=0:y=0[t1]`,
        `[t1][bot]overlay=x=0:y=${ph + gap},fps=${fps}${post}[vout]`,
      ];
      return `ffmpeg -y ${inp} -filter_complex "${fc.join(";")}" -map "[vout]" ${OF} "${outPath}"`;
    }

    // ─── QUAD GRID ────────────────────────────────────────────────────────────
    // Four quadrants, each cropped from correct quarter of image.
    // Uniform zoom-in on all four — no conflict.
    case "quad_grid": {
      const gap = 3;
      const qw  = Math.floor((w - gap) / 2);
      const qh  = Math.floor((h - gap) / 2);
      const x1  = Math.floor(w / 2), y1 = Math.floor(h / 2);
      // Top-right panel (index 1) is the focal point — stronger zoom draws the eye.
      const kbMain = kenBurns(qw, qh, tf, fps, 1.0, 1.14, "center"); // focus
      const kbSub  = kenBurns(qw, qh, tf, fps, 1.0, 1.06, "center"); // supporting
      const fc  = [
        `[0:v]${SF}[full]`,
        `[full]split=4[q1][q2][q3][q4]`,
        `[q1]crop=${qw}:${qh}:0:0[c1]`,
        `[q2]crop=${qw}:${qh}:${x1}:0[c2]`,
        `[q3]crop=${qw}:${qh}:0:${y1}[c3]`,
        `[q4]crop=${qw}:${qh}:${x1}:${y1}[c4]`,
        `[c1]${kbSub}[p1]`, `[c2]${kbMain}[p2]`, `[c3]${kbSub}[p3]`, `[c4]${kbSub}[p4]`,
        `color=c=black:s=${w}x${h}:d=${durP}:r=${fps}[bg]`,
        `[bg][p1]overlay=x=0:y=0[g1]`,
        `[g1][p2]overlay=x=${qw + gap}:y=0[g2]`,
        `[g2][p3]overlay=x=0:y=${qh + gap}[g3]`,
        `[g3][p4]overlay=x=${qw + gap}:y=${qh + gap},fps=${fps}${post}[vout]`,
      ];
      return `ffmpeg -y ${inp} -filter_complex "${fc.join(";")}" -map "[vout]" ${OF} "${outPath}"`;
    }

    // ─── DIAGONAL SPLIT ───────────────────────────────────────────────────────
    // Left half slow-zooms while panning left; right half zooms while panning right.
    // Image pre-scaled wide to give pan room — zoompan used for pan within scaled image.
    // Both sides zoom IN (no conflict). Diverging pan creates dynamic tension.
    case "diagonal_split": {
      const hw     = Math.floor(w / 2);
      const pxEach = Math.floor(w * 0.05);
      const wWide  = w + pxEach * 2 + 4;
      const fc = [
        `[0:v]scale=${wWide}:${h}:force_original_aspect_ratio=increase:flags=lanczos,crop=${wWide}:${h}:(iw-${wWide})/2:(ih-${h})/2,setsar=1[wide]`,
        `[wide]split[wa][wb]`,
        // Left half: starts at center, pans leftward (x decreases)
        // Left: stronger zoom (1.10) → feels heavier, more dominant
        `[wa]crop=${hw}:${h}:${pxEach}:0,` +
          `zoompan=z='1.0+0.10*(1-(1-on/${tf})*(1-on/${tf})*(1-on/${tf}))':x='max(0,${pxEach}-on*${(pxEach / tf).toFixed(5)})':y='ih/2-(ih/zoom/2)':d=${tf}:s=${hw}x${h}:fps=${fps}[lz]`,
        // Right: lighter zoom (1.08) → asymmetry creates visual tension
        `[wb]crop=${hw}:${h}:${pxEach}:0,` +
          `zoompan=z='1.0+0.08*(1-(1-on/${tf})*(1-on/${tf})*(1-on/${tf}))':x='min(${pxEach * 2},${pxEach}+on*${(pxEach / tf).toFixed(5)})':y='ih/2-(ih/zoom/2)':d=${tf}:s=${hw}x${h}:fps=${fps}[rz]`,
        `color=c=black:s=${w}x${h}:d=${durP}:r=${fps}[bg]`,
        `[bg][lz]overlay=x=0:y=0[d1]`,
        `[d1][rz]overlay=x=${hw}:y=0,fps=${fps}${post}[vout]`,
      ];
      return `ffmpeg -y ${inp} -filter_complex "${fc.join(";")}" -map "[vout]" ${OF} "${outPath}"`;
    }

    // ─── CHARACTER REVEAL ─────────────────────────────────────────────────────
    // Ref: CapCut "zoom reveal" — punches from 3× down to 1.05×.
    // zoompan used legitimately here: only changing scale, anchored to face area.
    // Fix: face anchor at y=0.32*ih, smooth deceleration via power curve.
    case "character_reveal": {
      // z: 3.0 → 1.05 using easeOutCubic mapped to frame count
      // z(on) = 3.0 - 1.95 * easeOutCubic(on / tf)
      // easeOutCubic(p) = 1 - (1-p)^3
      const fc = [
        `[0:v]${SF}[base]`,
        // z: 3.0→1.02 — 1.98 range. Settles slightly above 1.0 for a "snap" feel (CapCut style).
        `[base]zoompan=z='max(1.0,3.0-1.98*(1-(1-on/${tf})*(1-on/${tf})*(1-on/${tf})))':` + // easeOutCubic, snap settle
          `x='iw/2-(iw/zoom/2)':` +
          `y='max(0,ih*0.32-(ih/zoom/2))':` +
          `d=${tf}:s=${w}x${h}:fps=${fps},` +
          `vignette=PI/2.8${post}[vout]`,
      ];
      return `ffmpeg -y ${inp} -filter_complex "${fc.join(";")}" -map "[vout]" ${OF} "${outPath}"`;
    }

    // ─── VERTICAL WIPE ────────────────────────────────────────────────────────
    // Black cover layer shrinks downward (crop height decreases to 0), revealing image.
    // Image is ALWAYS fully present underneath — cover is additive.
    // Fix: cover approach (not destructive crop on image), easeOutCubic.
    case "vertical_wipe": {
      const revealDur = Math.min(dur * 0.65, 1.0);
      // cover_h = h * (1 - easeOutCubic(t, 0, revealDur))
      // = h * (1 - p)^3 where p = clamp(t/revealDur, 0, 1)
      const prog = p(0, revealDur);
      const coverH = `max(2,${h}*((1-${prog})*(1-${prog})*(1-${prog})))`;
      const fc = [
        `[0:v]${SF}[img]`,
        `[img]${kenBurns(w, h, tf, fps, 1.04, 1.10, "center")}[zoomed]`,
        `color=c=black:s=${w}x${h}:d=${durP}:r=${fps}[cover_src]`,
        `[cover_src]crop=${w}:'${coverH}':0:0[cover]`,
        `[zoomed][cover]overlay=x=0:y=0,fps=${fps}${post}[vout]`,
      ];
      return `ffmpeg -y ${inp} -filter_complex "${fc.join(";")}" -map "[vout]" ${OF} "${outPath}"`;
    }

    // ─── SWIPE IN LEFT ────────────────────────────────────────────────────────
    // Ref: CapCut slide transition. Image enters from x = -w (fully off left).
    // Settles at x=0. easeOutCubic. Slow Ken Burns during hold.
    // Fix: overlay-based movement (not zoompan pan). True off-screen start.
    case "swipe_in_left": {
      const swipeDur = Math.min(0.45, dur * 0.38);
      // x: -w → 0 using easeOutCubic
      const xExpr = lerp(-w, 0, eoc(0, swipeDur));
      const fc = [
        `[0:v]${SF}[img]`,
        `[img]${kenBurns(w, h, tf, fps, 1.0, 1.06, "center")}[kb]`,
        `color=c=black:s=${w}x${h}:d=${durP}:r=${fps}[bg]`,
        `[bg][kb]overlay=x='${xExpr}':y=0,fps=${fps}${post}[vout]`,
      ];
      return `ffmpeg -y ${inp} -filter_complex "${fc.join(";")}" -map "[vout]" ${OF} "${outPath}"`;
    }

    // ─── SWIPE IN RIGHT ───────────────────────────────────────────────────────
    // Image enters from x = +w. Settles at x=0.
    case "swipe_in_right": {
      const swipeDur = Math.min(0.45, dur * 0.38);
      const xExpr = lerp(w, 0, eoc(0, swipeDur));
      const fc = [
        `[0:v]${SF}[img]`,
        `[img]${kenBurns(w, h, tf, fps, 1.0, 1.06, "center")}[kb]`,
        `color=c=black:s=${w}x${h}:d=${durP}:r=${fps}[bg]`,
        `[bg][kb]overlay=x='${xExpr}':y=0,fps=${fps}${post}[vout]`,
      ];
      return `ffmpeg -y ${inp} -filter_complex "${fc.join(";")}" -map "[vout]" ${OF} "${outPath}"`;
    }

    // ─── SWIPE IN TOP ─────────────────────────────────────────────────────────
    // Image enters from y = -h (above frame). Settles at y=0.
    case "swipe_in_top": {
      const swipeDur = Math.min(0.45, dur * 0.38);
      const yExpr = lerp(-h, 0, eoc(0, swipeDur));
      const fc = [
        `[0:v]${SF}[img]`,
        `[img]${kenBurns(w, h, tf, fps, 1.0, 1.06, "center")}[kb]`,
        `color=c=black:s=${w}x${h}:d=${durP}:r=${fps}[bg]`,
        `[bg][kb]overlay=x=0:y='${yExpr}',fps=${fps}${post}[vout]`,
      ];
      return `ffmpeg -y ${inp} -filter_complex "${fc.join(";")}" -map "[vout]" ${OF} "${outPath}"`;
    }

    // ─── CURTAIN OPEN ─────────────────────────────────────────────────────────
    // Two solid black panels cover the image. Left slides to x=-hw, right to x=w.
    // Reveals image underneath via easeOutCubic.
    // Fix: curtains are solid color overlays, image never moves.
    case "curtain_open": {
      const openDur = Math.min(dur * 0.5, 0.8);
      const hw      = Math.floor(w / 2);
      // Left curtain: x goes from 0 → -hw (exits left)
      const lxExpr = lerp(0, -hw, eoc(0, openDur));
      // Right curtain: x goes from hw → w (exits right)
      const rxExpr = lerp(hw, w, eoc(0, openDur));
      const fc = [
        `[0:v]${SF}[img]`,
        `[img]${kenBurns(w, h, tf, fps, 1.02, 1.08, "center")}[kb]`,
        `color=c=black:s=${hw}x${h}:d=${durP}:r=${fps}[lc]`,
        `color=c=black:s=${hw}x${h}:d=${durP}:r=${fps}[rc]`,
        `[kb][lc]overlay=x='${lxExpr}':y=0[t1]`,
        `[t1][rc]overlay=x='${rxExpr}':y=0,fps=${fps}${post}[vout]`,
      ];
      return `ffmpeg -y ${inp} -filter_complex "${fc.join(";")}" -map "[vout]" ${OF} "${outPath}"`;
    }

    // ─── SPOTLIGHT ZOOM ───────────────────────────────────────────────────────
    // Blurred background (slow zoom) + sharp foreground crop that zooms in.
    // Two separate streams from one image — genuine depth illusion.
    case "spotlight_zoom": {
      const cw  = Math.floor(w * 0.52), ch = Math.floor(h * 0.52);
      const fw2 = Math.floor(w * 0.72), fh2 = Math.floor(h * 0.72);
      const cy2 = Math.max(0, Math.floor(h * 0.12));
      const fc = [
        `[0:v]${SF}[base]`,
        `[base]split[bgi][fgi]`,
        `[bgi]${kenBurns(w, h, tf, fps, 1.02, 1.06, "center")},boxblur=20:5[bg]`,
        `[fgi]crop=${cw}:${ch}:(iw-${cw})/2:${cy2},` +
          `${kenBurns(cw, ch, tf, fps, 1.0, 1.35, "center")},` +
          `scale=${fw2}:${fh2}:flags=lanczos[fg]`,
        // Subtle x drift: 8px sin wave — fg feels alive, not static
        `[bg][fg]overlay=x='(W-w)/2+8*sin(t*2)':y=(H-h)*3/8,fps=${fps}${post}[vout]`,
      ];
      return `ffmpeg -y ${inp} -filter_complex "${fc.join(";")}" -map "[vout]" ${OF} "${outPath}"`;
    }

    // ─── PARALLAX ─────────────────────────────────────────────────────────────
    // Background pans slowly, foreground pans faster — genuine depth.
    // zoompan used for pan within oversized scaled image (legitimate).
    case "parallax": {
      const fgW = Math.floor(w * 0.62), fgH = Math.floor(h * 0.62);
      const pxBg = Math.floor(w * 0.04); // bg pans less → feels further away
      const pxFg = Math.floor(w * 0.18); // fg pans more → stronger depth separation
      const wBg = w + pxBg + 4;
      const wFg = fgW + pxFg + 4;
      const fc = [
        `[0:v]scale=${wBg}:${h}:force_original_aspect_ratio=increase:flags=lanczos,crop=${wBg}:${h}:(iw-${wBg})/2:(ih-${h})/2,setsar=1[ws]`,
        `[ws]split[bgi][fgi]`,
        `[bgi]zoompan=z=1.0:x='min(${wBg - w},on*${(pxBg / tf).toFixed(5)})':y='0':d=${tf}:s=${w}x${h}:fps=${fps},smartblur=1.5:0.4:0[bg]`,
        `[fgi]crop=${fgW}:${fgH}:(iw-${fgW})/2:(ih-${fgH})/2,` +
          `scale=${fgW + pxFg + 4}:${fgH}:force_original_aspect_ratio=increase:flags=lanczos,` +
          `crop=${fgW + pxFg}:${fgH}:(iw-${fgW + pxFg})/2:0,setsar=1[fgw]`,
        `[fgw]zoompan=z=1.0:x='min(${pxFg},on*${(pxFg / tf).toFixed(5)})':y='0':d=${tf}:s=${fgW}x${fgH}:fps=${fps}[fg]`,
        `[bg][fg]overlay=x=(W-w)/2:y=(H-h)/2,fps=${fps}${post}[vout]`,
      ];
      return `ffmpeg -y ${inp} -filter_complex "${fc.join(";")}" -map "[vout]" ${OF} "${outPath}"`;
    }

    // ─── RACK FOCUS ───────────────────────────────────────────────────────────
    // Background blurred + slow zoom. Foreground sharp + zoom-in.
    // Two streams, overlay places sharp foreground centered over blurred bg.
    case "rack_focus": {
      const fgW = Math.floor(w * 0.65), fgH = Math.floor(h * 0.65);
      const cy2 = Math.max(0, Math.floor(h * 0.08));
      const fc = [
        `[0:v]${SF}[base]`,
        `[base]split[bgi][fgi]`,
        `[bgi]${kenBurns(w, h, tf, fps, 1.04, 1.10, "center")},boxblur=18:4[bg]`,
        `[fgi]crop=${fgW}:${fgH}:(iw-${fgW})/2:${cy2},` +
          `${kenBurns(fgW, fgH, tf, fps, 1.0, 1.14, "face")}[fg]`,
        `[bg][fg]overlay=x=(W-w)/2:y=(H-h)*3/8,fps=${fps}${post}[vout]`,
      ];
      return `ffmpeg -y ${inp} -filter_complex "${fc.join(";")}" -map "[vout]" ${OF} "${outPath}"`;
    }

    // ─── IMPACT FRAME ─────────────────────────────────────────────────────────
    // White flash overlay fades out in first 15% of scene.
    // Image punches from 2.2× down to 1.05× using easeOutCubic on frame count.
    // zoompan used only for zoom scale — legitimate use.
    case "impact_frame": {
      const flashFrames = Math.max(3, Math.floor(tf * 0.15));
      const flashDur    = (flashFrames / fps).toFixed(4);
      const zoomFrames  = tf - flashFrames;
      // z: 2.2 → 1.05 over remaining frames
      const zExpr = `if(lt(on,${flashFrames}),2.2,max(1.05,2.2-1.15*((on-${flashFrames})/${zoomFrames})*(1-(1-(on-${flashFrames})/${zoomFrames})*(1-(on-${flashFrames})/${zoomFrames})*(1-(on-${flashFrames})/${zoomFrames}))))`;
      const fc = [
        `[0:v]${SF}[base]`,
        `[base]zoompan=z='${zExpr}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${tf}:s=${w}x${h}:fps=${fps}[img]`,
        `color=c=white:s=${w}x${h}:d=${durP}:r=${fps},format=yuva420p,` +
          `fade=t=out:st=0:d=${flashDur}:alpha=1[flash]`,
        `[img][flash]overlay=x=0:y=0:shortest=1,fps=${fps}${post}[vout]`,
      ];
      return `ffmpeg -y ${inp} -filter_complex "${fc.join(";")}" -map "[vout]" ${OF} "${outPath}"`;
    }

    // ─── BOUNCE ZOOM ──────────────────────────────────────────────────────────
    // Damped spring: z = 1.05 + 0.28*(1 - exp(-6p)*cos(12p))
    // p = on/tf (linear frame progress — valid here since spring is frame-based oscillation)
    case "bounce_zoom": {
      const fc = [
        `[0:v]${SF}[base]`,
        `[base]zoompan=` +
          // 0.22 amplitude: less cartoon, more professional spring feel
          `z='1.05+0.22*(1-exp(-6*on/${tf})*cos(12*on/${tf}))':` +
          `x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':` +
          `d=${tf}:s=${w}x${h}:fps=${fps},fps=${fps}${post}[vout]`,
      ];
      return `ffmpeg -y ${inp} -filter_complex "${fc.join(";")}" -map "[vout]" ${OF} "${outPath}"`;
    }

    // ─── ZOOM BURST ───────────────────────────────────────────────────────────
    // Punches in from 2.5× and decelerates to 1.05×.
    // power(0.4) curve gives fast-deceleration feel (CapCut "zoom in" style).
    case "zoom_burst": {
      const fc = [
        `[0:v]${SF}[base]`,
        `[base]zoompan=` +
          // Micro jitter on top of deceleration curve — human-editor feel
          `z='max(1.05,2.5-1.45*pow(min(1,on/${tf}),0.4)+0.01*sin(on*0.5))':` +
          `x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':` +
          `d=${tf}:s=${w}x${h}:fps=${fps},fps=${fps}${post}[vout]`,
      ];
      return `ffmpeg -y ${inp} -filter_complex "${fc.join(";")}" -map "[vout]" ${OF} "${outPath}"`;
    }

    // ─── SHOCKWAVE ────────────────────────────────────────────────────────────
    // Zoom decays exponentially + heavy vignette fades in then out.
    // z = 1.05 + 0.18*exp(-7p), vignette angle pulses.
    case "shockwave": {
      const fc = [
        `[0:v]${SF}[base]`,
        `[base]zoompan=` +
          `z='1.05+0.18*exp(-7*on/${tf})':` +
          `x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':` +
          `d=${tf}:s=${w}x${h}:fps=${fps},` +
          `fps=${fps},` +
          `vignette='PI/2*exp(-5*t/${durS})+PI/7'${post}[vout]`,
      ];
      return `ffmpeg -y ${inp} -filter_complex "${fc.join(";")}" -map "[vout]" ${OF} "${outPath}"`;
    }

    // ─── LETTERBOX PAN ────────────────────────────────────────────────────────
    // 2.35:1 cinematic bars + horizontal pan across zoomed image.
    // zoompan used for pan within oversized image — legitimate use.
    case "letterbox_pan": {
      const bh      = Math.floor(h * 0.115);
      const pxPan   = Math.floor(w * 0.12);
      const wWide   = w + pxPan + 4;
      const fc = [
        `[0:v]scale=${wWide}:${h}:force_original_aspect_ratio=increase:flags=lanczos,` +
          `crop=${wWide}:${h}:(iw-${wWide})/2:(ih-${h})/2,setsar=1[wide]`,
        // easeOutCubic pan — camera decelerates naturally into position
        `[wide]zoompan=z=1.0:x='min(${pxPan},${pxPan}*(1-(1-on/${tf})*(1-on/${tf})*(1-on/${tf})))':y='0':d=${tf}:s=${w}x${h}:fps=${fps}[panned]`,
        `[panned]drawbox=x=0:y=0:w=${w}:h=${bh}:color=black:t=fill,` +
          `drawbox=x=0:y=${h - bh}:w=${w}:h=${bh}:color=black:t=fill,` +
          `fps=${fps}${post}[vout]`,
      ];
      return `ffmpeg -y ${inp} -filter_complex "${fc.join(";")}" -map "[vout]" ${OF} "${outPath}"`;
    }

    // ─── TILT REVEAL ──────────────────────────────────────────────────────────
    // Camera tilts upward — pan from bottom of image to top.
    // Scaled taller than frame, pan y from bottom to top over full duration.
    case "tilt_reveal": {
      const pxPan = Math.floor(h * 0.12);
      const hTall = h + pxPan + 4;
      const fc = [
        `[0:v]scale=${w}:${hTall}:force_original_aspect_ratio=increase:flags=lanczos,` +
          `crop=${w}:${hTall}:(iw-${w})/2:(ih-${hTall})/2,setsar=1[tall]`,
        // Pan y from pxPan (bottom area) down to 0 (top area)
        // z=1.02 slight zoom during tilt — feels like a real camera move
        `[tall]zoompan=z=1.02:x='0':y='max(0,${pxPan}-on*${(pxPan / tf).toFixed(5)})':d=${tf}:s=${w}x${h}:fps=${fps},` +
          `fps=${fps}${post}[vout]`,
      ];
      return `ffmpeg -y ${inp} -filter_complex "${fc.join(";")}" -map "[vout]" ${OF} "${outPath}"`;
    }

    // ─── MIRROR COMPOSITE ─────────────────────────────────────────────────────
    // Left half of image flipped and overlaid at 55% opacity.
    // Background pans slowly. Ghost overlay is fixed. Stylized / music-video look.
    case "mirror_composite": {
      const hw = Math.floor(w / 2);
      const pxBg = Math.floor(w * 0.06);
      const wWide = w + pxBg + 4;
      const fc = [
        `[0:v]scale=${wWide}:${h}:force_original_aspect_ratio=increase:flags=lanczos,` +
          `crop=${wWide}:${h}:(iw-${wWide})/2:(ih-${h})/2,setsar=1[wide]`,
        `[wide]split[bgw][mir]`,
        `[bgw]zoompan=z=1.0:x='min(${pxBg},on*${(pxBg / tf).toFixed(5)})':y='0':d=${tf}:s=${w}x${h}:fps=${fps}[bg]`,
        // Mirror: crop left half of original (not the panned version), hflip, alpha 0.55
        `[mir]crop=${hw}:${h}:0:0,hflip,scale=${hw}:${h}:flags=lanczos,setsar=1,` +
          // 0.50 opacity: balanced ghost feel, consistent across all scenes
          `format=yuva420p,colorchannelmixer=aa=0.50[ghost]`,
        `[bg][ghost]overlay=x=0:y=0,fps=${fps}${post}[vout]`,
      ];
      return `ffmpeg -y ${inp} -filter_complex "${fc.join(";")}" -map "[vout]" ${OF} "${outPath}"`;
    }

    // ─── NEON FRAME ───────────────────────────────────────────────────────────
    // Cyan/magenta border. Slow zoom-in. Clean and simple.
    case "neon_frame": {
      const brd = 14;
      const fc = [
        `[0:v]${SF}[base]`,
        `[base]${kenBurns(w, h, tf, fps, 1.0, 1.08, "center")},` +
          `drawbox=x=0:y=0:w=${w}:h=${brd}:color=0x00ffff@0.9:t=fill,` +
          `drawbox=x=0:y=${h - brd}:w=${w}:h=${brd}:color=0xff00ff@0.9:t=fill,` +
          `drawbox=x=0:y=0:w=${brd}:h=${h}:color=0x00ffff@0.9:t=fill,` +
          `drawbox=x=${w - brd}:y=0:w=${brd}:h=${h}:color=0xff00ff@0.9:t=fill,` +
          `fps=${fps}${post}[vout]`,
      ];
      return `ffmpeg -y ${inp} -filter_complex "${fc.join(";")}" -map "[vout]" ${OF} "${outPath}"`;
    }

    // ─── VHS COMPOSITE ────────────────────────────────────────────────────────
    // Analog jitter (x/y oscillation via zoompan sin waves) + chromatic shift +
    // noise + scanlines. zoompan oscillation is legitimate — z=const, jitter in x/y.
    case "vhs_composite": {
      const fc = [
        `[0:v]${SF}[base]`,
        `[base]zoompan=z=1.05:` +
          `x='iw/2-(iw/zoom/2)+4*sin(on*0.71)':` +
          `y='ih/2-(ih/zoom/2)+3*sin(on*0.43+1.2)':` +
          `d=${tf}:s=${w}x${h}:fps=${fps},` +
          `rgbashift=rh=2:rv=0:gh=-1:gv=1:bh=-2:bv=0,` +
          // alls=8: less chaotic, more stylized (pro VHS look not broken tape)
          `noise=alls=8:allf=t+u,` +
          `drawgrid=width=0:height=4:thickness=1:color=black@0.20,` +
          `fps=${fps}${post}[vout]`,
      ];
      return `ffmpeg -y ${inp} -filter_complex "${fc.join(";")}" -map "[vout]" ${OF} "${outPath}"`;
    }

    default:
      return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MULTI-IMAGE COMPOSITIONS
// ═══════════════════════════════════════════════════════════════════════════════

function _buildMulti(composition, opts, { dur, durS, durP, tf, fps, w, h, post, OF, beatOffsets }) {
  const { outPath } = opts;
  const rawPaths = resolveInputPaths(opts, 4);

  // Beat times for staggered animations (up to 3 beats)
  const beats = beatOffsets.slice(0, 3);
  while (beats.length < 3) beats.push((beats.length * dur) / 3);

  switch (composition) {

    // ─── BEAT STACK 3 ─────────────────────────────────────────────────────────
    // Three strips slide up from below on successive beats.
    // Each strip is pre-scaled to w × slotH, placed via overlay y expression.
    // easeOutCubic for each strip's enter animation.
    case "beat_stack_3": {
      const paths  = padPaths(rawPaths, 3);
      const inputs = paths.map(q => `-loop 1 -t ${durP} -i "${q}"`).join(" ");
      const slotH  = Math.floor(h / 3);
      const gap    = 2;
      const slideD = 0.28;
      const slotY  = [0, slotH + gap, 2 * (slotH + gap)];
      const fc     = [];
      for (let i = 0; i < 3; i++) {
        fc.push(`[${i}:v]${scaleFill(w, slotH)}[strip${i}]`);
      }
      fc.push(`color=c=black:s=${w}x${h}:d=${durP}:r=${fps}[canvas]`);
      let prev = "canvas";
      for (let i = 0; i < 3; i++) {
        const tY  = slotY[i];
        const bT  = beats[i];
        const out = i === 2 ? "stacked" : `cs${i}`;
        // y: h → tY using easeOutCubic starting at beat time bT
        const prog = p(bT, slideD);
        const yExpr = lerp(h, tY, `(1-(1-${prog})*(1-${prog})*(1-${prog}))`);
        fc.push(`[${prev}][strip${i}]overlay=x=0:y='${yExpr}'[${out}]`);
        prev = out;
      }
      fc.push(`[stacked]fps=${fps}${post}[vout]`);
      return `ffmpeg -y ${inputs} -filter_complex "${fc.join(";")}" -map "[vout]" ${OF} "${outPath}"`;
    }

    // ─── TRIPTYCH REVEAL ──────────────────────────────────────────────────────
    // Three vertical panels wipe in from top on successive beats.
    // Cover approach: black mask shrinks per panel.
    // Fix: min cover height = 2 to prevent empty-crop crash.
    case "triptych_reveal": {
      const paths  = padPaths(rawPaths, 3);
      const inputs = paths.map(q => `-loop 1 -t ${durP} -i "${q}"`).join(" ");
      const gap    = 2;
      const pw     = Math.floor((w - gap * 2) / 3);
      const wipeD  = 0.38;
      const fc     = [];
      for (let i = 0; i < 3; i++) {
        fc.push(
          `[${i}:v]${scaleFill(pw, h)},` +
          `${kenBurns(pw, h, tf, fps, 1.0, 1.06, "center")}[panel${i}]`
        );
      }
      fc.push(`color=c=black:s=${w}x${h}:d=${durP}:r=${fps}[canvas]`);
      let prev = "canvas";
      for (let i = 0; i < 3; i++) {
        // Micro-stagger: each panel starts 0.05s after its beat — cascade feel
        const bT   = beats[i] + staggerSec(i, 0.05);
        const xPos = i * (pw + gap);
        const out  = i === 2 ? "composed" : `cp${i}`;
        // revealed height: 0 → h using easeOutCubic from beat time
        const prog    = p(bT, wipeD);
        const revealH = lerp(0, h, `(1-(1-${prog})*(1-${prog})*(1-${prog}))`);
        // Cover = what's NOT yet revealed (shrinks from h to 0)
        const coverH  = `max(2,${h}-(${revealH}))`;
        fc.push(`[panel${i}]crop=${pw}:'${coverH}':0:0[cv${i}]`);
        // Place panel at xPos; cover sits at top and shrinks away
        // Actual reveal: overlay panel at (xPos, revealedTop) — simpler to use cover overlay
        // Better: place full panel, cover top with black shrinking rect
        fc.push(`[${prev}][panel${i}]overlay=x=${xPos}:y=0[pt${i}]`);
        fc.push(`[pt${i}][cv${i}]overlay=x=${xPos}:y=0[${out}]`);
        prev = out;
      }
      fc.push(`[composed]fps=${fps}${post}[vout]`);
      return `ffmpeg -y ${inputs} -filter_complex "${fc.join(";")}" -map "[vout]" ${OF} "${outPath}"`;
    }

    // ─── DOOR OPEN ────────────────────────────────────────────────────────────
    // Background (img 0) revealed as two door panels (from img 1) slide apart.
    // Left panel exits left, right panel exits right. easeOutCubic.
    // Fix: all panel movement via overlay x — no zoompan for translation.
    case "door_open": {
      const paths  = padPaths(rawPaths, 2);
      const inputs = paths.map(q => `-loop 1 -t ${durP} -i "${q}"`).join(" ");
      const hw     = Math.floor(w / 2);
      const openD  = Math.min(dur * 0.50, 0.7);
      // Left exits: x 0 → -hw
      const lxExpr = lerp(0, -hw, eoc(0, openD));
      // Right exits: x hw → w
      const rxExpr = lerp(hw, w, eoc(0, openD));
      const fc = [
        `[0:v]${scaleFill(w, h)}[bg]`,
        `[1:v]${scaleFill(w, h)}[door]`,
        `[door]split[dl][dr]`,
        `[dl]crop=${hw}:${h}:0:0[lp]`,
        `[dr]crop=${hw}:${h}:${hw}:0[rp]`,
        // Stronger bg zoom (1.10) — bg feels like it's breathing into the scene
        `[bg]${kenBurns(w, h, tf, fps, 1.0, 1.10, "center")}[bgz]`,
        `[bgz][lp]overlay=x='${lxExpr}':y=0[t1]`,
        `[t1][rp]overlay=x='${rxExpr}':y=0,fps=${fps}${post}[vout]`,
      ];
      return `ffmpeg -y ${inputs} -filter_complex "${fc.join(";")}" -map "[vout]" ${OF} "${outPath}"`;
    }

    // ─── PHOTO WALL SWEEP ─────────────────────────────────────────────────────
    // 2×2 grid assembled on wide canvas, panned left→right via zoompan.
    // zoompan legitimate: panning within oversized assembled wall canvas.
    case "photo_wall_sweep": {
      const paths   = padPaths(rawPaths, 4);
      const inputs  = paths.map(q => `-loop 1 -t ${durP} -i "${q}"`).join(" ");
      const cellW   = Math.floor(w * 0.55);
      const cellH   = Math.floor(h * 0.52);
      const wallW   = cellW * 2 + 8;
      const wallH   = cellH * 2 + 8;
      const panDist = Math.max(0, wallW - w);
      const cropY   = Math.max(0, Math.floor((wallH - h) / 2));
      const fc      = [];
      for (let i = 0; i < 4; i++) fc.push(`[${i}:v]${scaleFill(cellW, cellH)}[cell${i}]`);
      fc.push(`color=c=black:s=${wallW}x${wallH}:d=${durP}:r=${fps}[wall]`);
      fc.push(`[wall][cell0]overlay=x=0:y=0[w1]`);
      fc.push(`[w1][cell1]overlay=x=${cellW + 8}:y=0[w2]`);
      fc.push(`[w2][cell2]overlay=x=0:y=${cellH + 8}[w3]`);
      fc.push(`[w3][cell3]overlay=x=${cellW + 8}:y=${cellH + 8}[assembled]`);
      // Linear pan for wall sweep — natural camera movement
      const xExpr = `min(${panDist},t*${(panDist / dur).toFixed(4)})`;
      // Subtle y drift: 8px sin wave — organic camera sway
      const yExpr = `${cropY}+8*sin(t*0.7)`;
      fc.push(`[assembled]crop=${w}:${h}:'${xExpr}':'${yExpr}',fps=${fps}${post}[vout]`);
      return `ffmpeg -y ${inputs} -filter_complex "${fc.join(";")}" -map "[vout]" ${OF} "${outPath}"`;
    }

    // ─── CINEMATIC DUO ────────────────────────────────────────────────────────
    // Top 35%: portrait/face crop. Bottom 65%: wide/action crop. Black divider.
    // Each slot gets its own gentle Ken Burns. No position drift.
    case "cinematic_duo": {
      const paths  = padPaths(rawPaths, 2);
      const inputs = paths.map(q => `-loop 1 -t ${durP} -i "${q}"`).join(" ");
      const topH   = Math.floor(h * 0.35);
      const botH   = h - topH - 4;
      const fc = [
        `[0:v]${scaleFill(w, topH)},${kenBurns(w, topH, tf, fps, 1.0, 1.06, "face")}[top]`,
        `[1:v]${scaleFill(w, botH)},${kenBurns(w, botH, tf, fps, 1.0, 1.08, "center")}[bot]`,
        `color=c=black:s=${w}x${h}:d=${durP}:r=${fps}[bg]`,
        `[bg][top]overlay=x=0:y=0[t1]`,
        `[t1][bot]overlay=x=0:y=${topH + 4},fps=${fps}${post}[vout]`,
      ];
      return `ffmpeg -y ${inputs} -filter_complex "${fc.join(";")}" -map "[vout]" ${OF} "${outPath}"`;
    }

    // ─── PIP CORNER ───────────────────────────────────────────────────────────
    // Full frame background (slow Ken Burns) + PIP slides in from right.
    // PIP movement via overlay x expression — easeOutCubic.
    case "pip_corner": {
      const paths  = padPaths(rawPaths, 2);
      const inputs = paths.map(q => `-loop 1 -t ${durP} -i "${q}"`).join(" ");
      const pipW   = Math.floor(w * 0.30);
      const pipH   = Math.floor(h * 0.30);
      const pipX   = w - pipW - 20;
      const pipY   = h - pipH - 20;
      const slideT = Math.max(0.1, beats[0] || 0.3);
      const slideD = 0.30;
      // PIP x: w → pipX using easeOutCubic starting at slideT
      const xExpr  = lerp(w, pipX, eoc(slideT, slideD));
      const fc = [
        `[0:v]${scaleFill(w, h)},${kenBurns(w, h, tf, fps, 1.02, 1.08, "center")}[bg]`,
        `[1:v]${scaleFill(pipW, pipH)}[pip_raw]`,
        `[pip_raw]drawbox=x=0:y=0:w=${pipW}:h=${pipH}:color=white@0.75:t=3[pip]`,
        `[bg][pip]overlay=x='${xExpr}':y=${pipY},fps=${fps}${post}[vout]`,
      ];
      return `ffmpeg -y ${inputs} -filter_complex "${fc.join(";")}" -map "[vout]" ${OF} "${outPath}"`;
    }

    // ─── CROSS REVEAL ─────────────────────────────────────────────────────────
    // Left half enters from x=-hw, right half enters from x=+w.
    // Both meet at center simultaneously. easeOutCubic.
    // Fix: overlay x for movement (not zoompan). Correct gap math.
    case "cross_reveal": {
      const paths  = padPaths(rawPaths, 2);
      const inputs = paths.map(q => `-loop 1 -t ${durP} -i "${q}"`).join(" ");
      const gap    = 4;
      const hw     = Math.floor((w - gap) / 2);
      const slideD = Math.min(dur * 0.50, 0.55);
      // Left: x = -hw → 0
      const lxExpr = lerp(-hw, 0, eoc(0, slideD));
      // Right: x = w-hw → hw+gap (its resting x position)
      const rxExpr = lerp(w - hw, hw + gap, eoc(0, slideD));
      const fc = [
        `[0:v]${scaleFill(w, h)},crop=${hw}:${h}:0:0,${kenBurns(hw, h, tf, fps, 1.0, 1.05, "center")}[lz]`,
        `[1:v]${scaleFill(w, h)},crop=${hw}:${h}:${hw + gap}:0,${kenBurns(hw, h, tf, fps, 1.0, 1.05, "center")}[rz]`,
        `color=c=black:s=${w}x${h}:d=${durP}:r=${fps}[bg]`,
        // Subtle y drift: opposite directions, creates parallax depth feel
        `[bg][lz]overlay=x='${lxExpr}':y='8*sin(t*2)'[t1]`,
        `[t1][rz]overlay=x='${rxExpr}':y='-8*sin(t*2)',fps=${fps}${post}[vout]`,
      ];
      return `ffmpeg -y ${inputs} -filter_complex "${fc.join(";")}" -map "[vout]" ${OF} "${outPath}"`;
    }

    default:
      return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

module.exports = {
  COMPOSITIONS,
  MULTI_IMAGE_COMPOSITIONS,
  COMPOSITION_CATEGORIES,
  buildCompositionCmd,
  buildFaceCrop,
  // Export animation helpers so timeline editor can use same math
  animHelpers: { p, eoc, eic, eob, lerp, kenBurns },
};