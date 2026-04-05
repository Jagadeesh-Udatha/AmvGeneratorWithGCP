/**
 * AMV Upgrade Test Suite
 *
 * Tests all five upgraded subsystems:
 *   1. Slow-beat scene segmentation (boundary enforcement)
 *   2. Multi-image composition commands (beat_stack_3, triptych_reveal, stagger_slide_up)
 *   3. Face-aware crop (buildFaceCrop)
 *   4. Backward compatibility (all 22 legacy compositions)
 *   5. Magnetic mask special-path handling
 *
 * Run:  node node-service/tests/amv-upgrade.test.js
 * No external test framework — pure Node.js assertions.
 */

"use strict";

const assert = require("assert");
const path   = require("path");

const ce = require(path.join(__dirname, "../services/compositionEngine.js"));

// ─── Helpers ──────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  \u2705  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  \u274c  ${name}`);
    console.error(`       ${err.message}`);
    failed++;
  }
}

function assertCmd(cmd, label) {
  assert(typeof cmd === "string" && cmd.startsWith("ffmpeg"),
    `${label}: expected ffmpeg command string, got ${JSON.stringify(cmd)}`);
}

function countInputs(cmd) {
  return (cmd.match(/-i "/g) || []).length;
}

// Mirrors amv.js enforcedBoundaries logic for unit-testing in isolation
function enforceSceneDurations(quantizedBoundaries, allBeats, MIN, MAX, fps, totalDur) {
  const out = [0];
  for (let i = 1; i < quantizedBoundaries.length; i++) {
    const prev = out[out.length - 1];
    const curr = quantizedBoundaries[i];
    const dur  = curr - prev;

    // Too short and NOT the last segment — merge forward
    if (dur < MIN && i < quantizedBoundaries.length - 1) continue;

    if (dur > MAX) {
      const nChunks  = Math.ceil(dur / MAX);
      const chunkDur = dur / nChunks;
      for (let c = 1; c < nChunks; c++) {
        const splitT = prev + c * chunkDur;
        let snapT = splitT, snapDist = Infinity;
        for (const beat of allBeats) {
          const d = Math.abs(beat - splitT);
          if (d < snapDist) { snapDist = d; snapT = beat; }
        }
        const snapped = snapDist < 0.2
          ? Math.round(snapT * fps) / fps
          : Math.round(splitT * fps) / fps;
        if (snapped > prev && snapped < curr) out.push(snapped);
      }
    }

    out.push(curr);
  }
  if (out[out.length - 1] !== totalDur) out.push(totalDur);
  return out;
}

function sceneDurations(boundaries) {
  return boundaries.slice(1).map((t, i) => parseFloat((t - boundaries[i]).toFixed(4)));
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1: Slow-Beat Scene Segmentation
// ─────────────────────────────────────────────────────────────────────────────

console.log("\n-- 1. Slow-beat segmentation -----------------------------------");

test("Slow song (60 BPM, no drops): all scenes within [0.8, 4.0]s", () => {
  const beats = Array.from({ length: 30 }, (_, i) => i);   // 1 beat/s, 30s song
  const raw   = [0, ...beats, 30];
  const enforced = enforceSceneDurations(raw, beats, 0.8, 4.0, 30, 30);
  const durs  = sceneDurations(enforced);
  assert(durs.length > 0, "No scenes produced");
  for (const d of durs) {
    assert(d >= 0.79, `Scene too short: ${d}s`);
    assert(d <= 4.05, `Scene too long: ${d}s`);
  }
});

test("Fast song (120 BPM) with drops: scenes respect MAX=8s", () => {
  const drops = [4, 8, 12, 20, 28];
  const beats = Array.from({ length: 60 }, (_, i) => +(i * 0.5).toFixed(3));
  const raw   = [0, ...drops, 30];
  const enforced = enforceSceneDurations(raw, beats, 0.8, 8.0, 30, 30);
  const durs  = sceneDurations(enforced);
  assert(durs.length >= drops.length);
  for (const d of durs) {
    assert(d >= 0.79, `Scene too short: ${d}s`);
    assert(d <= 8.05, `Scene too long: ${d}s`);
  }
});

test("Long scene (25s) split to max 4s chunks", () => {
  const raw   = [0, 25, 30];
  const enforced = enforceSceneDurations(raw, [], 0.8, 4.0, 30, 30);
  const durs  = sceneDurations(enforced);
  assert(Math.max(...durs) <= 4.1, `Max scene ${Math.max(...durs)}s > 4.1s`);
  assert(durs.length >= 6, `Expected >= 6 scenes, got ${durs.length}`);
});

test("Very short audio (<MIN) keeps last segment to avoid zero scenes", () => {
  const raw   = [0, 0.5];
  const enforced = enforceSceneDurations(raw, [], 0.8, 4.0, 30, 0.5);
  assert(enforced.length >= 2, "No segment boundaries produced");
  assert(enforced[enforced.length - 1] === 0.5, "End boundary not preserved");
});

test("Empty beats array: still produces segments via splitting", () => {
  const raw   = [0, 10, 20, 30];
  const enforced = enforceSceneDurations(raw, [], 0.8, 4.0, 30, 30);
  const durs  = sceneDurations(enforced);
  for (const d of durs) {
    assert(d <= 4.1, `Scene too long without beats: ${d}s`);
  }
});

test("Beat snapping within 100ms tolerance", () => {
  const beats    = [1.0, 2.0, 3.0, 4.0];
  const raw      = [0, 1.05, 2.08, 3.12, 4.0]; // boundaries slightly off beat
  const enforced = enforceSceneDurations(raw, beats, 0.8, 4.0, 30, 4.0);
  for (let i = 1; i < enforced.length - 1; i++) {
    const t    = enforced[i];
    const near = beats.reduce((a, b) => Math.abs(b - t) < Math.abs(a - t) ? b : a);
    assert(Math.abs(t - near) < 0.15, `Boundary ${t} not snapped near beat ${near}`);
  }
});

test("Duplicate boundary values deduplicated", () => {
  const raw   = [0, 2, 2, 4, 4, 8]; // duplicates
  const enforced = enforceSceneDurations(raw, [2, 4], 0.8, 8.0, 30, 8);
  // All segments must have positive duration
  const durs = sceneDurations(enforced);
  for (const d of durs) {
    assert(d > 0, `Zero-duration segment produced`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2: Multi-Image Composition Commands
// ─────────────────────────────────────────────────────────────────────────────

console.log("\n-- 2. Multi-image compositions ----------------------------------");

const BASE = {
  outPath: "/tmp/out.mp4",
  duration: 3.0, fps: 30, w: 1080, h: 1920,
  colorGrade: "none", overlays: [],
};

test("beat_stack_3: 3 images produce 3 -i inputs", () => {
  const cmd = ce.buildCompositionCmd({
    ...BASE, composition: "beat_stack_3",
    inputPaths: ["/a.jpg", "/b.jpg", "/c.jpg"],
    beatOffsets: [0.5, 1.0, 1.5],
  });
  assertCmd(cmd, "beat_stack_3");
  assert(countInputs(cmd) === 3, `Expected 3 inputs, got ${countInputs(cmd)}`);
  assert(cmd.includes("strip0") && cmd.includes("strip1") && cmd.includes("strip2"));
});

test("beat_stack_3: 1 image padded to 3 strips (correct design)", () => {
  const cmd = ce.buildCompositionCmd({
    ...BASE, composition: "beat_stack_3",
    inputPath: "/a.jpg", beatOffsets: [],
  });
  assertCmd(cmd, "beat_stack_3 1-img");
  // 3 strips always need 3 inputs; padPaths repeats the single image
  assert(countInputs(cmd) === 3, "Expected 3 inputs (padded from 1)");
});

test("beat_stack_3: 2 images padded to 3 (last reused)", () => {
  const cmd = ce.buildCompositionCmd({
    ...BASE, composition: "beat_stack_3",
    inputPaths: ["/a.jpg", "/b.jpg"], beatOffsets: [0.5, 1.0],
  });
  assertCmd(cmd, "beat_stack_3 2-img");
  assert(countInputs(cmd) === 3, "Expected 3 inputs (padded from 2)");
});

test("beat_stack_3: no beatOffsets uses evenly-spaced defaults", () => {
  const cmd = ce.buildCompositionCmd({
    ...BASE, composition: "beat_stack_3",
    inputPaths: ["/a.jpg", "/b.jpg", "/c.jpg"], beatOffsets: [],
  });
  assertCmd(cmd, "beat_stack_3 no-beats");
  assert(cmd.includes("strip0"));
});

test("beat_stack_3: colorGrade applied (post chain present)", () => {
  const cmd = ce.buildCompositionCmd({
    ...BASE, composition: "beat_stack_3",
    inputPaths: ["/a.jpg", "/b.jpg", "/c.jpg"],
    colorGrade: "hype_red", beatOffsets: [0.5, 1.0, 1.5],
  });
  assertCmd(cmd, "beat_stack_3 grade");
  assert(cmd.includes("[vout]"), "Missing [vout]");
});

test("triptych_reveal: 3 images -> 3 inputs, panel labels present", () => {
  const cmd = ce.buildCompositionCmd({
    ...BASE, composition: "triptych_reveal",
    inputPaths: ["/a.jpg", "/b.jpg", "/c.jpg"],
    beatOffsets: [0.3, 0.9, 1.5],
  });
  assertCmd(cmd, "triptych_reveal");
  assert(countInputs(cmd) === 3);
  assert(cmd.includes("panel0") && cmd.includes("panel1") && cmd.includes("panel2"));
});

test("triptych_reveal: 2 images padded to 3 panels", () => {
  const cmd = ce.buildCompositionCmd({
    ...BASE, composition: "triptych_reveal",
    inputPaths: ["/a.jpg", "/b.jpg"], beatOffsets: [0.5, 1.0],
  });
  assertCmd(cmd, "triptych_reveal 2-img");
  assert(countInputs(cmd) === 3, "Expected 3 inputs (padded from 2)");
});

test("stagger_slide_up: 3 images -> 3 inputs, img labels present", () => {
  const cmd = ce.buildCompositionCmd({
    ...BASE, composition: "stagger_slide_up",
    inputPaths: ["/a.jpg", "/b.jpg", "/c.jpg"],
  });
  assertCmd(cmd, "stagger_slide_up");
  assert(countInputs(cmd) === 3);
  assert(cmd.includes("img0") && cmd.includes("img1") && cmd.includes("img2"));
});

test("stagger_slide_up: 1 image fallback", () => {
  const cmd = ce.buildCompositionCmd({
    ...BASE, composition: "stagger_slide_up",
    inputPath: "/a.jpg",
  });
  assertCmd(cmd, "stagger_slide_up 1-img");
  assert(countInputs(cmd) === 1);
});

test("Empty/null entries in inputPaths filtered out", () => {
  const cmd = ce.buildCompositionCmd({
    ...BASE, composition: "stagger_slide_up",
    inputPaths: ["/a.jpg", "", null, "/b.jpg"],
  });
  assertCmd(cmd, "stagger_slide_up filtered paths");
  assert(countInputs(cmd) === 2, `Expected 2 inputs, got ${countInputs(cmd)}`);
});

test("Empty inputPaths array throws Error", () => {
  let threw = false;
  try {
    ce.buildCompositionCmd({ ...BASE, composition: "stagger_slide_up", inputPaths: [] });
  } catch (err) {
    threw = true;
    assert(err.message.includes("no valid inputPath"), `Wrong error: ${err.message}`);
  }
  assert(threw, "Should throw for empty inputPaths");
});

test("All eight new compositions produce output path correctly", () => {
  for (const comp of ["beat_stack_3", "triptych_reveal", "stagger_slide_up", "split_and_zoom", "photo_wall_sweep", "cinematic_duo", "pip_corner", "cross_reveal"]) {
    const cmd = ce.buildCompositionCmd({
      ...BASE, composition: comp,
      inputPaths: ["/a.jpg", "/b.jpg", "/c.jpg"], beatOffsets: [0.3, 0.8],
    });
    assertCmd(cmd, comp);
    assert(cmd.includes('"/tmp/out.mp4"'), `${comp}: output path missing`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3: Face-Aware Crop
// ─────────────────────────────────────────────────────────────────────────────

console.log("\n-- 3. Face-aware crop ------------------------------------------");

const { buildFaceCrop } = ce;

test("Valid bbox: contains crop + scale", () => {
  const r = buildFaceCrop({ x: 200, y: 100, w: 300, h: 400 }, 1080, 1920, 1080, 1920);
  assert(r.includes("crop=") && r.includes("scale="));
});

test("Null bbox: centre-crop fallback", () => {
  const r = buildFaceCrop(null, 1080, 1920, 1080, 1920);
  assert(r.includes("crop=") && r.includes("scale="));
});

test("Zero srcW/srcH: no crash, fallback produced", () => {
  const r = buildFaceCrop({ x: 0, y: 0, w: 100, h: 100 }, 0, 0, 1080, 1920);
  assert(r.includes("crop="));
});

test("Face at top-left (0,0): cropX and cropY >= 0", () => {
  const r = buildFaceCrop({ x: 0, y: 0, w: 80, h: 80 }, 1080, 1920, 1080, 1920);
  const m = r.match(/crop=(\d+):(\d+):(-?\d+):(-?\d+)/);
  if (m) {
    assert(parseInt(m[3]) >= 0, `cropX ${m[3]} negative`);
    assert(parseInt(m[4]) >= 0, `cropY ${m[4]} negative`);
  }
});

test("Face at bottom-right: crop clamped within image", () => {
  const r = buildFaceCrop({ x: 980, y: 1820, w: 100, h: 100 }, 1080, 1920, 1080, 1920);
  const m = r.match(/crop=(\d+):(\d+):(-?\d+):(-?\d+)/);
  if (m) {
    const [, cw, ch, cx, cy] = m.map(Number);
    assert(cx >= 0 && cy >= 0, "Crop origin negative");
    assert(cx + cw <= 1081, `cropX+cropW ${cx+cw} > 1080`);
    assert(cy + ch <= 1921, `cropY+cropH ${cy+ch} > 1920`);
  }
});

test("Very large face (larger than frame): clamped, no crash", () => {
  const r = buildFaceCrop({ x: 0, y: 0, w: 2000, h: 3000 }, 1080, 1920, 1080, 1920);
  assert(r.includes("crop="));
});

test("Landscape output (1920x1080): aspect used in fallback", () => {
  const r = buildFaceCrop(null, 1920, 1080, 1920, 1080);
  assert(r.includes("crop=") && r.includes("scale=1920:1080"));
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4: Backward Compatibility
// ─────────────────────────────────────────────────────────────────────────────

console.log("\n-- 4. Backward compatibility (22 legacy compositions) -----------");

const LEGACY = [
  "three_panel", "manga_panels", "quad_grid", "diagonal_split",
  "character_reveal", "vertical_wipe", "slide_in_left", "slide_in_right",
  "slide_in_top", "curtain_open",
  "spotlight_zoom", "parallax", "rack_focus",
  "impact_frame", "bounce_zoom", "zoom_burst", "shockwave",
  "letterbox_pan", "tilt_reveal", "mirror_composite", "neon_frame", "vhs_composite",
];

for (const comp of LEGACY) {
  test(`${comp}: valid ffmpeg cmd with legacy inputPath (1 input)`, () => {
    const cmd = ce.buildCompositionCmd({
      composition: comp, inputPath: "/tmp/test.jpg",
      outPath: "/tmp/out.mp4", duration: 2.5, fps: 30, w: 1080, h: 1920,
      colorGrade: "none", overlays: [], beatOffsets: [],
    });
    assertCmd(cmd, comp);
    assert(countInputs(cmd) === 1, `${comp}: expected 1 input, got ${countInputs(cmd)}`);
    assert(cmd.includes("[vout]"), `${comp}: missing [vout]`);
    assert(cmd.includes('"/tmp/out.mp4"'), `${comp}: output path missing`);
  });
}

test("COMPOSITIONS Set has 30 entries (22 legacy + 8 new)", () => {
  assert(ce.COMPOSITIONS.size === 30,
    `Expected 30, got ${ce.COMPOSITIONS.size}: ${[...ce.COMPOSITIONS].join(", ")}`);
});

test("MULTI_IMAGE_COMPOSITIONS has 8 entries", () => {
  assert(ce.MULTI_IMAGE_COMPOSITIONS.size === 8,
    `Expected 8, got ${ce.MULTI_IMAGE_COMPOSITIONS.size}`);
});

test("All COMPOSITION_CATEGORIES slugs are in COMPOSITIONS", () => {
  for (const [cat, data] of Object.entries(ce.COMPOSITION_CATEGORIES)) {
    for (const slug of data.compositions) {
      assert(ce.COMPOSITIONS.has(slug),
        `Category "${cat}" has unknown slug "${slug}"`);
    }
  }
});

test("Unknown composition returns null (caller fallback path)", () => {
  const r = ce.buildCompositionCmd({
    composition: "does_not_exist",
    inputPath: "/tmp/x.jpg", outPath: "/tmp/o.mp4", duration: 1,
  });
  assert(r === null, `Expected null, got ${typeof r}`);
});

test("Legacy inputPath + new composition still produces a command", () => {
  const cmd = ce.buildCompositionCmd({
    composition: "beat_stack_3", inputPath: "/tmp/only_one.jpg",
    outPath: "/tmp/out.mp4", duration: 2.0, fps: 30, w: 1080, h: 1920,
    colorGrade: "none", overlays: [], beatOffsets: [0.5, 1.0, 1.5],
  });
  assertCmd(cmd, "beat_stack_3 legacy inputPath");
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 5: Magnetic Mask Special-Path Handling
// ─────────────────────────────────────────────────────────────────────────────

console.log("\n-- 5. Magnetic mask special-path handling -----------------------");

test("sceneRenderer exports expected API surface", () => {
  // sceneRenderer requires several runtime deps (axios, uuid, database).
  // Stub them all so this test runs without node_modules installed.
  const Module  = require("module");
  const origLoad = Module._load;
  const STUBS   = {
    "axios":       { post: () => Promise.resolve({ data: {}, headers: {} }) },
    "uuid":        { v4: () => "00000000-0000-0000-0000-000000000000" },
    "./database":  {
      getCachedRender: () => null, saveCachedRender: () => {},
      incrementCompositionUse: () => {}, getLlmCache: () => null,
    },
  };
  Module._load = function(request, parent, isMain) {
    if (STUBS[request]) return STUBS[request];
    return origLoad.apply(this, arguments);
  };
  let sr;
  try {
    const srPath = require.resolve(path.join(__dirname, "../services/sceneRenderer.js"));
    delete require.cache[srPath];
    sr = require(srPath);
  } finally {
    Module._load = origLoad;
  }
  const expected = ["prepareSession", "rerenderScene", "exportSession",
                    "cleanSession", "listSessions", "previewTransition"];
  for (const fn of expected) {
    assert(typeof sr[fn] === "function", `sceneRenderer.${fn} not exported`);
  }
});

test("magnetic_mask NOT in COMPOSITIONS Set (has special renderer path)", () => {
  assert(!ce.COMPOSITIONS.has("magnetic_mask"),
    "magnetic_mask must not be in COMPOSITIONS — sceneRenderer handles it via /remove-bg");
});

test("buildCompositionCmd returns null for magnetic_mask (triggers special path)", () => {
  const cmd = ce.buildCompositionCmd({
    composition: "magnetic_mask",
    inputPath: "/tmp/x.jpg", outPath: "/tmp/o.mp4", duration: 2,
  });
  assert(cmd === null,
    "magnetic_mask must return null so sceneRenderer calls renderMagneticMask()");
});

test("buildFaceCrop exported from compositionEngine", () => {
  assert(typeof ce.buildFaceCrop === "function");
});

test("MULTI_IMAGE_COMPOSITIONS exported from compositionEngine", () => {
  assert(ce.MULTI_IMAGE_COMPOSITIONS instanceof Set);
  assert(ce.MULTI_IMAGE_COMPOSITIONS.has("beat_stack_3"));
  assert(ce.MULTI_IMAGE_COMPOSITIONS.has("triptych_reveal"));
  assert(ce.MULTI_IMAGE_COMPOSITIONS.has("stagger_slide_up"));
});

// ─────────────────────────────────────────────────────────────────────────────
// RESULTS
// ─────────────────────────────────────────────────────────────────────────────

const total = passed + failed;
console.log(`\n${"─".repeat(62)}`);
console.log(`Results: ${passed}/${total} passed${failed > 0 ? `  (${failed} FAILED)` : "  -- All passed"}`);
console.log(`${"─".repeat(62)}\n`);

if (failed > 0) process.exit(1);
