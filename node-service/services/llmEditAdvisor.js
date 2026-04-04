/**
 * LLM Edit Advisor v4.0
 *
 * v4 changes:
 *   - LLM result cache: same audio+images → skip API call
 *   - BYOK support: accept API keys passed per-request (not just .env)
 *   - Better error logging for 400/401/402 errors
 *   - Returns null on 0 results so classifier fallback runs
 *
 * Provider priority (auto-detected from .env or per-request):
 *   1. Anthropic Claude (claude-haiku-4-5-20251001)
 *   2. Gemini (gemini-2.0-flash-lite)
 *   3. OpenAI (gpt-4o-mini)
 */

const axios  = require("axios");
const crypto = require("crypto");

const { COMPOSITIONS } = require("./compositionEngine");
const { MOTION_EFFECTS, TRANSITIONS, COLOR_GRADES, OVERLAYS } = require("./effectsLibrary");
const db = require("./database");

// ─── PROVIDER DETECTION ───────────────────────────────────────────────────────

function getProvider(byokKeys = {}) {
  // FIX: BYOK keys always win over .env keys — a user-supplied working key
  // should never be shadowed by a broken/empty key in the environment.
  // Priority within each tier: anthropic > gemini > openai
  if (byokKeys.anthropic) return "anthropic";
  if (byokKeys.gemini)    return "gemini";
  if (byokKeys.openai)    return "openai";
  // Fall back to .env only when no BYOK key is provided at all
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (process.env.GEMINI_API_KEY)    return "gemini";
  if (process.env.OPENAI_API_KEY)    return "openai";
  return null;
}

function getKey(provider, byokKeys = {}) {
  // BYOK key takes precedence over .env key for the chosen provider
  if (provider === "anthropic") return byokKeys.anthropic || process.env.ANTHROPIC_API_KEY;
  if (provider === "gemini")    return byokKeys.gemini    || process.env.GEMINI_API_KEY;
  if (provider === "openai")    return byokKeys.openai    || process.env.OPENAI_API_KEY;
  return null;
}

// ─── LLM RESULT CACHE ───────────────────────────────────────────────────────

function buildLlmCacheKey(audioPath, imagePaths, sceneCount, provider = "unknown") {
  const fs = require("fs");
  let audioHash = "no_audio";
  try {
    const fd  = fs.openSync(audioPath, "r");
    const buf = Buffer.alloc(262144); // 256KB
    const read = fs.readSync(fd, buf, 0, 262144, 0);
    fs.closeSync(fd);
    audioHash = crypto.createHash("md5").update(buf.slice(0, read)).digest("hex");
  } catch {}

  const imageHash = crypto.createHash("md5")
    .update((imagePaths || []).sort().join("|"))
    .digest("hex").slice(0, 16);

  // FIX: include provider so switching from a failed Anthropic key to a
  // working Gemini key doesn't serve a stale empty-result cache entry.
  return `llm_${provider}_${audioHash}_${imageHash}_${sceneCount}`;
}

// ─── ANTHROPIC CLAUDE ─────────────────────────────────────────────────────────

async function callClaude(prompt, explicitKey) {
  const key = explicitKey || process.env.ANTHROPIC_API_KEY;
  if (!key) return null;

  // Warn about common key issues
  if (key.endsWith("$") || key.length < 40) {
    console.warn(`   ⚠️  ANTHROPIC_API_KEY looks truncated (${key.length} chars, ends with '${key.slice(-1)}')`);
    console.warn(`      Check .env for trailing $ or missing characters`);
  }

  try {
    const res = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-haiku-4-5-20251001",
        max_tokens: 4096,
        messages: [
          {
            role: "user",
            content: prompt + "\n\nRespond ONLY with a valid JSON array. No markdown, no explanation, just the JSON array.",
          },
        ],
      },
      {
        headers: {
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        timeout: 30000,
      }
    );

    const text = res.data.content?.[0]?.text;
    if (!text) return null;

    // Strip any accidental markdown fences
    const clean = text.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();

    try {
      return JSON.parse(clean);
    } catch (e) {
      const repaired = repairJson(clean);
      if (repaired) return repaired;
      console.warn(`   ⚠️  Claude JSON parse error: ${e.message}`);
      return null;
    }
  } catch (e) {
    const status = e.response?.status;
    const errBody = e.response?.data;
    if (status === 529 || status === 429) {
      console.warn(`   ⚠️  Claude rate limited (${status}) — retrying in 5s...`);
      await new Promise(r => setTimeout(r, 5000));
      return callClaude(prompt); // one retry
    }
    // Log the actual error body for debugging
    if (status === 400 && errBody) {
      const errMsg = errBody?.error?.message || JSON.stringify(errBody).slice(0, 200);
      console.warn(`   ⚠️  Claude 400 Bad Request: ${errMsg}`);
      console.warn(`      → Check ANTHROPIC_API_KEY in .env (no trailing $, full key)`);
    } else {
      console.warn(`   ⚠️  Claude advisor: ${e.message}`);
    }
    return null;
  }
}

