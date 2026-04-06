/**
 * animationContract.js — Shared Animation System
 *
 * Single source of truth for all animation math.
 * Used by:
 *   1. compositionEngine.js  — generates FFmpeg filter expressions
 *   2. frontend (via /api/amv/animation-contract endpoint) — drives timeline preview
 *
 * ANIMATION CONTRACT FORMAT:
 * {
 *   id:        string,           // composition name
 *   duration:  number,           // scene duration in seconds (dynamic)
 *   layers: [
 *     {
 *       type:      "zoom" | "translate" | "cover" | "overlay",
 *       target:    "main" | "bg" | "fg" | "panel_0" | etc,
 *       startTime: number,        // seconds from scene start
 *       duration:  number,        // animation duration in seconds
 *       easing:    "easeOutCubic" | "easeInCubic" | "easeInOutCubic" | "linear" | "spring",
 *       from:      { x, y, scale, opacity, width, height },
 *       to:        { x, y, scale, opacity, width, height },
 *     }
 *   ]
 * }
 *
 * EASING FUNCTIONS — identical in JS and FFmpeg expressions:
 *
 * In JS (timeline preview):
 *   easeOutCubic(p)    = 1 - (1-p)^3
 *   easeInCubic(p)     = p^3
 *   easeInOutCubic(p)  = p<0.5 ? 4p^3 : 1-(-2p+2)^3/2
 *   spring(p)          = 1 - exp(-6p)*cos(12p)
 *
 * In FFmpeg (overlay x/y, t-based):
 *   p(t,S,D) = min(1,max(0,(t-S)/D))
 *   easeOutCubic:   (1-(1-p)*(1-p)*(1-p))
 *   easeInCubic:    (p*p*p)
 *   easeInOutCubic: (p<0.5?4*p*p*p:1-pow(-2*p+2,3)/2)
 *   spring:         (1-exp(-6*p)*cos(12*p))
 *
 * In FFmpeg zoompan z= (on-based, zoompan has no 't'):
 *   p = on/totalFrames
 *   Same easing formulas, substitute 'on/tf' for p.
 *
 * KEY RULE: zoompan's z= expression can ONLY use 'on' (frame number).
 * All overlay x/y expressions MUST use 't' (time in seconds).
 * These are the same normalized 0-1 progress — just different variable names.
 */

"use strict";

// ─── JS EASING FUNCTIONS (for timeline preview) ─────────────────────────────

const Easing = {
  easeOutCubic:   p => 1 - Math.pow(1 - Math.min(1, Math.max(0, p)), 3),
  easeInCubic:    p => Math.pow(Math.min(1, Math.max(0, p)), 3),
  easeInOutCubic: p => {
    p = Math.min(1, Math.max(0, p));
    return p < 0.5 ? 4*p*p*p : 1 - Math.pow(-2*p+2, 3)/2;
  },
  spring:         p => {
    p = Math.min(1, Math.max(0, p));
    return 1 - Math.exp(-6*p) * Math.cos(12*p);
  },
  linear:         p => Math.min(1, Math.max(0, p)),
};

// Interpolate from→to using easing at normalized progress p
function lerp(from, to, p, easingName) {
  return from + (to - from) * Easing[easingName || "easeOutCubic"](p);
}

// Compute animated value at time t given a layer spec
function valueAtTime(layer, t, prop) {
  const p = Math.min(1, Math.max(0, (t - layer.startTime) / layer.duration));
  const from = layer.from[prop] ?? 0;
  const to   = layer.to[prop]   ?? 0;
  return lerp(from, to, p, layer.easing);
}

// ─── FFmpeg EXPRESSION BUILDERS ─────────────────────────────────────────────

// Progress expression in FFmpeg t-space
function ffP(startSec, durSec) {
  return `min(1,max(0,(t-${startSec.toFixed(4)})/${durSec.toFixed(4)}))`;
}

