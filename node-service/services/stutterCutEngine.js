/**
 * Stutter Cut Engine v2.0
 *
 * Detects GENUINELY rapid beat clusters (faster than the song's normal rhythm)
 * and splits those scenes into micro-cuts.
 *
 * v2.0 fixes over v1.0:
 *   - BPM-AWARE gap threshold: only triggers when beats are significantly
 *     faster than normal (< 60% of average beat interval)
 *   - Minimum micro-cut duration: 0.2s (6 frames at 30fps)
 *   - Maximum clusters per song: 8 (prevents over-stuttering)
 *   - Varied stutter effects per cluster type
 *   - Preserves parent scene's colorGrade + overlays explicitly
 *   - Only splits scenes longer than 0.8s (short scenes stay as-is)
 *
 * Rules (unchanged):
 *   4+ beats within 1.0s  → hard stutter
 *   3+ beats within 1.5s  → stutter cut
 *   2  beats within 0.5s  → double hit
 */

// ─── CLUSTER DETECTION (BPM-AWARE) ──────────────────────────────────────────

/**
 * Find beat clusters within a scene window.
 * A cluster = consecutive beats that are SIGNIFICANTLY closer than normal.
 *
 * @param {number[]} beats     — absolute beat times (sorted)
 * @param {number}   start     — scene start time
 * @param {number}   end       — scene end time
 * @param {number}   normalGap — average beat interval for this song (60/BPM)
 * @returns {object[]} clusters
 */
function findBeatClusters(beats, start, end, normalGap) {
  const sceneBeatTimes = beats.filter(t => t >= start && t < end);
  if (sceneBeatTimes.length < 2) return [];

  // Key fix: gap threshold is relative to the song's normal beat spacing.
  // Only beats that are < 55% of normal interval count as "clustered".
  // At 130 BPM (gap=0.46s), threshold = 0.25s — only very rapid doubles/triples.
  // At 170 BPM (gap=0.35s), threshold = 0.19s — even tighter.
  const clusterGap = normalGap * 0.55;

  const clusters = [];
  let runStart = 0;

  for (let i = 1; i <= sceneBeatTimes.length; i++) {
    const gap = i < sceneBeatTimes.length
      ? sceneBeatTimes[i] - sceneBeatTimes[i - 1]
      : Infinity;

    if (gap > clusterGap) {
      const run = sceneBeatTimes.slice(runStart, i);
      const span = run[run.length - 1] - run[0];

      if (run.length >= 4 && span <= 1.0) {
        clusters.push({ beats: run, type: "hard", intensity: 1.0 });
      } else if (run.length >= 3 && span <= 1.5) {
        clusters.push({ beats: run, type: "stutter", intensity: 0.8 });
      } else if (run.length >= 2 && span <= 0.5) {
        clusters.push({ beats: run, type: "double", intensity: 0.6 });
      }

      runStart = i;
    }
  }

  return clusters;
}

// ─── STUTTER EFFECT PATTERNS ─────────────────────────────────────────────────

// More variety than v1: different patterns per cluster type
const STUTTER_EFFECTS = {
  hard:    ["zoom_punch", "zoom_punch_out", "glitch_flash", "zoom_punch", "zoom_punch_out"],
  stutter: ["zoom_punch", "zoom_punch_out", "shake_horizontal", "zoom_punch_out"],
  double:  ["freeze_punch", "zoom_punch_out"],
};

const STUTTER_TRANSITIONS = {
  hard:    "flash_black",
  stutter: "flash_black",
  double:  "flash_white",
};

// Minimum duration for a micro-cut (seconds). Below this, the cut is too short to see.
const MIN_MICRO_CUT = 0.2;

// Maximum number of clusters to process per song. Beyond this, it's too chaotic.
const MAX_CLUSTERS = 8;

// Only split scenes longer than this (seconds). Short scenes don't need further splitting.
const MIN_SCENE_DUR_FOR_SPLIT = 0.8;

// ─── MAIN: APPLY STUTTER CUTS ────────────────────────────────────────────────

/**
 * Process a scene array, detecting beat clusters and splitting scenes into micro-cuts.
 *
 * @param {object[]} scenes   — scene array
 * @param {number[]} allBeats — all beat times (absolute, sorted)
 * @param {object}   opts     — { bpm, enabled }
 * @returns {object[]} New scene array with stutter cuts expanded
 */