// ─── GEMINI ───────────────────────────────────────────────────────────────────

// Single model — if it fails for any reason, fall back to pattern classifier immediately.
// No retries, no model-hopping. Keeps things fast and avoids rate-limit storms.
const GEMINI_MODEL = "gemini-2.0-flash";

async function callGemini(prompt, explicitKey) {
  const key = explicitKey || process.env.GEMINI_API_KEY;
  if (!key) return null;

  console.log("   🔄 Calling Gemini (" + GEMINI_MODEL + ")...");
  try {
    const res = await axios.post(
      "https://generativelanguage.googleapis.com/v1beta/models/" + GEMINI_MODEL + ":generateContent?key=" + key,
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0.65,
          maxOutputTokens: 8192,
        },
      },
      { timeout: 60000 }
    );
    const text = res.data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      const repaired = repairJson(text);
      return repaired || null;
    }
  } catch (e) {
    const status = e.response?.status;
    if (status === 429) {
      console.warn("   ⚠️  Gemini rate limited — falling back to pattern classifier");
      console.warn("   💡 Tip: wait 60s before generating again, or use an Anthropic/OpenAI key instead");
    } else if (status === 404) {
      console.warn("   ⚠️  Gemini model not found — check your API key has access to " + GEMINI_MODEL);
    } else {
      console.warn("   ⚠️  Gemini failed (" + (status || e.message) + ") — falling back to pattern classifier");
    }
    return null;
  }
}

// ─── OPENAI ───────────────────────────────────────────────────────────────────

async function callOpenAI(prompt, explicitKey) {
  const key = explicitKey || process.env.OPENAI_API_KEY;
  if (!key) return null;

  console.log("   🔄 Calling OpenAI (gpt-4o-mini)...");
  try {
    const res = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "You are a professional AMV editor. Always respond with a valid JSON array only, no markdown, no extra text." },
          { role: "user", content: prompt },
        ],
        max_tokens: 8192,
        temperature: 0.65,
        response_format: { type: "json_object" },
      },
      {
        headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
        timeout: 60000,
      }
    );
    const text = res.data.choices?.[0]?.message?.content;
    if (!text) {
      console.warn("   ⚠️  OpenAI returned empty response — falling back to pattern classifier");
      return null;
    }
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
    // GPT wraps array in an object key — unwrap it
    const arr = parsed.scenes || parsed.edits || parsed.results || parsed.data || Object.values(parsed).find(v => Array.isArray(v));
    if (Array.isArray(arr)) return arr;
    console.warn("   ⚠️  OpenAI response not an array — falling back to pattern classifier");
    return null;
  } catch (e) {
    const status = e.response?.status;
    if (status === 429) {
      console.warn("   ⚠️  OpenAI rate limited — falling back to pattern classifier");
      console.warn("   💡 Tip: wait 60s before generating again");
    } else {
      console.warn("   ⚠️  OpenAI failed (" + (status || e.message) + ") — falling back to pattern classifier");
    }
    return null;
  }
}

// ─── JSON REPAIR ──────────────────────────────────────────────────────────────

