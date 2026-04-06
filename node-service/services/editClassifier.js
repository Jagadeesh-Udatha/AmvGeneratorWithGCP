/**
 * Edit Classifier v4
 *
 * NOW USES effectsLibrary.js for all effect/transition/grade/overlay pools.
 *
 * Uses amv_model.json if trained. Falls back to pattern rules.
 * Model v2 uses 7 features including beat_alignment and segment_duration.
 */

const path = require("path");
const fs   = require("fs");

const {
  MOTION_EFFECTS,
  TRANSITIONS,
  COLOR_GRADES,
  EMOTION_PALETTES,
  resolveLegacyEffect,
  resolveLegacyTransition,
} = require("./effectsLibrary");

const MODEL_PATH = path.join(__dirname, "amv_model.json");
let _model = null;
let _modelLoaded = false;

function loadModel() {
  if (_modelLoaded) return _model;
  _modelLoaded = true;
  if (!fs.existsSync(MODEL_PATH)) {
    console.log("ℹ️  No trained model — using rule-based classifier");
    console.log("   Train: cd python-tts-service && python3 amv_trainer.py --synthetic");
    return null;
  }
  try {
    _model = JSON.parse(fs.readFileSync(MODEL_PATH, "utf-8"));
    const acc = _model.accuracy || {};
    const cv_t = acc.transition_cv || (acc.transition ? (acc.transition*100).toFixed(1)+"%" : "?");
    const cv_e = acc.effect_cv     || (acc.effect     ? (acc.effect*100).toFixed(1)+"%"     : "?");
    console.log(`✅ AMV model v${_model.version||"?"} loaded — ${_model.sampleCount} samples | trans: ${cv_t} | effect: ${cv_e}`);
  } catch (e) {
    console.warn("⚠️  amv_model.json load failed:", e.message);
    _model = null;
  }
  return _model;
}

// ─── LOOKUP TABLE PREDICTION ──────────────────────────────────────────────────
// v3 grid matches trainer's build_lookup_table grid values

const BPM_GRID      = [70, 90, 110, 125, 140, 160];
const ENERGY_GRID   = [0.15, 0.3, 0.5, 0.65, 0.8];
const BEAT_ALN_GRID = [0.1, 0.4, 0.7];
const DUR_GRID      = [0.5, 1.5, 3.0, 6.0];

function nearest(val, grid) {
  return grid.reduce((a, b) => Math.abs(b - val) < Math.abs(a - val) ? b : a);
}

function predictFromLookup(model, features) {
  const lookup = model.lookupTable;
  if (!lookup) return null;
  const bpm  = nearest(features.bpm      || 120,  BPM_GRID);
  const eng  = nearest(features.energy   || 0.5,  ENERGY_GRID);
  const baln = nearest(features.beat_alignment ?? 0.5, BEAT_ALN_GRID);
  const dur  = nearest(features.segment_duration ?? 2.0, DUR_GRID);
  const key = `${bpm},${eng},${baln},${dur}`;
  const entry = lookup[key] || null;

  // Resolve legacy effect/transition names from old models
  if (entry) {
    if (entry.effect && !MOTION_EFFECTS.has(entry.effect)) {
      entry.effect = resolveLegacyEffect(entry.effect);
    }
    if (entry.transition && !TRANSITIONS.has(entry.transition)) {
      entry.transition = resolveLegacyTransition(entry.transition);
    }
  }
  return entry;
}

// ─── PATTERN RULES FALLBACK ───────────────────────────────────────────────────
// Updated with new effect/transition names from effectsLibrary