// Easing expressions (return FFmpeg expression string)
const ffEasing = {
  easeOutCubic:   (S, D) => { const p = ffP(S,D); return `(1-(1-${p})*(1-${p})*(1-${p}))`; },
  easeInCubic:    (S, D) => { const p = ffP(S,D); return `(${p}*${p}*${p})`; },
  easeInOutCubic: (S, D) => { const p = ffP(S,D); return `(${p}<0.5?4*${p}*${p}*${p}:1-pow(-2*${p}+2,3)/2)`; },
  spring:         (S, D) => { const p = ffP(S,D); return `(1-exp(-6*${p})*cos(12*${p}))`; },
  linear:         (S, D) => ffP(S, D),
};

// Lerp in FFmpeg expression space
function ffLerp(from, to, easingExpr) {
  const delta = to - from;
  if (delta === 0) return from.toFixed(3);
  return `(${from.toFixed(3)}+${delta.toFixed(3)}*${easingExpr})`;
}

// Build FFmpeg overlay x or y expression from a layer spec
function ffOverlayExpr(layer, prop) {
  const ease = ffEasing[layer.easing || "easeOutCubic"](layer.startTime, layer.duration);
  return ffLerp(layer.from[prop] ?? 0, layer.to[prop] ?? 0, ease);
}

// Build zoompan z= expression from a layer spec (uses on/tf, not t)
function ffZoomExpr(layer, totalFrames) {
  const zFrom = layer.from.scale ?? 1.0;
  const zTo   = layer.to.scale ?? 1.0;
  if (zFrom === zTo) return zFrom.toFixed(4);
  const tf = totalFrames;
  const zMin = Math.min(zFrom, zTo).toFixed(4);
  const zMax = Math.max(zFrom, zTo).toFixed(4);
  const delta = (zTo - zFrom).toFixed(6);
  // easeInOutCubic in frame space (on/tf)
  const p = `on/${tf}`;
  const ease = `(${p}<0.5?4*${p}*${p}*${p}:1-pow(-2*${p}+2,3)/2)`;
  return `min(${zMax},max(${zMin},${zFrom.toFixed(4)}+${delta}*${ease}))`;
}

// ─── COMPOSITION CONTRACT DEFINITIONS ────────────────────────────────────────
// These define animation intent. compositionEngine.js reads these to build FFmpeg.
// Frontend reads these (via API) to drive timeline preview canvas.