function repairJson(text) {
  try {
    const lastClose = text.lastIndexOf("}");
    if (lastClose < 0) return null;
    const trimmed = text.substring(0, lastClose + 1);
    const opens  = (trimmed.match(/\[/g) || []).length;
    const closes = (trimmed.match(/\]/g) || []).length;
    return JSON.parse(trimmed + "]".repeat(Math.max(0, opens - closes)));
  } catch { return null; }
}

// ─── UNIFIED CALL ─────────────────────────────────────────────────────────────

async function callLLM(prompt, byokKeys = {}) {
  const provider = getProvider(byokKeys);
  if (!provider) return null;
  const key = getKey(provider, byokKeys);

  if (provider === "anthropic") return callClaude(prompt, key);
  if (provider === "gemini")    return callGemini(prompt, key);
  if (provider === "openai")    return callOpenAI(prompt, key);
  return null;
}


function buildScenePrompt(scenes) {
  const totalScenes = scenes.length;

  // Derive global song context from scene data
  const globalBpm = scenes[0]?.segmentFeatures?.bpm || 120;
  const allEnergies = scenes.map(s => s.segmentFeatures?.energy || s.dropStrength || 0.5);
  const avgEnergy = allEnergies.reduce((a, b) => a + b, 0) / allEnergies.length;
  const peakEnergy = Math.max(...allEnergies);
  const allEmotions = scenes.map(s => s.emotion || "neutral");
  const emotionCounts = allEmotions.reduce((a, e) => { a[e] = (a[e]||0)+1; return a; }, {});
  const dominantEmotion = Object.entries(emotionCounts).sort((a,b) => b[1]-a[1])[0]?.[0] || "neutral";
  const tempoLabel = globalBpm > 145 ? "very fast" : globalBpm > 120 ? "fast" : globalBpm > 95 ? "medium" : "slow";
  const moodLabel = dominantEmotion === "hype" ? "high-energy action" :
    dominantEmotion === "sad" ? "melancholic/emotional" :
    dominantEmotion === "romantic" ? "romantic/hopeful" :
    dominantEmotion === "triumphant" ? "epic/triumphant" : "neutral";

  // Build scene descriptions — compact, signal-bearing only
  const sceneDescriptions = scenes.map((s, i) => {
    const vf  = s.visualFeatures || {};
    const sf  = s.segmentFeatures || {};
    const globalPos = (s._globalIndex !== undefined ? s._globalIndex : i) / Math.max(1, (s._totalScenes || totalScenes) - 1);
    const section =
      globalPos < 0.08 ? "INTRO" :
      globalPos > 0.90 ? "OUTRO" :
      globalPos < 0.25 ? "VERSE_1" :
      globalPos < 0.45 ? "CHORUS_1" :
      globalPos < 0.55 ? "BRIDGE" :
      globalPos < 0.75 ? "CHORUS_2" : "CLIMAX";

    const tags = [];
    if (vf.face_present)                                           tags.push("FACE");
    if (vf.action_scene)                                           tags.push("ACTION");
    if (vf.dark_scene)                                             tags.push("DARK");
    else if (vf.mean_brightness > 0.7)                            tags.push("BRIGHT");
    if (vf.warm_dominant)                                          tags.push("WARM");
    else if (vf.color_temperature !== undefined && vf.color_temperature < 0.35) tags.push("COLD");
    if (vf.saturation > 0.6)                                       tags.push("VIVID");
    else if (vf.saturation < 0.2)                                  tags.push("DESATURATED");
    if (vf.edge_density > 0.35)                                    tags.push("DETAILED");
    if (vf.contrast > 0.4)                                         tags.push("HIGH_CONTRAST");
    if (tags.length === 0)                                          tags.push("NEUTRAL");

    const energy = sf.energy !== undefined ? sf.energy : (s.dropStrength || 0);
    const energyLabel = energy > 0.75 ? "HIGH" : energy > 0.45 ? "MED" : "LOW";
    const onsetHint = sf.onset_sharpness !== undefined
      ? (sf.onset_sharpness > 0.6 ? " sharp_hit" : sf.onset_sharpness < 0.3 ? " smooth_melodic" : "")
      : "";

    return "S" + (i+1) + "[" + section + "] " + (s.emotion||"neutral") + " " + energyLabel + "(" + energy.toFixed(2) + ")" + onsetHint + " " + s.duration.toFixed(1) + "s | " + tags.join(" ");
  }).join("\n");

  const COMP_LIST = [
    "three_panel","manga_panels","quad_grid","diagonal_split",
    "character_reveal","vertical_wipe","slide_in_left","slide_in_right","slide_in_top","curtain_open",
    "spotlight_zoom","parallax","rack_focus",
    "impact_frame","bounce_zoom","zoom_burst","shockwave",
    "letterbox_pan","tilt_reveal","mirror_composite","neon_frame","vhs_composite",
  ].join(", ");

  const EFFECT_LIST = [
    "zoom_pulse","zoom_punch","zoom_punch_out","zoom_in","zoom_out",
    "ken_burns","ken_burns_fast","ken_burns_slow",
    "pan_left","pan_right","drift_left","drift_right",
    "breathe","breathe_fast","breathe_slow",
    "shake_horizontal","shake_vertical",
    "glitch_horizontal","glitch_flash","vhs_shake",
    "speed_ramp_in","speed_ramp_out","freeze_punch","echo_trail","static",
  ].join(", ");

  const TRANS_LIST = [
    "flash_white","flash_black","strobe_cut",
    "zoom_blur_in","zoom_blur_out","cross_zoom",
    "whip_pan_left","whip_pan_right","push_left","push_right","wipe_down",
    "slice_left","slice_right",
    "dissolve","dissolve_fast","dissolve_slow","dissolve_glow",
    "fadeblack","fadeblack_fast","fadeblack_slow","fadewhite",
    "glitch_cut","pixelize",
  ].join(", ");

  const GRADE_LIST = [
    "hype_red","hype_blue","hype_green","hype_purple",
    "sad_blue","sad_grey","cold_steel",
    "romantic_warm","romantic_soft","sunset_gold",
    "cinematic","teal_orange","anime_bright",
    "triumphant_gold","horror_red","vintage","manga","neon","none",
  ].join(", ");

  const OVERLAY_LIST = [
    "vignette","vignette_strong",
    "film_grain","film_grain_heavy",
    "scanlines","scanlines_strong",
    "speed_lines","chromatic_aberration","chromatic_strong",
    "glow_soft","lens_flare","particles",
    "rain","snow","dirt_overlay","halftone",
  ].join(", ");

  return (
    "You are an expert AMV (Anime Music Video) editor. Assign visual style to each of these " + totalScenes + " scenes.\n" +
    "\n" +
    "SONG CONTEXT:\n" +
    "- BPM: " + globalBpm + " (" + tempoLabel + " tempo)\n" +
    "- Overall mood: " + moodLabel + "\n" +
    "- Average energy: " + (avgEnergy*100).toFixed(0) + "% | Peak energy: " + (peakEnergy*100).toFixed(0) + "%\n" +
    "- Total scenes: " + totalScenes + "\n" +
    "\n" +
    "YOUR TASK: For each scene assign composition, effect, transition, colorGrade, and overlays.\n" +
    "Decisions must match the scene energy, emotion, visual content, and song structure position\n" +
    "(INTRO -> VERSE_1 -> CHORUS_1 -> BRIDGE -> CHORUS_2 -> CLIMAX -> OUTRO).\n" +
    "\n" +
    "=== AVAILABLE VALUES (ONLY use names from these exact lists) ===\n" +
    "\n" +
    "COMPOSITIONS (special FFmpeg multi-layer layouts — use for ~45% of scenes):\n" +
    COMP_LIST + "\n" +
    "\n" +
    "Composition rules:\n" +
    "- INTRO: character_reveal, letterbox_pan, slide_in_left, or tilt_reveal\n" +
    "- FACE scene: spotlight_zoom (dramatic) or rack_focus (intimate)\n" +
    "- ACTION + HIGH energy: impact_frame, shockwave, bounce_zoom, zoom_burst\n" +
    "- DARK/MOODY scene: mirror_composite, vhs_composite, neon_frame\n" +
    "- BRIGHT/VIVID/DETAILED scene: manga_panels, three_panel, quad_grid\n" +
    "- CHORUS/CLIMAX peak: impact_frame or shockwave (most impactful)\n" +
    "- OUTRO: letterbox_pan or parallax\n" +
    "- Never repeat same composition in consecutive scenes\n" +
    "- Use string \"none\" when not using a composition\n" +
    "\n" +
    "EFFECTS (motion applied to image — used when composition is none):\n" +
    EFFECT_LIST + "\n" +
    "\n" +
    "Effect guide:\n" +
    "- HIGH energy/hype: zoom_punch, shake_horizontal, zoom_pulse, breathe_fast, speed_ramp_in\n" +
    "- MED energy/neutral: ken_burns, ken_burns_fast, zoom_in, pan_left, pan_right\n" +
    "- LOW energy/sad: ken_burns_slow, breathe_slow, drift_left, echo_trail\n" +
    "- FACE without composition: breathe, zoom_in (keeps face centered)\n" +
    "- sharp_hit onset: freeze_punch, zoom_punch (snaps on the beat)\n" +
    "- smooth_melodic onset: breathe_slow, ken_burns_slow, echo_trail\n" +
    "\n" +
    "TRANSITIONS (how scene cuts to next — scene 1 must always be dissolve):\n" +
    TRANS_LIST + "\n" +
    "\n" +
    "Transition guide:\n" +
    "- HIGH energy drop: flash_white, flash_black, strobe_cut, zoom_blur_in, whip_pan_left, whip_pan_right\n" +
    "- MED energy: cross_zoom, push_left, push_right, slice_left, dissolve_fast\n" +
    "- LOW energy/emotional: dissolve, dissolve_glow, dissolve_slow, fadeblack\n" +
    "- OUTRO: fadeblack_slow, dissolve_glow\n" +
    "\n" +
    "COLOR GRADES:\n" +
    GRADE_LIST + "\n" +
    "\n" +
    "Grade guide:\n" +
    "- hype/action: hype_red, hype_blue, hype_purple, neon, cold_steel\n" +
    "- sad/melancholic: sad_blue, sad_grey, vintage\n" +
    "- romantic/hopeful: romantic_warm, romantic_soft, sunset_gold\n" +
    "- epic/triumphant: triumphant_gold, cinematic, teal_orange\n" +
    "- DARK visual: neon, cold_steel, horror_red\n" +
    "- BRIGHT/VIVID visual: anime_bright, cinematic, teal_orange\n" +
    "- DESATURATED visual: manga (dramatic B&W)\n" +
    "\n" +
    "OVERLAYS (texture layers — always include vignette or vignette_strong):\n" +
    OVERLAY_LIST + "\n" +
    "\n" +
    "Overlay guide (max 2 per scene):\n" +
    "- Default: [\"vignette\"]\n" +
    "- Action/hype: [\"vignette\", \"speed_lines\"] or [\"vignette\", \"chromatic_aberration\"]\n" +
    "- Peak drops: [\"vignette\", \"chromatic_strong\"] or [\"vignette\", \"lens_flare\"]\n" +
    "- Emotional/sad: [\"vignette\", \"film_grain\"] or [\"vignette\", \"glow_soft\"]\n" +
    "- VHS/retro: [\"vignette\", \"scanlines\"] or [\"vignette\", \"film_grain_heavy\"]\n" +
    "- DARK dramatic: [\"vignette_strong\"]\n" +
    "\n" +
    "=== SCENES ===\n" +
    "Format: S[num][section] emotion energy(0-1) onset_type duration | visual_tags\n" +
    "\n" +
    sceneDescriptions + "\n" +
    "\n" +
    "=== OUTPUT FORMAT ===\n" +
    "Return ONLY a valid JSON array, no markdown, no extra text.\n" +
    "One object per scene, numbered 1 to " + totalScenes + ":\n" +
    "\n" +
    "[{\"scene\":1,\"composition\":\"character_reveal\",\"effect\":\"ken_burns_slow\",\"transition\":\"dissolve\",\"colorGrade\":\"cinematic\",\"overlays\":[\"vignette\",\"film_grain\"],\"reasoning\":\"INTRO face — cinematic reveal sets the tone\"}, ...]\n" +
    "\n" +
    "CRITICAL RULES:\n" +
    "1. Return exactly " + totalScenes + " objects (scenes 1 through " + totalScenes + ")\n" +
    "2. Only use values from the exact lists above — any other value is rejected and ignored\n" +
    "3. composition must be the string \"none\" when not using a layout\n" +
    "4. overlays must always contain \"vignette\" or \"vignette_strong\"\n" +
    "5. Scene 1 transition must always be \"dissolve\"\n" +
    "6. Match the dominant mood (" + moodLabel + ") consistently across the AMV"
  );
}

