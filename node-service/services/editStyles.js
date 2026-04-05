/**
 * Edit Styles v1.0 — User-Controlled Creative Intent
 *
 * Instead of letting the ML guess the edit "feel" from audio alone,
 * the user picks one of 5 edit styles. The style overrides effect,
 * transition, grade, overlay, and composition selection for EVERY scene —
 * regardless of what the beat detector says the emotion is.
 *
 * This solves the core problem: the detector sees "hype" on a fast song,
 * but the user may want a slow cinematic AMV with that same song.
 *
 * STYLES:
 *   hard_cut        — every beat hits hard. Flash cuts, snap zooms, glitch.
 *   cinematic       — epic and wide. Cross-zooms, letterbox, gold grades.
 *   smooth_flow     — gentle and fluid. Breathe effects, dissolves, soft grades.
 *   emotional       — slow and melancholic. Drift, fade, blue/grey grades.
 *   aesthetic       — stylized and dreamy. Romantic grades, glow overlays, soft pans.
 *
 * Each style defines:
 *   - effects[]         ranked list of motion effects (zoompan)
 *   - transitions[]     ranked list of xfade transitions
 *   - grades[]          ranked list of color grades
 *   - overlays[]        ranked list of overlays
 *   - compositions{}    which compositions map to which song sections
 *   - cutSpeed          "fast" | "medium" | "slow" — controls scene duration limits
 *   - transitionDur     base transition overlap in seconds
 *   - minSceneDur       minimum scene duration in seconds
 *   - maxSceneDur       maximum scene duration in seconds
 *   - stutterCuts       whether to allow stutter micro-cuts
 *   - dropMergeGap      minimum seconds between scene boundaries (merges dense drops)
 */

"use strict";

// ─── STYLE DEFINITIONS ────────────────────────────────────────────────────────