const EDIT_PATTERNS = [
  { name:"Hard Hype Cut",       score:10, conditions:{bpmMin:140,energyMin:0.70,onsetMin:0.60},
    style:{transitions:["flash_black","glitch_cut","whip_pan_left"],     effects:["zoom_punch","shake_horizontal","zoom_pulse"],  grades:["hype_red","hype_blue","neon"],       cutSpeed:"fast",   transitionDur:0.04}},
  { name:"Aggressive Beat Sync",score:9,  conditions:{bpmMin:130,energyMin:0.60},
    style:{transitions:["flash_black","whip_pan_left","slice_left"],      effects:["zoom_punch","zoom_pulse","shake_horizontal"], grades:["hype_blue","cinematic","neon"],       cutSpeed:"fast",   transitionDur:0.06}},
  { name:"Hype Cinematic",      score:8,  conditions:{bpmMin:120,energyMin:0.55,centroidMin:0.55},
    style:{transitions:["whip_pan_right","flash_black","glitch_cut"],     effects:["zoom_punch_out","zoom_in"],       grades:["cinematic","hype_red","neon"],        cutSpeed:"fast",   transitionDur:0.08}},
  { name:"Epic Reveal",         score:10, conditions:{energyMin:0.65,centroidMin:0.60,bpmMin:110,bpmMax:140},
    style:{transitions:["flash_black","zoom_blur_in"],       effects:["zoom_out"],      grades:["triumphant_gold","cinematic"],        cutSpeed:"medium", transitionDur:0.12}},
  { name:"Triumphant Build",    score:8,  conditions:{energyMin:0.55,centroidMin:0.55,bpmMin:100},
    style:{transitions:["dissolve","push_right"],            effects:["zoom_out","ken_burns","spin_cw"],             grades:["triumphant_gold","cinematic","none"],  cutSpeed:"medium", transitionDur:0.15}},
  { name:"Emotional Slow Burn", score:10, conditions:{bpmMax:85,energyMax:0.30},
    style:{transitions:["dissolve","fadeblack"],          effects:["ken_burns_slow","breathe_slow","drift_left"], grades:["sad_blue","sad_grey","vintage"],       cutSpeed:"slow",   transitionDur:0.35}},
  { name:"Sad Cinematic",       score:9,  conditions:{bpmMax:100,energyMax:0.40,onsetMax:0.40},
    style:{transitions:["dissolve","push_left"],          effects:["ken_burns_slow","breathe_slow","pan_left"],   grades:["sad_blue","sad_grey","cinematic"],     cutSpeed:"slow",   transitionDur:0.30}},
  { name:"Melancholic Drift",   score:7,  conditions:{bpmMax:110,energyMax:0.45,centroidMax:0.45},
    style:{transitions:["dissolve","push_left"],                 effects:["breathe_slow","ken_burns_slow","drift_left"], grades:["sad_grey","vintage","sad_blue"],       cutSpeed:"slow",   transitionDur:0.25}},
  { name:"Romantic Flow",       score:9,  conditions:{bpmMin:80,bpmMax:125,energyMin:0.25,energyMax:0.55,onsetMax:0.45},
    style:{transitions:["dissolve","fadewhite"],          effects:["breathe_slow","ken_burns_slow"],grades:["romantic_warm","romantic_soft","vintage"],cutSpeed:"medium",transitionDur:0.22}},
  { name:"Hopeful Rise",        score:7,  conditions:{bpmMin:90,bpmMax:130,centroidMin:0.40,energyMax:0.60},
    style:{transitions:["dissolve","push_right"],            effects:["zoom_in","breathe","ken_burns"],              grades:["romantic_warm","cinematic","none"],     cutSpeed:"medium", transitionDur:0.20}},
  { name:"Standard Edit",       score:0,  conditions:{},
    style:{transitions:["dissolve","push_left","flash_black"],            effects:["zoom_pulse","ken_burns","zoom_in"],           grades:["cinematic","none","vintage"],           cutSpeed:"medium", transitionDur:0.18}}];

function scorePattern(p, f) {
  const c = p.conditions;
  if (c.bpmMin      !== undefined && f.bpm      < c.bpmMin)      return -1;
  if (c.bpmMax      !== undefined && f.bpm      > c.bpmMax)      return -1;
  if (c.energyMin   !== undefined && f.energy   < c.energyMin)   return -1;
  if (c.energyMax   !== undefined && f.energy   > c.energyMax)   return -1;
  if (c.centroidMin !== undefined && f.centroid < c.centroidMin) return -1;
  if (c.centroidMax !== undefined && f.centroid > c.centroidMax) return -1;
  if (c.onsetMin    !== undefined && f.onset    < c.onsetMin)    return -1;
  if (c.onsetMax    !== undefined && f.onset    > c.onsetMax)    return -1;
  return p.score;
}

