/**
 * Composition Engine v2.0 — Cinematic AMV Compositions
 *
 * 22 cinematic compositions using multi-layer FFmpeg filter_complex.
 * All compositions are validated/safe (no zero-frame crashes, safe min-height guards).
 *
 * PANEL LAYOUTS:
 *   three_panel       — 3 vertical strips, each with different zoom direction
 *   manga_panels      — 2-panel manga layout (top/bottom)
 *   quad_grid         — 4-panel grid (2x2), each with different zoom
 *   diagonal_split    — diagonal wipe dividing image into 2 halves
 *
 * REVEALS:
 *   character_reveal  — starts zoomed in tight, expands to full (vignette iris)
 *   vertical_wipe     — image reveals from top to bottom (FIXED safe min height)
 *   slide_in_left     — image enters from left
 *   slide_in_right    — image enters from right
 *   slide_in_top      — image drops in from top
 *   curtain_open      — two halves slide apart from center (like curtains)
 *
 * FOCUS:
 *   spotlight_zoom    — center crop zooms in over blurred background
 *   parallax          — fake depth: fg moves faster than blurred bg
 *
 * IMPACT:
 *   impact_frame      — white flash to rapid snap zoom settle
 *   bounce_zoom       — elastic overshoot zoom (bounce back)
 *   zoom_burst        — rapid zoom out from tight crop at start
 *   shockwave         — radial vignette pulse out from center
 *
 * CINEMATIC:
 *   letterbox_pan     — cinematic 2.35:1 bars + slow horizontal pan
 *   tilt_reveal       — camera tilt-up from bottom of frame
 *   mirror_composite  — left half mirrored + original, drift
 *   neon_frame        — animated neon glow border around image
 *   vhs_composite     — simulated VHS tracking artifact composite
 *   rack_focus        — bg blurs progressively as fg sharpens
 */

const { buildColorGrade, buildOverlay } = require("./effectsLibrary");

// ─── REGISTRY ──────────────────────────────────────────────────────────────────

const COMPOSITIONS = new Set([
  // Panel Layouts
  "three_panel",
  "manga_panels",
  "quad_grid",
  "diagonal_split",
  // Reveals
  "character_reveal",
  "vertical_wipe",
  "slide_in_left",
  "slide_in_right",
  "slide_in_top",
  "curtain_open",
  // Focus
  "spotlight_zoom",
  "parallax",
  "rack_focus",
  // Impact
  "impact_frame",
  "bounce_zoom",
  "zoom_burst",
  "shockwave",
  // Cinematic
  "letterbox_pan",
  "tilt_reveal",
  "mirror_composite",
  "neon_frame",
  "vhs_composite",
]);

const COMPOSITION_CATEGORIES = {
  panels:    { label: "Panel Layouts", compositions: ["three_panel", "manga_panels", "quad_grid", "diagonal_split"] },
  reveals:   { label: "Reveals",       compositions: ["character_reveal", "vertical_wipe", "slide_in_left", "slide_in_right", "slide_in_top", "curtain_open"] },
  focus:     { label: "Focus",         compositions: ["spotlight_zoom", "parallax", "rack_focus"] },
  impact:    { label: "Impact",        compositions: ["impact_frame", "bounce_zoom", "zoom_burst", "shockwave"] },
  cinematic: { label: "Cinematic",     compositions: ["letterbox_pan", "tilt_reveal", "mirror_composite", "neon_frame", "vhs_composite"] },
};

// ─── HELPERS ───────────────────────────────────────────────────────────────────

function buildPostChain(colorGrade, overlays, w, h) {
  const parts = [];
  const gradeF = buildColorGrade(colorGrade);
  if (gradeF) parts.push(gradeF);
  for (const ov of overlays) {
    const ovF = buildOverlay(ov, w, h);
    if (ovF) parts.push(ovF);
  }
  if (!overlays.some(o => o.startsWith("vignette"))) {
    parts.push("vignette=PI/5");
  }
  return parts.length > 0 ? "," + parts.join(",") : "";
}

function safeFrames(duration, fps) {
  return Math.max(4, Math.round(duration * fps));
}

// ─── MAIN BUILDER ──────────────────────────────────────────────────────────────