function getContracts(dur, fps, w, h) {
  const tf = Math.max(4, Math.round(dur * fps));
  // Swipe duration: 38% of scene or 0.45s max
  const swD = Math.min(0.45, dur * 0.38);
  // Open/reveal duration: 50% of scene or 0.7s max
  const opD = Math.min(0.70, dur * 0.50);
  const rvD = Math.min(1.0,  dur * 0.65);

  return {

    // ── SINGLE IMAGE ────────────────────────────────────────────────────────

    three_panel: {
      desc: "3 vertical strips, each crops its correct third, uniform zoom-in",
      layers: [
        { type:"zoom", target:"panel_0", startTime:0, duration:dur, easing:"easeInOutCubic", from:{scale:1.00}, to:{scale:1.10} },
        { type:"zoom", target:"panel_1", startTime:0, duration:dur, easing:"easeInOutCubic", from:{scale:1.00}, to:{scale:1.10} },
        { type:"zoom", target:"panel_2", startTime:0, duration:dur, easing:"easeInOutCubic", from:{scale:1.00}, to:{scale:1.10} },
      ]
    },

    film_strip: {
      desc: "2 halves pan same direction, top 2× speed of bottom — parallax depth",
      layers: [
        { type:"translate", target:"top_half",    startTime:0, duration:dur, easing:"linear", from:{x:0}, to:{x: Math.floor(w*0.06)} },
        { type:"translate", target:"bottom_half", startTime:0, duration:dur, easing:"linear", from:{x:0}, to:{x: Math.floor(w*0.03)} },
      ]
    },

    quad_grid: {
      desc: "4 quadrants each crop correct quarter, uniform zoom-in",
      layers: [
        { type:"zoom", target:"panel_0", startTime:0, duration:dur, easing:"easeInOutCubic", from:{scale:1.00}, to:{scale:1.08} },
        { type:"zoom", target:"panel_1", startTime:0, duration:dur, easing:"easeInOutCubic", from:{scale:1.00}, to:{scale:1.08} },
        { type:"zoom", target:"panel_2", startTime:0, duration:dur, easing:"easeInOutCubic", from:{scale:1.00}, to:{scale:1.08} },
        { type:"zoom", target:"panel_3", startTime:0, duration:dur, easing:"easeInOutCubic", from:{scale:1.00}, to:{scale:1.08} },
      ]
    },

    diagonal_split: {
      desc: "Left pans left while zooming, right pans right — diverging tension",
      layers: [
        { type:"zoom",      target:"left",  startTime:0, duration:dur, easing:"easeOutCubic", from:{scale:1.00}, to:{scale:1.08} },
        { type:"zoom",      target:"right", startTime:0, duration:dur, easing:"easeOutCubic", from:{scale:1.00}, to:{scale:1.08} },
        { type:"translate", target:"left",  startTime:0, duration:dur, easing:"linear", from:{x:0}, to:{x:-Math.floor(w*0.05)} },
        { type:"translate", target:"right", startTime:0, duration:dur, easing:"linear", from:{x:0}, to:{x: Math.floor(w*0.05)} },
      ]
    },

    character_reveal: {
      desc: "Punch-zoom 3× → 1.05×, face anchor, easeOutCubic",
      layers: [
        { type:"zoom", target:"main", startTime:0, duration:dur, easing:"easeOutCubic", from:{scale:3.0}, to:{scale:1.05} },
      ]
    },

    vertical_wipe: {
      desc: "Black cover shrinks downward — easeOutCubic reveal",
      layers: [
        { type:"zoom",  target:"main",  startTime:0, duration:dur, easing:"easeInOutCubic", from:{scale:1.04}, to:{scale:1.10} },
        { type:"cover", target:"cover", startTime:0, duration:rvD, easing:"easeOutCubic", from:{height:h}, to:{height:0} },
      ]
    },

    swipe_in_left: {
      desc: "Element enters from x=-w, settles at 0 — easeOutCubic",
      layers: [
        { type:"zoom",      target:"main", startTime:0, duration:dur,  easing:"easeInOutCubic", from:{scale:1.0}, to:{scale:1.06} },
        { type:"translate", target:"main", startTime:0, duration:swD,  easing:"easeOutCubic",   from:{x:-w},     to:{x:0} },
      ]
    },

    swipe_in_right: {
      desc: "Element enters from x=+w, settles at 0 — easeOutCubic",
      layers: [
        { type:"zoom",      target:"main", startTime:0, duration:dur,  easing:"easeInOutCubic", from:{scale:1.0}, to:{scale:1.06} },
        { type:"translate", target:"main", startTime:0, duration:swD,  easing:"easeOutCubic",   from:{x:w},      to:{x:0} },
      ]
    },

    swipe_in_top: {
      desc: "Element enters from y=-h, settles at 0 — easeOutCubic",
      layers: [
        { type:"zoom",      target:"main", startTime:0, duration:dur,  easing:"easeInOutCubic", from:{scale:1.0}, to:{scale:1.06} },
        { type:"translate", target:"main", startTime:0, duration:swD,  easing:"easeOutCubic",   from:{y:-h},     to:{y:0} },
      ]
    },

    curtain_open: {
      desc: "Left curtain exits left, right exits right — easeOutCubic",
      layers: [
        { type:"zoom",      target:"main",     startTime:0, duration:dur, easing:"easeInOutCubic", from:{scale:1.02}, to:{scale:1.08} },
        { type:"translate", target:"curtain_l", startTime:0, duration:opD, easing:"easeOutCubic",   from:{x:0},             to:{x:-Math.floor(w/2)} },
        { type:"translate", target:"curtain_r", startTime:0, duration:opD, easing:"easeOutCubic",   from:{x:Math.floor(w/2)}, to:{x:w} },
      ]
    },

    spotlight_zoom: {
      desc: "Blurred bg + sharp fg zooms in — two stream depth",
      layers: [
        { type:"zoom", target:"bg", startTime:0, duration:dur, easing:"easeInOutCubic", from:{scale:1.02}, to:{scale:1.06} },
        { type:"zoom", target:"fg", startTime:0, duration:dur, easing:"easeOutCubic",   from:{scale:1.00}, to:{scale:1.35} },
      ]
    },

    parallax: {
      desc: "BG pans 6%, FG pans 14% — same direction, different speed = depth",
      layers: [
        { type:"translate", target:"bg", startTime:0, duration:dur, easing:"linear", from:{x:0}, to:{x:Math.floor(w*0.06)} },
        { type:"translate", target:"fg", startTime:0, duration:dur, easing:"linear", from:{x:0}, to:{x:Math.floor(w*0.14)} },
      ]
    },

    rack_focus: {
      desc: "Blurred bg slow zoom + sharp fg zoom-in",
      layers: [
        { type:"zoom", target:"bg", startTime:0, duration:dur, easing:"easeInOutCubic", from:{scale:1.04}, to:{scale:1.10} },
        { type:"zoom", target:"fg", startTime:0, duration:dur, easing:"easeOutCubic",   from:{scale:1.00}, to:{scale:1.14} },
      ]
    },

    impact_frame: {
      desc: "White flash fades first 15%, punch-zoom 2.2× → 1.05× easeOutCubic",
      layers: [
        { type:"zoom",    target:"main",  startTime:0,            duration:dur,                easing:"easeOutCubic", from:{scale:2.2}, to:{scale:1.05} },
        { type:"overlay", target:"flash", startTime:0,            duration:Math.floor(tf*0.15)/fps, easing:"linear", from:{opacity:1}, to:{opacity:0} },
      ]
    },

    bounce_zoom: {
      desc: "Damped spring: z = 1.05 + 0.28*(1 - exp(-6p)*cos(12p))",
      layers: [
        { type:"zoom", target:"main", startTime:0, duration:dur, easing:"spring", from:{scale:1.05}, to:{scale:1.33} },
      ]
    },

    zoom_burst: {
      desc: "Fast zoom-in 2.5× → 1.05×, power(0.4) deceleration",
      layers: [
        { type:"zoom", target:"main", startTime:0, duration:dur, easing:"easeOutCubic", from:{scale:2.5}, to:{scale:1.05} },
      ]
    },

    shockwave: {
      desc: "Exponential decay zoom + vignette pulse",
      layers: [
        { type:"zoom", target:"main", startTime:0, duration:dur, easing:"easeOutCubic", from:{scale:1.23}, to:{scale:1.05} },
      ]
    },

    letterbox_pan: {
      desc: "2.35:1 bars + horizontal camera pan 12% of width",
      layers: [
        { type:"translate", target:"main", startTime:0, duration:dur, easing:"linear", from:{x:0}, to:{x:Math.floor(w*0.12)} },
      ]
    },

    tilt_reveal: {
      desc: "Camera tilts upward — pan y from bottom to top",
      layers: [
        { type:"translate", target:"main", startTime:0, duration:dur, easing:"linear", from:{y:Math.floor(h*0.12)}, to:{y:0} },
      ]
    },

    mirror_composite: {
      desc: "BG pans, flipped left-half ghost at 55% opacity fixed",
      layers: [
        { type:"translate", target:"bg",    startTime:0, duration:dur, easing:"linear", from:{x:0}, to:{x:Math.floor(w*0.06)} },
        { type:"overlay",   target:"ghost", startTime:0, duration:dur, easing:"linear", from:{opacity:0.55}, to:{opacity:0.55} },
      ]
    },

    neon_frame: {
      desc: "Slow zoom-in + static cyan/magenta border",
      layers: [
        { type:"zoom", target:"main", startTime:0, duration:dur, easing:"easeInOutCubic", from:{scale:1.0}, to:{scale:1.08} },
      ]
    },

    vhs_composite: {
      desc: "Sinusoidal jitter + chromatic shift + noise + scanlines",
      layers: [
        { type:"zoom", target:"main", startTime:0, duration:dur, easing:"linear", from:{scale:1.05}, to:{scale:1.05} },
      ]
    },

    // ── MULTI IMAGE ─────────────────────────────────────────────────────────

    beat_stack_3: {
      desc: "3 strips slide up from y=h to slot on successive beats",
      multiImage: true,
      layers: (beats) => [
        { type:"translate", target:"strip_0", startTime:beats[0]||0,   duration:0.28, easing:"easeOutCubic", from:{y:h}, to:{y:0} },
        { type:"translate", target:"strip_1", startTime:beats[1]||0.3, duration:0.28, easing:"easeOutCubic", from:{y:h}, to:{y:Math.floor(h/3)+2} },
        { type:"translate", target:"strip_2", startTime:beats[2]||0.6, duration:0.28, easing:"easeOutCubic", from:{y:h}, to:{y:Math.floor(h/3)*2+4} },
      ]
    },

    triptych_reveal: {
      desc: "3 panels reveal downward from 0 height to full on successive beats",
      multiImage: true,
      layers: (beats) => [
        { type:"cover", target:"panel_0", startTime:beats[0]||0,   duration:0.38, easing:"easeOutCubic", from:{height:0}, to:{height:h} },
        { type:"cover", target:"panel_1", startTime:beats[1]||0.3, duration:0.38, easing:"easeOutCubic", from:{height:0}, to:{height:h} },
        { type:"cover", target:"panel_2", startTime:beats[2]||0.6, duration:0.38, easing:"easeOutCubic", from:{height:0}, to:{height:h} },
      ]
    },

    door_open: {
      desc: "Left panel x: 0→-w/2, right panel x: w/2→w — reveals bg",
      multiImage: true,
      layers: [
        { type:"zoom",      target:"bg",       startTime:0, duration:dur, easing:"easeInOutCubic", from:{scale:1.0}, to:{scale:1.06} },
        { type:"translate", target:"door_left", startTime:0, duration:opD, easing:"easeOutCubic",   from:{x:0},              to:{x:-Math.floor(w/2)} },
        { type:"translate", target:"door_right",startTime:0, duration:opD, easing:"easeOutCubic",   from:{x:Math.floor(w/2)},to:{x:w} },
      ]
    },

    photo_wall_sweep: {
      desc: "2×2 grid wall panned left→right at constant speed",
      multiImage: true,
      layers: [
        { type:"translate", target:"wall", startTime:0, duration:dur, easing:"linear", from:{x:0}, to:{x:Math.max(0, Math.floor(w*0.55)*2+8-w)} },
      ]
    },

    cinematic_duo: {
      desc: "Top 35% face zoom + bottom 65% wide zoom — independent",
      multiImage: true,
      layers: [
        { type:"zoom", target:"top_slot", startTime:0, duration:dur, easing:"easeInOutCubic", from:{scale:1.0}, to:{scale:1.06} },
        { type:"zoom", target:"bot_slot", startTime:0, duration:dur, easing:"easeInOutCubic", from:{scale:1.0}, to:{scale:1.08} },
      ]
    },

    pip_corner: {
      desc: "BG breathe zoom + PIP slides from x=w to corner on first beat",
      multiImage: true,
      layers: (beats) => [
        { type:"zoom",      target:"bg",  startTime:0,             duration:dur,  easing:"spring",       from:{scale:1.04}, to:{scale:1.10} },
        { type:"translate", target:"pip", startTime:beats[0]||0.3, duration:0.30, easing:"easeOutCubic", from:{x:w}, to:{x:w - Math.floor(w*0.30) - 20} },
      ]
    },

    cross_reveal: {
      desc: "Left from x=-hw→0, right from x=w-hw→hw+gap — simultaneous",
      multiImage: true,
      layers: [
        { type:"translate", target:"left",  startTime:0, duration:Math.min(dur*0.5, 0.55), easing:"easeOutCubic", from:{x:-Math.floor(w/2)}, to:{x:0} },
        { type:"translate", target:"right", startTime:0, duration:Math.min(dur*0.5, 0.55), easing:"easeOutCubic", from:{x:w - Math.floor(w/2)}, to:{x:Math.floor(w/2)+4} },
      ]
    },

  };
}

module.exports = { Easing, lerp, valueAtTime, ffP, ffEasing, ffLerp, ffOverlayExpr, ffZoomExpr, getContracts };