function classifyWithPatterns(features, sceneIdx) {
  let best = null, bestScore = -2;
  for (const p of EDIT_PATTERNS) {
    const s = scorePattern(p, features);
    if (s > bestScore) { bestScore = s; best = p; }
  }
  const style = best.style;
  return {
    name:       best.name,
    source:     "patterns",
    transition: sceneIdx === 0 ? "dissolve" : style.transitions[sceneIdx % style.transitions.length],
    effect:     style.effects[sceneIdx % style.effects.length],
    colorGrade: (style.grades || ["none"])[sceneIdx % (style.grades || ["none"]).length],
    cutSpeed:   style.cutSpeed,
  };
}

// ─── MAIN CLASSIFIER ──────────────────────────────────────────────────────────

function classifyEditStyle(features) {
  const model = loadModel();
  if (model) {
    const entry = predictFromLookup(model, features);
    if (entry) {
      const tier = features.energy > 0.55 ? "fast" : features.energy > 0.30 ? "medium" : "slow";
      return {
        name:       "ML Classifier",
        source:     "model",
        transition: entry.transition,
        effect:     entry.effect,
        cutSpeed:   tier,
        style: {
          transitions:   [entry.transition, "dissolve", "fadeblack"],
          effects:       [entry.effect, "ken_burns", "zoom_in"],
          grades:        ["cinematic", "none"],
          cutSpeed:      tier,
          transitionDur: features.energy > 0.55 ? 0.06 : features.energy > 0.30 ? 0.15 : 0.28,
        },
        features,
      };
    }
  }
  const result = classifyWithPatterns(features, 0);
  return {
    ...result,
    style: {
      transitions:   [result.transition, "dissolve", "fadeblack"],
      effects:       [result.effect, "ken_burns", "zoom_in"],
      grades:        [result.colorGrade || "cinematic", "none"],
      cutSpeed:      result.cutSpeed,
      transitionDur: 0.18,
    },
    features,
  };
}

// ─── VARIETY ENFORCEMENT HELPERS ─────────────────────────────────────────────

// FIXED: Rolling window reduced from 6 to 3 for effects and transitions.
// Window of 6 was too aggressive — with 22 scenes and only 4-5 options per
// emotion palette, the classifier would exhaust all options and fall back to
// repeating. Window of 3 forces variety without over-constraining choice.
const ROLLING_WINDOW = 3;

/**
 * Pick an item from a palette array, avoiding recent picks.
 * Uses the scene index as seed for deterministic but varied selection.
 */
/**
 * A fast integer hash that mixes two numbers into one.
 * Used to make scene-index selections sensitive to song features
 * so the same image at position N produces different results for different songs.
 */
function songAwareSeed(sceneIdx, songSeed) {
  // Mix sceneIdx and songSeed using Knuth multiplicative hash
  const a = ((sceneIdx + 1) * 2654435761) >>> 0;
  const b = ((Math.round(songSeed * 1e4)) * 2246822519) >>> 0;
  return (a ^ b) >>> 0;
}

function pickWithVariety(pool, recentPicks, sceneIdx, songSeed = 0) {
  if (!pool || pool.length === 0) return null;

  // Filter out items used in the rolling window
  const available = pool.filter(item => !recentPicks.includes(item));

  // If everything was used recently, reset — pick from full pool but skip immediate last
  const candidates = available.length > 0 ? available : pool.filter(item => item !== recentPicks[recentPicks.length - 1]);
  const finalPool = candidates.length > 0 ? candidates : pool;

  // FIX: Use both sceneIdx AND a song-derived seed so the same image at the
  // same position picks differently when the song changes.
  const seed = songAwareSeed(sceneIdx, songSeed);
  const idx = seed % finalPool.length;
  return finalPool[idx];
}