const EDIT_STYLES = {

  // ── 1. HARD CUT ─────────────────────────────────────────────────────────────
  // Every beat is a weapon. Flash cuts, snap zooms, glitch transitions.
  // Best for: battle AMVs, hype reels, EDM, trap, drum & bass.
  hard_cut: {
    label:       "⚡ Hard Cut",
    description: "Every beat hits. Flash cuts, snap zooms, glitch — full aggression.",
    icon:        "⚡",
    cutSpeed:    "fast",
    minSceneDur: 0.5,
    maxSceneDur: 3.0,
    transitionDur: 0.04,
    stutterCuts: true,
    dropMergeGap: 0.0,   // use every drop as-is, no merging

    effects: [
      "zoom_punch", "shake_horizontal", "zoom_pulse", "glitch_flash",
      "glitch_horizontal", "zoom_punch_out", "speed_ramp_in", "vhs_shake",
      "breathe_fast", "zoom_in",
    ],
    transitions: [
      "flash_black", "glitch_cut", "whip_pan_left", "flash_white",
      "strobe_cut", "whip_pan_right", "slice_left", "film_burn",
      "fadeblack_fast", "slice_right",
    ],
    grades: [
      "hype_red", "hype_blue", "neon", "cinematic", "hype_green",
    ],
    overlays: [
      "vignette", "chromatic_aberration", "scanlines", "speed_lines", "film_grain",
    ],
    compositions: {
      INTRO:    ["slide_in_left", "character_reveal", "slide_in_top"],
      VERSE_1:  ["impact_frame", "manga_panels", "diagonal_split"],
      CHORUS_1: ["shockwave", "zoom_burst", "three_panel", "bounce_zoom"],
      BRIDGE:   ["neon_frame", "vhs_composite", "mirror_composite"],
      CHORUS_2: ["zoom_burst", "shockwave", "quad_grid", "impact_frame"],
      CLIMAX:   ["shockwave", "impact_frame", "zoom_burst", "bounce_zoom", "three_panel"],
      OUTRO:    ["slide_in_left", "character_reveal"],
    },
  },

  // ── 2. CINEMATIC ────────────────────────────────────────────────────────────
  // Wide, epic, graded. Cuts on big drops only. Gold/teal colour science.
  // Best for: AMV trailers, tribute edits, orchestral, cinematic J-pop.
  cinematic: {
    label:       "🎬 Cinematic",
    description: "Epic and wide. Cuts only on big drops. Gold grades, letterbox, cross-zooms.",
    icon:        "🎬",
    cutSpeed:    "medium",
    minSceneDur: 1.5,
    maxSceneDur: 6.0,
    transitionDur: 0.18,
    stutterCuts: false,
    dropMergeGap: 1.2,  // merge drops closer than 1.2s — only keep big structural drops

    effects: [
      "ken_burns_fast", "zoom_out", "pan_right", "zoom_in", "ken_burns",
      "tilt_shift", "drift_right", "freeze_punch", "speed_ramp_out", "spin_cw",
    ],
    transitions: [
      "cross_zoom", "zoom_blur_in", "flash_black", "dissolve_fast",
      "whip_pan_right", "push_right", "film_burn", "wipe_down",
    ],
    grades: [
      "triumphant_gold", "cinematic", "teal_orange", "cold_steel",
      "sunset_gold", "none",
    ],
    overlays: [
      "vignette", "lens_flare", "film_grain", "particles",
    ],
    compositions: {
      INTRO:    ["letterbox_pan", "tilt_reveal", "rack_focus"],
      VERSE_1:  ["letterbox_pan", "parallax", "rack_focus", "tilt_reveal"],
      CHORUS_1: ["impact_frame", "zoom_burst", "bounce_zoom", "shockwave"],
      BRIDGE:   ["spotlight_zoom", "parallax", "rack_focus"],
      CHORUS_2: ["zoom_burst", "impact_frame", "shockwave", "bounce_zoom"],
      CLIMAX:   ["shockwave", "zoom_burst", "impact_frame", "bounce_zoom"],
      OUTRO:    ["letterbox_pan", "tilt_reveal", "rack_focus", "parallax"],
    },
  },

  // ── 3. SMOOTH FLOW ──────────────────────────────────────────────────────────
  // Fluid and continuous. Soft transitions, gentle motion, warm grades.
  // Best for: lofi AMV, chill edits, slice-of-life anime, acoustic songs.
  smooth_flow: {
    label:       "🌊 Smooth Flow",
    description: "Fluid and gentle. Soft dissolves, breathe effects, warm and natural grades.",
    icon:        "🌊",
    cutSpeed:    "medium",
    minSceneDur: 1.5,
    maxSceneDur: 6.0,
    transitionDur: 0.28,
    stutterCuts: false,
    dropMergeGap: 1.5,

    effects: [
      "breathe", "ken_burns", "pan_right", "drift_right", "breathe_slow",
      "zoom_in", "pan_left", "drift_left", "tilt_shift", "zoom_out",
    ],
    transitions: [
      "dissolve", "dissolve_glow", "cross_zoom", "push_right",
      "fadewhite", "dissolve_fast", "ripple", "push_left",
    ],
    grades: [
      "romantic_warm", "cinematic", "vintage", "none",
      "sunset_gold", "romantic_soft",
    ],
    overlays: [
      "vignette", "film_grain", "particles", "lens_flare",
    ],
    compositions: {
      INTRO:    ["slide_in_left", "rack_focus", "letterbox_pan"],
      VERSE_1:  ["parallax", "rack_focus", "letterbox_pan", "slide_in_right"],
      CHORUS_1: ["three_panel", "bounce_zoom", "impact_frame", "manga_panels"],
      BRIDGE:   ["spotlight_zoom", "parallax", "mirror_composite"],
      CHORUS_2: ["bounce_zoom", "three_panel", "impact_frame"],
      CLIMAX:   ["impact_frame", "bounce_zoom", "shockwave"],
      OUTRO:    ["letterbox_pan", "parallax", "rack_focus"],
    },
  },

  // ── 4. EMOTIONAL ────────────────────────────────────────────────────────────
  // Slow and melancholic. Long holds, drift effects, blue/grey grades.
  // Best for: sad AMVs, character tributes, endings, slow ballads.
  emotional: {
    label:       "💙 Emotional",
    description: "Slow and melancholic. Long holds, gentle drifts, blue and grey colour grading.",
    icon:        "💙",
    cutSpeed:    "slow",
    minSceneDur: 2.0,
    maxSceneDur: 7.0,
    transitionDur: 0.40,
    stutterCuts: false,
    dropMergeGap: 2.0,  // only keep drops 2s+ apart — very sparse cuts

    effects: [
      "ken_burns_slow", "breathe_slow", "drift_left", "echo_trail",
      "drift_right", "static", "pan_left", "tilt_shift", "zoom_out", "ken_burns",
    ],
    transitions: [
      "dissolve_slow", "dissolve_glow", "fadeblack_slow", "dissolve",
      "fadeblack", "ripple", "zoom_blur_out", "push_left",
    ],
    grades: [
      "sad_blue", "sad_grey", "vintage", "cinematic", "cold_steel", "none",
    ],
    overlays: [
      "vignette_strong", "film_grain", "rain", "vignette", "particles",
    ],
    compositions: {
      INTRO:    ["rack_focus", "letterbox_pan", "tilt_reveal"],
      VERSE_1:  ["parallax", "rack_focus", "letterbox_pan", "tilt_reveal"],
      CHORUS_1: ["spotlight_zoom", "impact_frame", "bounce_zoom"],
      BRIDGE:   ["mirror_composite", "vhs_composite", "spotlight_zoom"],
      CHORUS_2: ["impact_frame", "bounce_zoom", "shockwave"],
      CLIMAX:   ["impact_frame", "shockwave", "zoom_burst"],
      OUTRO:    ["letterbox_pan", "parallax", "rack_focus", "tilt_reveal"],
    },
  },

  // ── 5. AESTHETIC ────────────────────────────────────────────────────────────
  // Dreamy and stylized. Romantic grades, glow overlays, soft pans, artistic.
  // Best for: aesthetic edits, romance AMVs, lo-fi, art-house, idol edits.
  aesthetic: {
    label:       "✨ Aesthetic",
    description: "Dreamy and artistic. Soft pans, glow overlays, romantic and pastel colour grades.",
    icon:        "✨",
    cutSpeed:    "medium",
    minSceneDur: 1.8,
    maxSceneDur: 6.0,
    transitionDur: 0.32,
    stutterCuts: false,
    dropMergeGap: 1.8,

    effects: [
      "breathe_slow", "ken_burns_slow", "drift_right", "echo_trail",
      "pan_right", "breathe", "drift_left", "zoom_out", "tilt_shift", "ken_burns",
    ],
    transitions: [
      "dissolve_glow", "fadewhite", "dissolve", "dissolve_slow",
      "cross_zoom", "ripple", "zoom_blur_in", "push_right",
    ],
    grades: [
      "romantic_soft", "romantic_warm", "anime_bright", "glow_soft",
      "vintage", "triumphant_gold", "none",
    ],
    overlays: [
      "vignette", "particles", "lens_flare", "film_grain", "snow",
    ],
    compositions: {
      INTRO:    ["slide_in_left", "tilt_reveal", "rack_focus"],
      VERSE_1:  ["parallax", "letterbox_pan", "rack_focus", "tilt_reveal"],
      CHORUS_1: ["three_panel", "bounce_zoom", "spotlight_zoom", "manga_panels"],
      BRIDGE:   ["neon_frame", "spotlight_zoom", "mirror_composite"],
      CHORUS_2: ["bounce_zoom", "three_panel", "zoom_burst"],
      CLIMAX:   ["zoom_burst", "impact_frame", "shockwave", "bounce_zoom"],
      OUTRO:    ["letterbox_pan", "parallax", "tilt_reveal", "rack_focus"],
    },
  },
};

