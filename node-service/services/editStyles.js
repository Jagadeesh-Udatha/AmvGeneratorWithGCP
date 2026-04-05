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
  // DISTINCT FROM: Emotional (no drift/echo, uses breathe+pan not drift+static)
  //                Aesthetic (no glow/particles/lens_flare, warmer grades)
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
      "breathe",        // sinusoidal zoom — characteristic smooth flow effect
      "pan_right",      // horizontal pan — movement without zoom
      "ken_burns",      // classic slow zoom + diagonal pan
      "breathe_slow",   // slower sinusoidal — calm moments
      "zoom_in",        // simple linear zoom
      "pan_left",       // pan opposite direction for variety
      "zoom_out",       // pull back for wide shots
      "ken_burns_fast", // faster ken burns at chorus peaks
      "tilt_shift",     // cinematic depth of field feel
      "spin_cw",        // gentle circular pan for high-energy moments
    ],
    transitions: [
      "dissolve",       // standard clean dissolve
      "push_right",     // slide right — continuous feel
      "dissolve_glow",  // glow dissolve — warm
      "cross_zoom",     // zoom blend — dynamic moments
      "fadewhite",      // white fade — airy
      "dissolve_fast",  // quick clean cut
      "ripple",         // water ripple — lofi aesthetic
      "push_left",      // slide left
    ],
    grades: [
      "romantic_warm",  // warm golden — most characteristic
      "cinematic",      // teal-orange — versatile
      "vintage",        // faded sepia — lofi feel
      "sunset_gold",    // amber warm
      "none",           // clean no-grade
      "romantic_soft",  // soft pastel
    ],
    overlays: [
      "vignette",       // standard vignette
      "film_grain",     // analog warmth
      "particles",      // soft floating dust
      "lens_flare",     // highlight glow
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
  // Slow and melancholic. Long holds, drift effects, blue/grey grades, rain.
  // Best for: sad AMVs, character tributes, endings, slow ballads.
  // DISTINCT FROM: Smooth Flow (drift+echo not breathe+pan, cold grades not warm)
  //                Aesthetic (dark desaturated not bright/pastel, rain not particles)
  emotional: {
    label:       "💙 Emotional",
    description: "Slow and melancholic. Long holds, gentle drifts, blue and grey colour grading.",
    icon:        "💙",
    cutSpeed:    "slow",
    minSceneDur: 2.0,
    maxSceneDur: 7.0,
    transitionDur: 0.40,
    stutterCuts: false,
    dropMergeGap: 2.0,

    effects: [
      "ken_burns_slow", // very slow zoom + pan — signature emotional effect
      "drift_left",     // extremely slow leftward drift — melancholic feel
      "echo_trail",     // dreamy oscillation — emotional signature
      "drift_right",    // rightward drift — gentle movement
      "static",         // no motion — hold on a face, pure emotion
      "breathe_slow",   // ultra-slow sinusoidal — barely breathing
      "zoom_out",       // slow pull-back — sense of loss
      "tilt_shift",     // depth of field — cinematic sadness
      "pan_left",       // slow pan — searching feel
      "ken_burns",      // moderate zoom — for mid-energy moments
    ],
    transitions: [
      "dissolve_slow",  // very slow blend — characteristic emotional transition
      "dissolve_glow",  // glow blend — spiritual/emotional
      "fadeblack_slow", // slow fade to black — weight of sadness
      "dissolve",       // standard blend
      "fadeblack",      // fade black — closing feeling
      "ripple",         // liquid distortion — tears
      "zoom_blur_out",  // blur out — losing focus
      "push_left",      // slow leftward push
    ],
    grades: [
      "sad_blue",       // cool desaturated blue — most characteristic
      "sad_grey",       // near-monochrome — bleakest
      "vintage",        // faded nostalgic
      "cinematic",      // teal shadows — cinematic sadness
      "cold_steel",     // metallic blue-grey — heavy
      "none",           // raw ungraded — raw emotion
    ],
    overlays: [
      "vignette_strong", // heavy vignette — closing in feeling
      "film_grain",      // analog warmth
      "rain",            // rain overlay — signature emotional
      "vignette",        // standard vignette
      "particles",       // dust/tears floating
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
  // Dreamy and stylized. Bright pastels, glow, particles, lens flares.
  // Best for: aesthetic edits, romance AMVs, lo-fi, art-house, idol edits.
  // DISTINCT FROM: Smooth Flow (glow/pastel/particles not warm/film_grain)
  //                Emotional (bright not dark, romantic not sad grades)
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
      "breathe_slow",   // ultra-soft sinusoidal — dreamy breathing
      "drift_right",    // gentle rightward drift — flowing
      "echo_trail",     // oscillating drift — dreamy and soft
      "pan_right",      // smooth pan — idol-like movement
      "zoom_out",       // soft pull-back — open and airy
      "spin_cw",        // slow rotation — artistic carousel
      "breathe",        // sinusoidal — soft and alive
      "drift_left",     // leftward flow — aesthetic signature
      "ken_burns_slow", // very slow zoom — for face close-ups
      "tilt_shift",     // depth of field — artsy
    ],
    transitions: [
      "dissolve_glow",  // glow blend — signature aesthetic transition
      "fadewhite",      // white fade — airy and bright
      "dissolve",       // standard clean blend
      "dissolve_slow",  // long dreamy blend
      "cross_zoom",     // dynamic zoom blend — energy moments
      "ripple",         // water ripple — romantic
      "zoom_blur_in",   // zoom into light — dreamy
      "push_right",     // soft rightward push
    ],
    grades: [
      "romantic_soft",  // pastel warm — most characteristic aesthetic grade
      "anime_bright",   // vivid punchy anime — pop aesthetic
      "glow_soft",      // soft bloom — dreamy glow
      "romantic_warm",  // warm golden — romantic
      "vintage",        // faded nostalgic — artsy
      "triumphant_gold",// gold/amber — idol energy
      "none",           // clean
    ],
    overlays: [
      "vignette",       // soft vignette
      "particles",      // floating sparkles — signature aesthetic overlay
      "lens_flare",     // light leak/highlight — aesthetic essential
      "snow",           // soft snow particles — pure aesthetic
      "film_grain",     // analog texture
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
 * Pick a color grade from the style's pool with proper rotation.
 * Uses scene index for deterministic variety across all grades in the pool.
 * High-energy scenes (dropStrength > 0.6) pull from top half (most characteristic).
 * Low-energy pull from bottom half (subtler grades).
 */
function pickStyleGrade(style, sceneIdx, dropStrength = 0.5, recentGrades = []) {
  const pool = style.grades;
  // Rotate through the full pool using scene index — ensures every grade is used
  const baseIdx = sceneIdx % pool.length;
  // At high energy bias toward top of pool; at low energy bias toward bottom
  const energyShift = dropStrength > 0.6 ? 0 : Math.floor(pool.length * 0.4);
  const candidateIdx = (baseIdx + energyShift) % pool.length;

  // Avoid immediate repeat
  const candidate = pool[candidateIdx];
  if (recentGrades.length > 0 && recentGrades[recentGrades.length - 1] === candidate && pool.length > 1) {
    return pool[(candidateIdx + 1) % pool.length];
  }
  return candidate || "none";
}

/**
 * Pick overlays from the style's pool — varied per scene.
 *
 * Each scene gets a DIFFERENT combination by rotating which overlays are picked.
 * The first overlay (vignette/vignette_strong) is always included as anchor.
 * Additional overlays rotate through the rest of the pool using sceneIdx.
 *
 * @param {object} style
 * @param {number} dropStrength  — 0–1 energy of this scene's drop
 * @param {number} sceneIdx      — scene index for deterministic rotation
 * @param {number} totalScenes   — total scene count (for position awareness)
 */
function pickStyleOverlays(style, dropStrength = 0.5, sceneIdx = 0, totalScenes = 1) {
  const pool   = style.overlays;
  if (pool.length === 0) return [];

  // Always include the anchor overlay (first in pool — usually vignette)
  const result = [pool[0]];
  if (pool.length === 1) return result;

  // Slow/merged-drop styles always get a 2nd overlay — scenes are long enough
  const alwaysRich = style.cutSpeed === "slow" || style.dropMergeGap >= 1.5;
  const addSecond  = alwaysRich || dropStrength > 0.45;
  const addThird   = alwaysRich ? dropStrength > 0.3 : dropStrength > 0.70;

  if (addSecond && pool.length > 1) {
    // Rotate through pool[1..n] using scene index — each scene picks differently
    const secondIdx = 1 + (sceneIdx % (pool.length - 1));
    result.push(pool[secondIdx]);
  }

  if (addThird && pool.length > 2) {
    // Third overlay picks from remaining (not same as second)
    const secondIdx = 1 + (sceneIdx % (pool.length - 1));
    const thirdIdx  = 1 + ((sceneIdx + 1) % (pool.length - 1));
    if (thirdIdx !== secondIdx) result.push(pool[thirdIdx]);
  }

  // Deduplicate and return
  return [...new Set(result)].filter(Boolean);
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