/**
 * Pick color grade based on emotion palette + energy level.
 * High energy → first grades in palette (most characteristic).
 * Low energy → later grades (subtler / none).
 */
function pickColorGradeFromPalette(palette, energy, dropStrength, recentGrades, sceneIdx, songSeed = 0) {
  const grades = palette.grades || ["none"];

  // High energy scenes → pick from top half of palette
  // Low energy scenes → pick from bottom half
  const intensity = (energy + dropStrength) / 2;
  let pool;
  if (intensity > 0.6) {
    pool = grades.slice(0, Math.ceil(grades.length * 0.6));
  } else if (intensity > 0.35) {
    pool = grades.slice(1, grades.length - 1).length > 0 ? grades.slice(1, grades.length - 1) : grades;
  } else {
    pool = grades.slice(Math.floor(grades.length * 0.5));
  }

  return pickWithVariety(pool, recentGrades, sceneIdx, songSeed) || "none";
}

/**
 * Pick overlays based on emotion palette + drop strength + scene position.
 * More overlays at high intensity, fewer at low.
 */
function pickOverlaysFromPalette(palette, dropStrength, energy, sceneIdx, songSeed = 0) {
  const pool = palette.overlays || ["vignette"];
  const result = [];

  // Always include first overlay (usually vignette)
  result.push(pool[0]);

  // High energy/drop → add more overlays from the palette
  if (dropStrength > 0.5 && pool.length > 1) {
    const seed = songAwareSeed(sceneIdx, songSeed);
    result.push(pool[1 + (seed % (pool.length - 1))]);
  }

  // Very high intensity → even more
  if (energy > 0.65 && dropStrength > 0.7 && pool.length > 2) {
    const seed2 = songAwareSeed(sceneIdx + 100, songSeed);
    const extra = pool[2 + (seed2 % Math.max(1, pool.length - 2))];
    if (extra && !result.includes(extra)) result.push(extra);
  }

  return result.filter(Boolean);
}

// ─── SMART COMPOSITION ASSIGNMENT (encodes LLM prompt logic) ─────────────────

// Song structure detection — matches LLM's 7-section awareness
function getSongSection(position) {
  if (position < 0.08) return "INTRO";
  if (position > 0.90) return "OUTRO";
  if (position < 0.25) return "VERSE_1";
  if (position < 0.45) return "CHORUS_1";
  if (position < 0.55) return "BRIDGE";
  if (position < 0.75) return "CHORUS_2";
  return "CLIMAX";
}

// Section-specific composition pools (what a human editor would pick)
// FIXED: pools expanded to include multi-image compositions and more variety.
// Previously each section had only 3-5 options; now 6-8 so rolling-window
// variety enforcement doesn't exhaust the pool after 3 scenes.
const SECTION_COMPOSITIONS = {
  INTRO:    ["character_reveal", "swipe_in_left", "swipe_in_right"],
  VERSE_1:  ["swipe_in_right", "swipe_in_left"],
  CHORUS_1: ["impact_frame", "bounce_zoom", "shockwave"],
  BRIDGE:   ["vhs_composite", "spotlight_zoom", "neon_frame"],
  CHORUS_2: ["shockwave", "zoom_burst", "impact_frame", "bounce_zoom"],
  CLIMAX:   ["impact_frame", "shockwave", "bounce_zoom", "zoom_burst"],
  OUTRO:    ["swipe_in_left"],
};