function applyStutterCuts(scenes, allBeats, opts = {}) {
  const { bpm = 120, enabled = true } = opts;

  if (!enabled || !allBeats || allBeats.length < 4) {
    return scenes;
  }

  // Only apply for BPM >= 100
  if (bpm < 100) {
    console.log("   ⏭  Stutter cuts skipped (BPM < 100)");
    return scenes;
  }

  const normalGap = 60.0 / bpm; // average beat interval in seconds

  // First pass: find ALL clusters across all scenes, then take top N by intensity
  const allClusters = [];
  for (const scene of scenes) {
    if (scene.duration < MIN_SCENE_DUR_FOR_SPLIT) continue; // skip short scenes
    const clusters = findBeatClusters(allBeats, scene.start, scene.start + scene.duration, normalGap);
    for (const c of clusters) {
      allClusters.push({ ...c, sceneStart: scene.start });
    }
  }

  // Sort by intensity (hard > stutter > double), take top MAX_CLUSTERS
  const intensityOrder = { hard: 3, stutter: 2, double: 1 };
  allClusters.sort((a, b) => (intensityOrder[b.type] || 0) - (intensityOrder[a.type] || 0));
  const selectedClusterStarts = new Set(
    allClusters.slice(0, MAX_CLUSTERS).map(c => c.beats[0])
  );

  // Second pass: expand scenes
  const expanded = [];
  let stutterCount = 0;
  let microCutCount = 0;

  for (const scene of scenes) {
    if (scene.duration < MIN_SCENE_DUR_FOR_SPLIT) {
      expanded.push(scene);
      continue;
    }

    const clusters = findBeatClusters(allBeats, scene.start, scene.start + scene.duration, normalGap)
      .filter(c => selectedClusterStarts.has(c.beats[0])); // only selected clusters

    if (clusters.length === 0) {
      expanded.push(scene);
      continue;
    }

    const splitParts = splitSceneWithClusters(scene, clusters);
    stutterCount++;
    microCutCount += splitParts.filter(p => p.isStutterCut).length;

    for (const part of splitParts) {
      expanded.push(part);
    }
  }

  if (stutterCount > 0) {
    console.log(`   ⚡ Stutter cuts: ${stutterCount} scenes split → ${microCutCount} micro-cuts added (${expanded.length} total scenes)`);
  } else {
    console.log("   ⏭  No genuine beat clusters found for stutter cuts");
  }

  return expanded;
}

/**
 * Split a single scene into normal parts + stutter micro-cuts.
 */
function splitSceneWithClusters(scene, clusters) {
  const parts = [];
  let cursor = scene.start;

  // Explicitly capture parent scene properties
  const parentGrade    = scene.colorGrade || "none";
  const parentOverlays = scene.overlays   || [];
  const parentEmotion  = scene.emotion    || "neutral";

  for (const cluster of clusters) {
    const clusterStart = cluster.beats[0];
    const clusterEnd   = cluster.beats[cluster.beats.length - 1];

    // 1. Normal part BEFORE this cluster
    if (clusterStart - cursor > 0.25) {
      const normalDur = parseFloat((clusterStart - cursor).toFixed(3));
      parts.push({
        ...scene,
        start:        cursor,
        end:          clusterStart,
        duration:     normalDur,
        colorGrade:   parentGrade,
        overlays:     parentOverlays,
        beatsInScene: [],
        isStutterCut: false,
      });
    }

    // 2. Micro-cuts for the cluster
    const effects    = STUTTER_EFFECTS[cluster.type] || STUTTER_EFFECTS.stutter;
    const transition = STUTTER_TRANSITIONS[cluster.type] || "flash_black";
    const beatTimes  = cluster.beats;

    for (let i = 0; i < beatTimes.length; i++) {
      const cutStart = beatTimes[i];
      const cutEnd   = i < beatTimes.length - 1
        ? beatTimes[i + 1]
        : Math.min(clusterEnd + 0.25, scene.start + scene.duration);

      // Enforce minimum duration
      const rawDur = cutEnd - cutStart;
      const cutDur = parseFloat(Math.max(MIN_MICRO_CUT, rawDur).toFixed(3));

      parts.push({
        ...scene,
        start:         cutStart,
        end:           cutStart + cutDur,
        duration:      cutDur,
        effect:        effects[i % effects.length],
        transition:    i === 0 ? (scene.transition || "flash_black") : transition,
        colorGrade:    parentGrade,     // preserve parent's color grade
        overlays:      parentOverlays,  // preserve parent's overlays
        emotion:       parentEmotion,
        dropStrength:  Math.min(1.0, (scene.dropStrength || 0.5) + 0.2),
        beatsInScene:  [0],
        beatStrengths: [0.9],
        isStutterCut:  true,
        stutterType:   cluster.type,
        stutterIndex:  i,
        stutterTotal:  beatTimes.length,
      });
    }

    cursor = parts[parts.length - 1].end;
  }

  // 3. Normal part AFTER last cluster
  const sceneEnd = scene.start + scene.duration;
  if (sceneEnd - cursor > 0.25) {
    const tailDur = parseFloat((sceneEnd - cursor).toFixed(3));
    parts.push({
      ...scene,
      start:        cursor,
      end:          sceneEnd,
      duration:     tailDur,
      colorGrade:   parentGrade,
      overlays:     parentOverlays,
      beatsInScene: [],
      isStutterCut: false,
    });
  }

  // Re-index
  parts.forEach((p, i) => { p.index = i; });

  return parts;
}

// ─── EXPORTS ─────────────────────────────────────────────────────────────────

module.exports = {
  applyStutterCuts,
  findBeatClusters,
};