// ─── STYLE REGISTRY ───────────────────────────────────────────────────────────

const EDIT_STYLE_IDS = Object.keys(EDIT_STYLES);
const DEFAULT_STYLE  = "cinematic";

/**
 * Get a style definition by ID.
 * Falls back to cinematic if the ID is unknown.
 */
function getEditStyle(styleId) {
  return EDIT_STYLES[styleId] || EDIT_STYLES[DEFAULT_STYLE];
}

/**
 * Pick an effect from the style's pool using scene index for variety.
 * Avoids repeating the same effect in adjacent scenes.
 */
function pickStyleEffect(style, sceneIdx, recentEffects = []) {
  const pool = style.effects;
  const available = pool.filter(e => !recentEffects.includes(e));
  const candidates = available.length > 0 ? available : pool;
  return candidates[sceneIdx % candidates.length];
}

/**
 * Pick a transition from the style's pool.
 */
function pickStyleTransition(style, sceneIdx, recentTransitions = []) {
  if (sceneIdx === 0) return "dissolve"; // always dissolve on first scene
  const pool = style.transitions;
  const available = pool.filter(t => !recentTransitions.includes(t));
  const candidates = available.length > 0 ? available : pool;
  return candidates[sceneIdx % candidates.length];
}

/**
 * Pick a color grade from the style's pool.
 * High-energy scenes (dropStrength > 0.6) pull from top of pool.
 * Low-energy scenes pull from bottom (subtler grades).
 */