// ─── MAIN: ADVISE ALL SCENES ──────────────────────────────────────────────────

async function adviseScenesWithLLM(scenes, { byokKeys = {}, audioPath = "", imagePaths = [] } = {}) {
  const provider = getProvider(byokKeys);
  if (!provider) {
    console.log("   ⚠️  No LLM API key — using pattern classifier");
    return null;
  }

  // ── CHECK LLM CACHE ─────────────────────────────────────────────────────
  const cacheKey = buildLlmCacheKey(audioPath, imagePaths, scenes.length, provider);
  const cached = db.getLlmCache(cacheKey);
  if (cached && cached.result && Array.isArray(cached.result) && cached.result.length === scenes.length) {
    console.log(`   ♻️  LLM cache HIT: ${cacheKey.slice(0, 20)}… (${cached.hit_count} prev hits)`);
    // Apply cached results to scenes
    return scenes.map((scene, i) => {
      const sug = cached.result[i];
      if (!sug) return scene;
      return {
        ...scene,
        composition:  (sug.composition && sug.composition !== "none" && COMPOSITIONS.has(sug.composition)) ? sug.composition : null,
        effect:       MOTION_EFFECTS.has(sug.effect) ? sug.effect : (scene.effect || "ken_burns"),
        transition:   TRANSITIONS.has(sug.transition) ? sug.transition : (scene.transition || "dissolve"),
        colorGrade:   COLOR_GRADES.has(sug.colorGrade) ? sug.colorGrade : (scene.colorGrade || "none"),
        overlays:     (sug.overlays || []).filter(o => OVERLAYS.has(o)),
        llmReasoning: sug.reasoning || "",
        editSource:   "llm_cached",
      };
    });
  }

  // ── CALL LLM ────────────────────────────────────────────────────────────
  const providerLabel = { anthropic: "Claude ✦", gemini: "Gemini", openai: "GPT-4o-mini" }[provider] || provider;
  const isUserKey = !!(byokKeys.anthropic || byokKeys.gemini || byokKeys.openai);
  console.log(`   🤖 LLM Edit Advisor [${providerLabel}${isUserKey ? " BYOK" : ""}]: analyzing ${scenes.length} scenes...`);

  // FIX: For Gemini (free tier = 15 RPM), send ALL scenes in ONE request to
  // avoid the multi-batch rate-limit storm. Anthropic handles larger contexts
  // well too. Only fall back to batching if the single-shot call fails.
  const allSuggestions = [];

  // Batch sizes: Gemini free tier — 1 big request. Anthropic/OpenAI — 8 per batch.
  // Send all scenes in ONE request for every provider — avoids rate-limit storms from multi-batch
  const batchSize = scenes.length;
  const interBatchDelay = 1000; // only relevant if scenes.length somehow exceeds batchSize

  for (let i = 0; i < scenes.length; i += batchSize) {
    const batch    = scenes.slice(i, i + batchSize).map((s, bi) => ({
      ...s, _globalIndex: i + bi, _totalScenes: scenes.length,
    }));
    const prompt   = buildScenePrompt(batch);
    const batchNum = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(scenes.length / batchSize);

    const result = await callLLM(prompt, byokKeys);

    if (result && Array.isArray(result)) {
      for (const suggestion of result) {
        // scene field is 1-indexed within the batch; map back to global index
        const sceneIdx = (suggestion.scene - 1) + i;
        if (sceneIdx >= 0 && sceneIdx < scenes.length) {
          const comp = suggestion.composition;
          allSuggestions[sceneIdx] = {
            composition: (comp && comp !== "none" && COMPOSITIONS.has(comp)) ? comp : null,
            effect:      MOTION_EFFECTS.has(suggestion.effect) ? suggestion.effect : null,
            transition:  TRANSITIONS.has(suggestion.transition) ? suggestion.transition : null,
            colorGrade:  COLOR_GRADES.has(suggestion.colorGrade) ? suggestion.colorGrade : null,
            overlays:    (suggestion.overlays || []).filter(o => OVERLAYS.has(o)),
            reasoning:   suggestion.reasoning || "",
          };
        }
      }
      const compCount = result.filter(s => s.composition && s.composition !== "none").length;
      if (totalBatches > 1) {
        console.log(`   ✅ Batch ${batchNum}/${totalBatches}: ${result.length} scenes (${compCount} compositions)`);
      } else {
        console.log(`   ✅ LLM advised ${result.length} scenes (${compCount} compositions)`);
      }
    } else {
      if (totalBatches > 1) {
        console.log(`   ⚠️  Batch ${batchNum}/${totalBatches}: no result — pattern classifier will fill in`);
      } else {
        console.log(`   ⚠️  LLM returned no result — pattern classifier will fill in`);
      }
    }

    // Only add delay if there are more batches to send
    if (i + batchSize < scenes.length) {
      await new Promise(r => setTimeout(r, interBatchDelay));
    }
  }

  const filled = scenes.map((scene, i) => {
    const sug = allSuggestions[i];
    if (!sug) return scene;
    return {
      ...scene,
      composition:  sug.composition || null,
      effect:       sug.effect || scene.effect,
      transition:   sug.transition || scene.transition,
      colorGrade:   sug.colorGrade || scene.colorGrade || "none",
      overlays:     sug.overlays.length > 0 ? sug.overlays : (scene.overlays || []),
      llmReasoning: sug.reasoning,
      editSource:   "llm",
    };
  });

  const llmCount  = filled.filter(s => s.editSource === "llm").length;
  const compCount = filled.filter(s => s.composition).length;
  console.log(`   🤖 LLM advised ${llmCount}/${scenes.length} scenes (${compCount} compositions)`);

  if (llmCount === 0) {
    const providerHint = provider === "gemini"
      ? "Gemini free tier may be rate limited. Wait 60s and try again, or add an Anthropic/OpenAI key in Settings for more reliable results."
      : "LLM returned no results.";
    console.log("   ⚠️  LLM produced 0 results — " + providerHint);
    console.log("   ↩  Falling back to smart pattern classifier");
    return null;
  }

  // ── SAVE TO CACHE ───────────────────────────────────────────────────────
  const cacheResult = allSuggestions.map((s, i) => s || { effect: filled[i]?.effect, transition: filled[i]?.transition, colorGrade: filled[i]?.colorGrade, overlays: filled[i]?.overlays || [], composition: filled[i]?.composition || null, reasoning: "" });
  const keyParts = cacheKey.split("_"); // llm_provider_audioHash_imageHash_count
  db.saveLlmCache({ cacheKey, audioHash: keyParts[2] || "", imageHash: keyParts[3] || "", sceneCount: scenes.length, result: cacheResult, provider });
  console.log(`   💾 LLM result cached: ${cacheKey.slice(0, 20)}…`);

  return filled;
}

async function adviseSingleScene(scene, byokKeys = {}) {
  const provider = getProvider(byokKeys);
  if (!provider) return null;
  const result = await callLLM(buildScenePrompt([scene]), byokKeys);
  if (!result || !Array.isArray(result) || !result[0]) return null;
  const s = result[0];
  const comp = s.composition;
  return {
    composition: (comp && comp !== "none" && COMPOSITIONS.has(comp)) ? comp : null,
    effect:      MOTION_EFFECTS.has(s.effect) ? s.effect : null,
    transition:  TRANSITIONS.has(s.transition) ? s.transition : null,
    colorGrade:  COLOR_GRADES.has(s.colorGrade) ? s.colorGrade : null,
    overlays:    (s.overlays || []).filter(o => OVERLAYS.has(o)),
    reasoning:   s.reasoning || "",
  };
}

module.exports = { adviseScenesWithLLM, adviseSingleScene, buildLlmCacheKey };