function buildCompositionCmd(opts) {
  const {
    composition, inputPath, outPath,
    duration, fps = 30, w = 1080, h = 1920,
    colorGrade = "none", overlays = [],
  } = opts;

  const totalFrames = safeFrames(duration, fps);
  const dur    = Math.max(0.1, duration).toFixed(3);
  const durPad = (parseFloat(dur) + 0.1).toFixed(3);
  const post   = buildPostChain(colorGrade, overlays, w, h);

  const input    = `-loop 1 -t ${durPad} -i "${inputPath}"`;
  const outFlags = `-t ${dur} -an -c:v libx264 -preset fast -crf 20 -pix_fmt yuv420p`;
  const scalePad = `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:black,setsar=1`;

  switch (composition) {

    // ─── THREE PANEL ───────────────────────────────────────────────────────
    case "three_panel": {
      const sw = Math.floor(w / 3) - 4;
      const fc = [
        `[0:v]${scalePad}[base]`,
        `[base]split=3[b1][b2][b3]`,
        `[b1]crop=${sw}:${h}:0:0,zoompan=z='1.0+0.18*on/${totalFrames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${sw}x${h}:fps=${fps}[s1]`,
        `[b2]crop=${sw}:${h}:${Math.floor(w/3)}:0,zoompan=z='1.18-0.15*on/${totalFrames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${sw}x${h}:fps=${fps}[s2]`,
        `[b3]crop=${sw}:${h}:${Math.floor(2*w/3)}:0,zoompan=z='1.08+0.10*sin(on*3.14/${totalFrames})':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${sw}x${h}:fps=${fps}[s3]`,
        `color=c=black:s=${w}x${h}:d=${durPad}:r=${fps}[bg]`,
        `[bg][s1]overlay=x=0:y=0[t1]`,
        `[t1][s2]overlay=x=${sw+4}:y=0[t2]`,
        `[t2][s3]overlay=x=${2*(sw+4)}:y=0,fps=${fps}${post}[vout]`,
      ];
      return `ffmpeg -y ${input} -filter_complex "${fc.join(";")}" -map "[vout]" ${outFlags} "${outPath}"`;
    }

    // ─── MANGA PANELS ──────────────────────────────────────────────────────
    case "manga_panels": {
      const ph = Math.floor(h/2) - 3;
      const fc = [
        `[0:v]${scalePad}[base]`,
        `[base]split[top_in][bot_in]`,
        `[top_in]crop=${w}:${ph}:0:0,zoompan=z='1.0+0.20*on/${totalFrames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${w}x${ph}:fps=${fps}[top]`,
        `[bot_in]crop=${w}:${ph}:0:${Math.floor(h/2)},zoompan=z='1.20-0.15*on/${totalFrames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${w}x${ph}:fps=${fps}[bot]`,
        `color=c=black:s=${w}x${h}:d=${durPad}:r=${fps}[bg]`,
        `[bg][top]overlay=0:0[t1]`,
        `[t1][bot]overlay=0:${ph+6},fps=${fps}${post}[vout]`,
      ];
      return `ffmpeg -y ${input} -filter_complex "${fc.join(";")}" -map "[vout]" ${outFlags} "${outPath}"`;
    }

    // ─── QUAD GRID ─────────────────────────────────────────────────────────
    case "quad_grid": {
      const qw = Math.floor(w/2) - 3;
      const qh = Math.floor(h/2) - 3;
      const fc = [
        `[0:v]${scalePad}[base]`,
        `[base]split=4[q1][q2][q3][q4]`,
        `[q1]crop=${qw}:${qh}:0:0,zoompan=z='1.0+0.20*on/${totalFrames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${qw}x${qh}:fps=${fps}[p1]`,
        `[q2]crop=${qw}:${qh}:${Math.floor(w/2)}:0,zoompan=z='1.20-0.15*on/${totalFrames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${qw}x${qh}:fps=${fps}[p2]`,
        `[q3]crop=${qw}:${qh}:0:${Math.floor(h/2)},zoompan=z='1.10+0.10*sin(on*6.28/${totalFrames})':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${qw}x${qh}:fps=${fps}[p3]`,
        `[q4]crop=${qw}:${qh}:${Math.floor(w/2)}:${Math.floor(h/2)},zoompan=z='1.15-0.10*cos(on*6.28/${totalFrames})':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${qw}x${qh}:fps=${fps}[p4]`,
        `color=c=black:s=${w}x${h}:d=${durPad}:r=${fps}[bg]`,
        `[bg][p1]overlay=0:0[g1]`,
        `[g1][p2]overlay=${qw+6}:0[g2]`,
        `[g2][p3]overlay=0:${qh+6}[g3]`,
        `[g3][p4]overlay=${qw+6}:${qh+6},fps=${fps}${post}[vout]`,
      ];
      return `ffmpeg -y ${input} -filter_complex "${fc.join(";")}" -map "[vout]" ${outFlags} "${outPath}"`;
    }

    // ─── DIAGONAL SPLIT ────────────────────────────────────────────────────
    case "diagonal_split": {
      const hw = Math.floor(w/2);
      const fc = [
        `[0:v]${scalePad}[base]`,
        `[base]split[a][b]`,
        `[a]zoompan=z='1.0+0.15*on/${totalFrames}':x='max(0,iw/2-(iw/zoom/2)-18)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${w}x${h}:fps=${fps}[za]`,
        `[b]zoompan=z='1.15-0.10*on/${totalFrames}':x='min(iw-(iw/zoom),iw/2-(iw/zoom/2)+18)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${w}x${h}:fps=${fps}[zb]`,
        `[zb]crop=${hw}:${h}:${hw}:0[rb]`,
        `[za][rb]overlay=${hw}:0,fps=${fps}${post}[vout]`,
      ];
      return `ffmpeg -y ${input} -filter_complex "${fc.join(";")}" -map "[vout]" ${outFlags} "${outPath}"`;
    }

    // ─── CHARACTER REVEAL (starts zoomed on face region, reveals full frame) ──
    case "character_reveal": {
      // Start at 3x zoom on upper-center (face area), ease out to full frame
      const fc = [
        `[0:v]${scalePad}[base]`,
        `[base]zoompan=z='max(1.05,3.0-2.0*on/${totalFrames})':x='iw/2-(iw/zoom/2)':y='max(0,ih*0.32-(ih/zoom/2))':d=${totalFrames}:s=${w}x${h}:fps=${fps},fps=${fps},vignette=PI/2.8${post}[vout]`,
      ];
      return `ffmpeg -y ${input} -filter_complex "${fc.join(";")}" -map "[vout]" ${outFlags} "${outPath}"`;
    }

    // ─── VERTICAL WIPE (FIXED - uses shrinking black bar overlay, no zero-height crop) ──
    case "vertical_wipe": {
      const revealDur = Math.max(0.3, duration * 0.65).toFixed(3);
      const fc = [
        `[0:v]${scalePad}[base]`,
        `[base]zoompan=z=1.08:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${w}x${h}:fps=${fps}[img]`,
        // Shrinking black bar that slides down: height goes from h to 2px (safe min)
        `color=c=black:s=${w}x${h}:d=${durPad}:r=${fps}[blackfull]`,
        `[blackfull]crop=w=${w}:h='max(2,${h}-${h}*min(1,t/${revealDur}))':x=0:y=0[mask]`,
        `[img][mask]overlay=0:0,fps=${fps}${post}[vout]`,
      ];
      return `ffmpeg -y ${input} -filter_complex "${fc.join(";")}" -map "[vout]" ${outFlags} "${outPath}"`;
    }

    // ─── SLIDE IN LEFT ─────────────────────────────────────────────────────
    case "slide_in_left": {
      const sf = Math.max(4, Math.floor(totalFrames * 0.4));
      const fc = [
        `[0:v]${scalePad}[base]`,
        `[base]zoompan=z=1.06:x='max(0,iw/2-(iw/zoom/2)-(iw/zoom)*(1-min(1,on/${sf})))':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${w}x${h}:fps=${fps},fps=${fps}${post}[vout]`,
      ];
      return `ffmpeg -y ${input} -filter_complex "${fc.join(";")}" -map "[vout]" ${outFlags} "${outPath}"`;
    }

    // ─── SLIDE IN RIGHT ────────────────────────────────────────────────────
    case "slide_in_right": {
      const sf = Math.max(4, Math.floor(totalFrames * 0.4));
      const fc = [
        `[0:v]${scalePad}[base]`,
        `[base]zoompan=z=1.06:x='min(iw-(iw/zoom),iw/2-(iw/zoom/2)+(iw/zoom)*(1-min(1,on/${sf})))':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${w}x${h}:fps=${fps},fps=${fps}${post}[vout]`,
      ];
      return `ffmpeg -y ${input} -filter_complex "${fc.join(";")}" -map "[vout]" ${outFlags} "${outPath}"`;
    }

    // ─── SLIDE IN TOP ──────────────────────────────────────────────────────
    case "slide_in_top": {
      const sf = Math.max(4, Math.floor(totalFrames * 0.35));
      const fc = [
        `[0:v]${scalePad}[base]`,
        `[base]zoompan=z=1.06:x='iw/2-(iw/zoom/2)':y='max(0,ih/2-(ih/zoom/2)-(ih/zoom)*(1-min(1,on/${sf})))':d=${totalFrames}:s=${w}x${h}:fps=${fps},fps=${fps}${post}[vout]`,
      ];
      return `ffmpeg -y ${input} -filter_complex "${fc.join(";")}" -map "[vout]" ${outFlags} "${outPath}"`;
    }

    // ─── CURTAIN OPEN (FIXED: overlay uses 'n' not 'on') ─────────────────
    case "curtain_open": {
      const rf = Math.max(4, Math.floor(totalFrames * 0.5));
      const hw = Math.floor(w/2);
      const fc = [
        `[0:v]${scalePad}[base]`,
        `[base]split[left_in][right_in]`,
        `[left_in]crop=${hw}:${h}:0:0,zoompan=z=1.06:d=${totalFrames}:s=${hw}x${h}:fps=${fps}[lc]`,
        `[right_in]crop=${hw}:${h}:${hw}:0,zoompan=z=1.06:d=${totalFrames}:s=${hw}x${h}:fps=${fps}[rc]`,
        `color=c=black:s=${w}x${h}:d=${durPad}:r=${fps}[bg]`,
        `[bg][lc]overlay=x='0-${hw}*min(1\\,n/${rf})':y=0[t1]`,
        `[t1][rc]overlay=x='${hw}+${hw}*min(1\\,n/${rf})':y=0,fps=${fps}${post}[vout]`,
      ];
      return `ffmpeg -y ${input} -filter_complex "${fc.join(";")}" -map "[vout]" ${outFlags} "${outPath}"`;
    }

    // ─── SPOTLIGHT ZOOM (face-focused: crops upper-center region) ─────────
    case "spotlight_zoom": {
      const cw = Math.floor(w * 0.52);
      const ch = Math.floor(h * 0.52);
      const sw2 = Math.floor(w * 0.72);
      const sh2 = Math.floor(h * 0.72);
      const cropY = Math.max(0, Math.floor(h * 0.12));
      const fc = [
        `[0:v]${scalePad}[base]`,
        `[base]split[bg_in][fg_in]`,
        `[bg_in]zoompan=z='1.05+0.0006*on':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${w}x${h}:fps=${fps},boxblur=22:6[bg]`,
        `[fg_in]crop=${cw}:${ch}:(iw-${cw})/2:${cropY},zoompan=z='1.0+0.30*on/${totalFrames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${cw}x${ch}:fps=${fps},scale=${sw2}:${sh2}[fg]`,
        `[bg][fg]overlay=x=(W-w)/2:y=(H-h)*3/8,fps=${fps}${post}[vout]`,
      ];
      return `ffmpeg -y ${input} -filter_complex "${fc.join(";")}" -map "[vout]" ${outFlags} "${outPath}"`;
    }

    // ─── PARALLAX ──────────────────────────────────────────────────────────
    case "parallax": {
      const fgW = Math.floor(w * 0.62);
      const fgH = Math.floor(h * 0.62);
      const bgStep = (w * 0.018 / totalFrames).toFixed(5);
      const fgStep = (w * 0.048 / totalFrames).toFixed(5);
      const fc = [
        `[0:v]${scalePad}[base]`,
        `[base]split[bg_in][fg_in]`,
        `[bg_in]zoompan=z=1.12:x='iw/2-(iw/zoom/2)+on*${bgStep}':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${w}x${h}:fps=${fps},smartblur=1.8:0.5:0[bg]`,
        `[fg_in]crop=${fgW}:${fgH}:(iw-${fgW})/2:(ih-${fgH})/2,zoompan=z=1.08:x='iw/2-(iw/zoom/2)+on*${fgStep}':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${fgW}x${fgH}:fps=${fps}[fg]`,
        `[bg][fg]overlay=x=(W-w)/2:y=(H-h)/2,fps=${fps}${post}[vout]`,
      ];
      return `ffmpeg -y ${input} -filter_complex "${fc.join(";")}" -map "[vout]" ${outFlags} "${outPath}"`;
    }

    // ─── RACK FOCUS (face-focused: crops upper region for fg sharpening) ──
    case "rack_focus": {
      const fgW = Math.floor(w * 0.65);
      const fgH = Math.floor(h * 0.65);
      const cropY = Math.max(0, Math.floor(h * 0.08));
      const fc = [
        `[0:v]${scalePad}[base]`,
        `[base]split[bg_in][fg_in]`,
        `[bg_in]zoompan=z='1.08+0.04*on/${totalFrames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${w}x${h}:fps=${fps},boxblur=14:4[bg]`,
        `[fg_in]crop=${fgW}:${fgH}:(iw-${fgW})/2:${cropY},zoompan=z='1.0+0.12*on/${totalFrames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${fgW}x${fgH}:fps=${fps}[fg]`,
        `[bg][fg]overlay=x=(W-w)/2:y=(H-h)*3/8,fps=${fps}${post}[vout]`,
      ];
      return `ffmpeg -y ${input} -filter_complex "${fc.join(";")}" -map "[vout]" ${outFlags} "${outPath}"`;
    }

    // ─── IMPACT FRAME (FIXED: safer flash duration, no format=auto) ──────
    case "impact_frame": {
      const flashF = Math.max(3, Math.floor(totalFrames * 0.15));
      const flashDur = Math.max(0.1, (flashF / fps)).toFixed(3);
      const zoomF  = Math.max(2, totalFrames - flashF);
      const fc = [
        `[0:v]${scalePad}[base]`,
        `[base]zoompan=z='if(lt(on\\,${flashF})\\,2.2\\,max(1.05\\,2.2-1.15*(on-${flashF})/${zoomF}))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${w}x${h}:fps=${fps}[img]`,
        `color=c=white:s=${w}x${h}:d=${durPad}:r=${fps},format=yuva420p,fade=t=out:st=0:d=${flashDur}:alpha=1[flash]`,
        `[img][flash]overlay=0:0:shortest=1,fps=${fps}${post}[vout]`,
      ];
      return `ffmpeg -y ${input} -filter_complex "${fc.join(";")}" -map "[vout]" ${outFlags} "${outPath}"`;
    }

    // ─── BOUNCE ZOOM ───────────────────────────────────────────────────────
    case "bounce_zoom": {
      const fc = [
        `[0:v]${scalePad}[base]`,
        `[base]zoompan=z='1.05+0.28*(1-exp(-3.5*on/${totalFrames}*3.0)*cos(7.5*on/${totalFrames}*3.0))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${w}x${h}:fps=${fps},fps=${fps}${post}[vout]`,
      ];
      return `ffmpeg -y ${input} -filter_complex "${fc.join(";")}" -map "[vout]" ${outFlags} "${outPath}"`;
    }

    // ─── ZOOM BURST ────────────────────────────────────────────────────────
    case "zoom_burst": {
      // Starts tight (2.5x), eases out quickly to 1.05x — feels like pulling back
      const fc = [
        `[0:v]${scalePad}[base]`,
        `[base]zoompan=z='max(1.05,2.5-1.45*pow(on/${totalFrames},0.4))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${w}x${h}:fps=${fps},fps=${fps}${post}[vout]`,
      ];
      return `ffmpeg -y ${input} -filter_complex "${fc.join(";")}" -map "[vout]" ${outFlags} "${outPath}"`;
    }

    // ─── SHOCKWAVE ─────────────────────────────────────────────────────────
    case "shockwave": {
      const fc = [
        `[0:v]${scalePad}[base]`,
        `[base]zoompan=z='1.08+0.12*exp(-6.0*on/${totalFrames})':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${w}x${h}:fps=${fps},fps=${fps},vignette='PI/2*exp(-4*t/${Math.max(0.1,duration).toFixed(2)})+PI/6'${post}[vout]`,
      ];
      return `ffmpeg -y ${input} -filter_complex "${fc.join(";")}" -map "[vout]" ${outFlags} "${outPath}"`;
    }

    // ─── LETTERBOX PAN ─────────────────────────────────────────────────────
    case "letterbox_pan": {
      const barH    = Math.floor(h * 0.115);
      const panStep = (w * 0.055 / totalFrames).toFixed(5);
      const fc = [
        `[0:v]${scalePad}[base]`,
        `[base]zoompan=z=1.18:x='iw/2-(iw/zoom/2)+on*${panStep}':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${w}x${h}:fps=${fps}[panned]`,
        `[panned]drawbox=x=0:y=0:w=${w}:h=${barH}:color=black:t=fill,drawbox=x=0:y=${h-barH}:w=${w}:h=${barH}:color=black:t=fill,fps=${fps}${post}[vout]`,
      ];
      return `ffmpeg -y ${input} -filter_complex "${fc.join(";")}" -map "[vout]" ${outFlags} "${outPath}"`;
    }

    // ─── TILT REVEAL ───────────────────────────────────────────────────────
    case "tilt_reveal": {
      // Starts showing bottom, tilts up to show full/top of image
      const tiltStep = (h * 0.055 / totalFrames).toFixed(5);
      const fc = [
        `[0:v]${scalePad}[base]`,
        `[base]zoompan=z=1.12:x='iw/2-(iw/zoom/2)':y='min(ih-(ih/zoom),max(0,ih-(ih/zoom)-on*${tiltStep}))':d=${totalFrames}:s=${w}x${h}:fps=${fps},fps=${fps}${post}[vout]`,
      ];
      return `ffmpeg -y ${input} -filter_complex "${fc.join(";")}" -map "[vout]" ${outFlags} "${outPath}"`;
    }

    // ─── MIRROR COMPOSITE ──────────────────────────────────────────────────
    case "mirror_composite": {
      const hw = Math.floor(w/2);
      const panStep = (w * 0.012 / totalFrames).toFixed(5);
      const fc = [
        `[0:v]${scalePad}[base]`,
        `[base]split[full][mirror_in]`,
        `[full]zoompan=z=1.06:x='iw/2-(iw/zoom/2)+on*${panStep}':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${w}x${h}:fps=${fps}[bg]`,
        `[mirror_in]crop=${hw}:${h}:0:0,hflip,zoompan=z=1.08:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${hw}x${h}:fps=${fps},format=yuva420p,colorchannelmixer=aa=0.55[mg]`,
        `[bg][mg]overlay=0:0,fps=${fps}${post}[vout]`,
      ];
      return `ffmpeg -y ${input} -filter_complex "${fc.join(";")}" -map "[vout]" ${outFlags} "${outPath}"`;
    }

    // ─── NEON FRAME ────────────────────────────────────────────────────────
    case "neon_frame": {
      const brd = 14;
      const fc = [
        `[0:v]${scalePad}[base]`,
        `[base]zoompan=z='1.05+0.08*on/${totalFrames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${w}x${h}:fps=${fps}[img]`,
        `[img]drawbox=x=0:y=0:w=${w}:h=${brd}:color=0x00ffff@0.9:t=fill,drawbox=x=0:y=${h-brd}:w=${w}:h=${brd}:color=0xff00ff@0.9:t=fill,drawbox=x=0:y=0:w=${brd}:h=${h}:color=0x00ffff@0.9:t=fill,drawbox=x=${w-brd}:y=0:w=${brd}:h=${h}:color=0xff00ff@0.9:t=fill,fps=${fps}${post}[vout]`,
      ];
      return `ffmpeg -y ${input} -filter_complex "${fc.join(";")}" -map "[vout]" ${outFlags} "${outPath}"`;
    }

    // ─── VHS COMPOSITE ─────────────────────────────────────────────────────
    case "vhs_composite": {
      const fc = [
        `[0:v]${scalePad}[base]`,
        `[base]zoompan=z=1.05:x='iw/2-(iw/zoom/2)+3*sin(on*0.7)':y='ih/2-(ih/zoom/2)+2*sin(on*0.4+1.2)':d=${totalFrames}:s=${w}x${h}:fps=${fps},rgbashift=rh=2:rv=0:gh=-1:gv=1:bh=-2:bv=0,noise=alls=10:allf=t+u,drawgrid=width=0:height=4:thickness=1:color=black@0.22,fps=${fps}${post}[vout]`,
      ];
      return `ffmpeg -y ${input} -filter_complex "${fc.join(";")}" -map "[vout]" ${outFlags} "${outPath}"`;
    }

    default:
      return null;
  }
}

module.exports = {
  COMPOSITIONS,
  COMPOSITION_CATEGORIES,
  buildCompositionCmd,
};