// Visual-feature-based overrides (highest priority)
const VISUAL_COMPOSITIONS = [
  { test: (vf, ds) => vf.face_present && ds < 0.4,  comps: ["spotlight_zoom", "character_reveal"], reason: "face close-up with low energy" },
  { test: (vf, ds) => vf.face_present && ds >= 0.6,  comps: ["character_reveal", "bounce_zoom", "impact_frame"], reason: "face with high-energy beat drop" },
  { test: (vf, ds) => vf.dark_scene && ds > 0.5,     comps: ["neon_frame", "shockwave"], reason: "dark scene with energy" },
  { test: (vf, ds) => vf.dark_scene && ds <= 0.5,    comps: ["vhs_composite"], reason: "dark moody scene" },
  { test: (vf, ds) => vf.action_scene && ds > 0.6,   comps: ["manga_panels", "impact_frame", "shockwave"], reason: "action scene on beat drop" },
  { test: (vf, ds) => vf.action_scene,               comps: ["manga_panels"], reason: "action scene with detail" },
  { test: (vf, ds) => vf.saturation > 0.6,           comps: ["manga_panels"], reason: "vivid colorful image" },
  { test: (vf, ds) => vf.warm_dominant && ds < 0.4,  comps: [], reason: "warm tones, calm energy" }];

function pickComposition(scene, position, recentComps, sceneIdx, totalScenes, songSeed = 0) {
  const section = getSongSection(position);
  const vf = scene.visualFeatures || {};
  const ds = scene.dropStrength || 0;

  // FIXED: Composition frequency raised from ~45% to ~70% of scenes.
  // The old rates (VERSE=0.35, BRIDGE=0.40) meant most scenes had NO composition,
  // so the generated video used flat effects only — wasting the 30 compositions built.
  // New rates: every section gets at minimum a 55% chance. INTRO/OUTRO stay at 1.0.
  const sectionChance = {
    INTRO: 1.0, OUTRO: 1.0, CLIMAX: 0.90, CHORUS_1: 0.80, CHORUS_2: 0.85, BRIDGE: 0.65, VERSE_1: 0.55,
  };

  const chance = sectionChance[section] || 0.4;
  // Deterministic "random" using scene index (same input = same output)
  const seed = songAwareSeed(sceneIdx, songSeed);
  const pseudoRandom = seed / 4294967296;
  if (pseudoRandom > chance && section !== "INTRO" && section !== "OUTRO") return { composition: null, reason: null };

  // 1. Check visual-feature overrides first (highest priority)
  for (const rule of VISUAL_COMPOSITIONS) {
    if (rule.test(vf, ds)) {
      const available = rule.comps.filter(c => !recentComps.includes(c));
      const pool = available.length > 0 ? available : rule.comps;
      return { composition: pool[songAwareSeed(sceneIdx, songSeed + 1) % pool.length], reason: `${section.toLowerCase()} — ${rule.reason}` };
    }
  }

  // 2. Section-based default
  const sectionPool = SECTION_COMPOSITIONS[section] || SECTION_COMPOSITIONS.VERSE_1;
  const available = sectionPool.filter(c => !recentComps.includes(c));
  const pool = available.length > 0 ? available : sectionPool;
  const comp = pool[songAwareSeed(sceneIdx, songSeed + 2) % pool.length];

  const sectionReasons = {
    INTRO: "opening — establish the vibe",
    VERSE_1: "verse — building atmosphere",
    CHORUS_1: "first chorus — energy rising",
    BRIDGE: "bridge — contrast and tension",
    CHORUS_2: "second chorus — full intensity",
    CLIMAX: "climax — maximum impact",
    OUTRO: "outro — letting the viewer breathe",
  };

  return { composition: comp, reason: sectionReasons[section] || "section transition" };
}

// Generate human-readable reasoning for each scene (like LLM does)
function generateReasoning(scene, section, composition, effect, colorGrade) {
  const parts = [];
  const vf = scene.visualFeatures || {};

  // Section context
  const sectionDesc = { INTRO: "opening", VERSE_1: "verse build-up", CHORUS_1: "first chorus", BRIDGE: "bridge transition", CHORUS_2: "second chorus peak", CLIMAX: "climax moment", OUTRO: "closing" };
  parts.push(sectionDesc[section] || section.toLowerCase());

  // Visual context
  if (vf.face_present) parts.push("face detected → focus composition");
  if (vf.dark_scene) parts.push("dark scene");
  if (vf.action_scene) parts.push("high action/detail");
  if (vf.warm_dominant) parts.push("warm tones");

  // Energy context
  const ds = scene.dropStrength || 0;
  if (ds > 0.7) parts.push("strong beat drop");
  else if (ds > 0.4) parts.push("medium energy");
  else parts.push("calm section");

  // Choice explanation
  if (composition) parts.push(`→ ${composition.replace(/_/g, " ")}`);
  if (colorGrade && colorGrade !== "none") parts.push(`with ${colorGrade.replace(/_/g, " ")} grading`);

  return parts.join(" · ");
}