function pickStyleGrade(style, sceneIdx, dropStrength = 0.5, recentGrades = []) {
  const pool = style.grades;
  const intensity = dropStrength;
  let slice;
  if (intensity > 0.65)      slice = pool.slice(0, Math.ceil(pool.length * 0.5));
  else if (intensity > 0.35) slice = pool.slice(1, pool.length - 1).length > 0 ? pool.slice(1, pool.length - 1) : pool;
  else                       slice = pool.slice(Math.floor(pool.length * 0.5));
  const available = slice.filter(g => !recentGrades.includes(g));
  const candidates = available.length > 0 ? available : slice;
  return candidates[sceneIdx % candidates.length] || "none";
}

/**
 * Pick overlays from the style's pool based on drop strength.
 */
function pickStyleOverlays(style, dropStrength = 0.5) {
  const pool = style.overlays;
  const result = [pool[0]]; // always first (usually vignette)
  if (dropStrength > 0.5 && pool.length > 1)  result.push(pool[1]);
  if (dropStrength > 0.75 && pool.length > 2) result.push(pool[2]);
  return result.filter(Boolean);
}

/**
 * Pick a composition from the style's composition map for a given song section.
 * Falls back to VERSE_1 pool if the section isn't mapped.
 */
function pickStyleComposition(style, section, sceneIdx, recentComps = []) {
  const sectionChance = {
    INTRO: 1.0, OUTRO: 1.0, CLIMAX: 0.90,
    CHORUS_1: 0.80, CHORUS_2: 0.85,
    BRIDGE: 0.65, VERSE_1: 0.55,
  };

  const chance = sectionChance[section] ?? 0.55;
  // Deterministic pseudo-random from scene index
  const pr = ((sceneIdx * 2654435761) >>> 0) / 4294967296;
  if (pr > chance && section !== "INTRO" && section !== "OUTRO") return null;

  const pool     = style.compositions[section] || style.compositions.VERSE_1 || [];
  const available = pool.filter(c => !recentComps.includes(c));
  const candidates = available.length > 0 ? available : pool;
  if (!candidates.length) return null;
  return candidates[sceneIdx % candidates.length];
}

// ─── EXPORTS ──────────────────────────────────────────────────────────────────

module.exports = {
  EDIT_STYLES,
  EDIT_STYLE_IDS,
  DEFAULT_STYLE,
  getEditStyle,
  pickStyleEffect,
  pickStyleTransition,
  pickStyleGrade,
  pickStyleOverlays,
  pickStyleComposition,
};