// ─── SUGGEST EFFECTS FOR ALL SCENES (with variety enforcement) ──────────────

const {
  getEditStyle,
  pickStyleEffect,
  pickStyleTransition,
  pickStyleGrade,
  pickStyleOverlays,
  pickStyleComposition,
} = require("./editStyles");

function suggestEffects(scenes, globalFeatures, beatData, editStyleId = null) {
  const model  = loadModel();
  const source = model ? "model" : "patterns";
  const beats  = beatData?.beats || [];
  const avgInterval = beats.length > 1
    ? beats.slice(1).reduce((sum, b, i) => sum + (b - beats[i]), 0) / (beats.length - 1)
    : 0.5;

  // Song-fingerprint seed for deterministic variety
  const bpmBucket   = Math.round((globalFeatures.bpm      || 120) / 5);
  const engBucket   = Math.round((globalFeatures.energy   || 0.5) * 20);
  const centBucket  = Math.round((globalFeatures.centroid || 0.5) * 10);
  const beatCount   = beats.length;
  const songSeed    = (bpmBucket * 1000 + engBucket * 100 + centBucket * 10 + (beatCount % 10));

  // If a user edit style is provided, use it to drive ALL selections
  const editStyle = editStyleId ? getEditStyle(editStyleId) : null;

  // Rolling window history for variety enforcement
  const recentEffects     = [];
  const recentTransitions = [];
  const recentGrades      = [];
  const recentComps       = [];

  const totalScenes = scenes.length;

  return scenes.map((scene, i) => {
    const position = i / Math.max(1, totalScenes - 1);
    const isIntro  = position < 0.12;
    const isOutro  = position > 0.88;

    let beatAlignment = 0.5;
    if (beats.length) {
      const dists = beats.map(b => Math.abs(scene.start - b));
      const minDist = Math.min(...dists);
      beatAlignment = Math.min(1.0, minDist / (avgInterval / 2 + 1e-8));
    }

    const features = {
      bpm:              scene.segmentFeatures?.bpm      ?? globalFeatures.bpm,
      energy:           scene.segmentFeatures?.energy   ?? globalFeatures.energy,
      relative_energy:  1.0,
      centroid:         scene.segmentFeatures?.centroid ?? globalFeatures.centroid,
      onset:            scene.segmentFeatures?.onset    ?? globalFeatures.onset,
      beat_alignment:   parseFloat(beatAlignment.toFixed(4)),
      segment_duration: parseFloat(scene.duration.toFixed(3)),
      emotion:          scene.emotion || "neutral",
    };

    const emotion  = scene.emotion || "neutral";
    const palette  = EMOTION_PALETTES[emotion] || EMOTION_PALETTES.neutral;
    const energy   = features.energy || 0.5;
    const dropStr  = scene.dropStrength || 0.5;
    const vf       = scene.visualFeatures || {};

    let transition, effect, colorGrade, cutSpeed, composition;
    const section = getSongSection(position);

    // ══════════════════════════════════════════════════════════════════
    // EDIT STYLE PATH — style sets the palette, ML/LLM refines within it
    // ══════════════════════════════════════════════════════════════════
    if (editStyle) {
      // Step A: Get base style picks (palette-constrained)
      effect     = pickStyleEffect(editStyle, i, recentEffects);
      transition = pickStyleTransition(editStyle, i, recentTransitions);
      colorGrade = pickStyleGrade(editStyle, i, dropStr, recentGrades);
      const overlays = pickStyleOverlays(editStyle, dropStr, i, totalScenes);
      composition = pickStyleComposition(editStyle, section, i, recentComps);
      cutSpeed    = editStyle.cutSpeed;

      // Step B: ML refinement — if model is loaded, use its energy/emotion reading
      // to pick a BETTER effect/transition from within the style's pool.
      // E.g. on a high-energy scene the ML says "zoom_punch" — if zoom_punch is
      // in the style's pool, prefer it over the round-robin pick.
      if (model) {
        const entry = predictFromLookup(model, features);
        if (entry) {
          // Remap ML effect to nearest match in style's pool
          if (editStyle.effects.includes(entry.effect)) {
            effect = entry.effect; // ML pick is valid for this style — use it
          }
          // Remap ML transition to nearest match in style's pool
          if (i > 0 && editStyle.transitions.includes(entry.transition)) {
            transition = entry.transition;
          }
        }
      }

      // Step C: Face-aware override within the style pool
      if (vf.face_present) {
        const styleFaceEffects = editStyle.effects.filter(e =>
          ["breathe", "breathe_slow", "ken_burns_slow", "zoom_in", "ken_burns", "spotlight_zoom"].includes(e)
        );
        if (styleFaceEffects.length > 0) {
          const faceEffect = pickWithVariety(styleFaceEffects, recentEffects, i, songSeed);
          if (faceEffect) effect = faceEffect;
        }
      }

      // Step D: Variety enforcement — ensure no back-to-back repeats
      if (recentEffects.includes(effect)) {
        const altEffect = pickWithVariety(editStyle.effects, recentEffects, i, songSeed);
        if (altEffect) effect = altEffect;
      }
      if (i > 0 && recentTransitions.includes(transition)) {
        const altTrans = pickWithVariety(editStyle.transitions, recentTransitions, i, songSeed);
        if (altTrans) transition = altTrans;
      }

      recentEffects.push(effect);
      recentTransitions.push(transition);
      recentGrades.push(colorGrade);
      if (composition) recentComps.push(composition);
      if (recentEffects.length > ROLLING_WINDOW)     recentEffects.shift();
      if (recentTransitions.length > ROLLING_WINDOW) recentTransitions.shift();
      if (recentGrades.length > ROLLING_WINDOW)      recentGrades.shift();
      if (recentComps.length > 4)                    recentComps.shift();

      const mlUsed = model ? "ML+Style" : "Style";
      const reasoning = `${editStyle.label} · ${section.toLowerCase()} · ${mlUsed} · ${composition || effect}`;

      return {
        ...scene,
        effect, transition, colorGrade, overlays: overlays.filter(Boolean),
        composition: composition || null,
        cutSpeed,
        editStyle:        editStyleId,
        editPattern:      editStyle.label,
        editSource:       "style",
        classifierSource: mlUsed,
        beatAlignment:    parseFloat(beatAlignment.toFixed(3)),
        suggestedEffect:     effect,
        suggestedTransition: transition,
        suggestedColorGrade: colorGrade,
        faceAware:           vf.face_present ? true : false,
        llmReasoning:        reasoning,
      };
    }

    // ══════════════════════════════════════════════════════════════════
    // ORIGINAL AUTO PATH — no style selected, use emotion + ML/patterns
    // ══════════════════════════════════════════════════════════════════

    // ── Step 0: Assign composition based on visual features + position ──
    const compResult = pickComposition(scene, position, recentComps, i, totalScenes, songSeed);
    composition = compResult.composition;
    let compReason = compResult.reason;

    // ── Step 1: Get base suggestion from ML model or pattern rules ──
    if (model) {
      const entry = predictFromLookup(model, features);
      if (entry) {
        effect     = entry.effect;
        transition = entry.transition;
        cutSpeed   = energy > 0.55 ? "fast" : energy > 0.30 ? "medium" : "slow";
      } else {
        const r = classifyWithPatterns(features, i);
        effect = r.effect; transition = r.transition; cutSpeed = r.cutSpeed;
      }
    } else {
      const r = classifyWithPatterns(features, i);
      effect = r.effect; transition = r.transition; cutSpeed = r.cutSpeed;
    }

    // ── Step 1b: Face-aware effect selection ──
    if (vf.face_present && !composition) {
      const faceEffects = ["breathe", "breathe_slow", "zoom_in", "ken_burns", "ken_burns_slow", "zoom_pulse"];
      effect = pickWithVariety(faceEffects, recentEffects, i, songSeed) || effect;
    }

    // ── Step 2: Variety enforcement via rolling window ──
    if (recentEffects.includes(effect)) {
      effect = pickWithVariety(palette.effects, recentEffects, i, songSeed) || effect;
    }
    if (i > 0 && recentTransitions.includes(transition)) {
      transition = pickWithVariety(palette.transitions, recentTransitions, i, songSeed) || transition;
    }

    // ── Step 3: Section-aware overrides ──
    if (isIntro) {
      if (energy < 0.5) {
        const gentleEffects = ["ken_burns_slow", "breathe_slow", "ken_burns"];
        effect = pickWithVariety(gentleEffects, recentEffects, i, songSeed) || effect;
      }
      if (i === 0) transition = "dissolve";
    }
    if (isOutro) {
      const outroEffects = ["zoom_out", "ken_burns_slow", "breathe_slow", "drift_left"];
      effect = pickWithVariety(outroEffects, recentEffects, i, songSeed) || effect;
      const outroTransitions = ["dissolve"];
      transition = pickWithVariety(outroTransitions, recentTransitions, i, songSeed) || transition;
    }

    // ── Step 4: Color grade — energy-aware selection with variety ──
    colorGrade = pickColorGradeFromPalette(palette, energy, dropStr, recentGrades, i, songSeed);

    // ── Step 5: Overlays — intensity-aware selection ──
    const overlays = pickOverlaysFromPalette(palette, dropStr, energy, i, songSeed);

    // ── Update rolling windows ──
    recentEffects.push(effect);
    recentTransitions.push(transition);
    recentGrades.push(colorGrade);
    if (composition) recentComps.push(composition);
    if (recentEffects.length > ROLLING_WINDOW) recentEffects.shift();
    if (recentTransitions.length > ROLLING_WINDOW) recentTransitions.shift();
    if (recentGrades.length > ROLLING_WINDOW) recentGrades.shift();
    if (recentComps.length > 4) recentComps.shift();

    // ── Generate human-readable reasoning ──
    const reasoning = generateReasoning(scene, section, composition, effect, colorGrade);

    return {
      ...scene,
      effect, transition, colorGrade, overlays: overlays.filter(Boolean),
      composition: composition || null,
      cutSpeed,
      editPattern:      model ? "ML Classifier" : "Smart Classifier",
      classifierSource: source,
      editSource:       "smart_classifier",
      beatAlignment:    parseFloat(beatAlignment.toFixed(3)),
      suggestedEffect:      effect,
      suggestedTransition:  transition,
      suggestedColorGrade:  colorGrade,
      faceAware:            vf.face_present ? true : false,
      llmReasoning:         reasoning,
    };
  });
}

function getModelInfo() {
  const model = loadModel();
  if (!model) return {
    type: "rule-based", source: "patterns", ready: true,
    effectCount:     MOTION_EFFECTS.size,
    transitionCount: TRANSITIONS.size,
    gradeCount:      COLOR_GRADES.size,
    trainCommand: "cd python-tts-service && python3 amv_trainer.py --synthetic",
  };
  const acc = model.accuracy || {};
  return {
    type:        "ml",
    version:     model.version,
    source:      "amv_model.json",
    ready:       true,
    sampleCount: model.sampleCount,
    accuracy:    acc,
    features:    model.features,
    trainedAt:   model.trainedAt,
    effectCount:     MOTION_EFFECTS.size,
    transitionCount: TRANSITIONS.size,
    gradeCount:      COLOR_GRADES.size,
    trainCommand:"cd python-tts-service && python3 amv_trainer.py --all --urls amv_urls.txt",
  };
}

function getPatterns() {
  return EDIT_PATTERNS.map(p => ({ name: p.name, conditions: p.conditions, style: p.style }));
}

module.exports = { classifyEditStyle, suggestEffects, getPatterns, getModelInfo, loadModel };