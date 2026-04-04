/**
 * Script Generator Service v2.2
 *
 * FIXES:
 *  - Gemini model: gemini-2.5-flash (1.5 retired, 2.0 deprecated → 404)
 *  - Gemini 429: exponential retry (3 attempts, 2s/4s/8s backoff)
 *  - visual_query now generates BOORU-STYLE TAGS (e.g. "dark_background warrior aura")
 *    instead of English prose, so Konachan/Danbooru return relevant anime art
 *  - IP name sanitizer strips character names as a safety net
 */

const axios = require("axios");

// ─── IP NAME SANITIZER ────────────────────────────────────────────────────────
const IP_NAMES = [
  "goku","vegeta","gohan","piccolo","frieza","cell","buu","broly","trunks","krillin",
  "naruto","sasuke","kakashi","itachi","madara","minato","sakura","hinata","obito",
  "luffy","zoro","nami","sanji","robin","chopper","usopp","brook","franky","shanks","kaido",
  "eren","mikasa","armin","levi","historia","reiner","bertolt","annie",
  "tanjiro","nezuko","zenitsu","inosuke","muzan","rengoku","giyu","shinobu",
  "deku","izuku","todoroki","bakugo","allmight","all might","endeavor","hawks",
  "dragon ball","dragonball","naruto shippuden","attack on titan","demon slayer",
  "my hero academia","one piece","fullmetal alchemist","death note","bleach",
  "jujutsu kaisen","chainsaw man","sword art online","hunter x hunter",
];

const IP_REGEX = new RegExp(
  "\\b(" + IP_NAMES.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")\\b",
  "gi"
);

function sanitizeVisualQuery(query) {
  if (!query) return "dark_background warrior wallpaper";
  const cleaned = query.replace(IP_REGEX, "").replace(/\s{2,}/g, " ").trim();
  if (cleaned.length < 5) return "dark_background warrior wallpaper";
  return cleaned;
}

// ─── LLM PROVIDERS ───────────────────────────────────────────────────────────

async function callOpenAI(systemPrompt, userPrompt) {
  const res = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      max_tokens: 2000,
      temperature: 0.8,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      timeout: 30000,
    }
  );
  return res.data.choices[0].message.content;
}

async function callGemini(systemPrompt, userPrompt) {
  const res = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      contents: [{ parts: [{ text: `${systemPrompt}\n\nUser request: ${userPrompt}` }] }],
      generationConfig: {
        responseMimeType: "application/json",
        temperature: 0.8,
        maxOutputTokens: 2000,
      },
    },
    { timeout: 30000 }
  );
  const text = res.data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini returned empty response");
  return text;
}

async function callGeminiWithRetry(systemPrompt, userPrompt, maxRetries = 3) {
  let lastErr;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await callGemini(systemPrompt, userPrompt);
    } catch (err) {
      lastErr = err;
      const status = err.response?.status;
      if ((status === 429 || status === 503) && attempt < maxRetries - 1) {
        const delay = 2000 * Math.pow(2, attempt);
        console.warn(`   ⚠️  Gemini ${status} — retrying in ${delay / 1000}s (attempt ${attempt + 1}/${maxRetries})...`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        throw err;
      }
    }
  }
  throw lastErr;
}

async function callLLM(systemPrompt, userPrompt) {
  if (process.env.OPENAI_API_KEY) {
    console.log("   🤖 Using OpenAI GPT-4o-mini...");
    return callOpenAI(systemPrompt, userPrompt);
  }
  if (process.env.GEMINI_API_KEY) {
    console.log("   🤖 Using Google Gemini 2.5 Flash...");
    return callGeminiWithRetry(systemPrompt, userPrompt);
  }
  throw new Error("NO_LLM_KEY");
}

// ─── SYSTEM PROMPT ────────────────────────────────────────────────────────────

function buildSystemPrompt(numScenes, duration) {
  return `You are a professional anime video editor creating TikTok/Reels-style edits.

Generate a JSON video script. Return ONLY valid JSON (no markdown, no backticks):
{
  "title": "catchy video title",
  "mood": "epic|dark|chill|hype|emotional",
  "scenes": [
    {
      "narration": "voiceover text (1-2 sentences, dramatic)",
      "subtitle": "SHORT PUNCHY TEXT (max 5 words, ALL CAPS)",
      "visual_query": "BOORU-STYLE TAGS ONLY — see rules below",
      "duration": 4,
      "effect": "zoom_in|zoom_out|pan_left|pan_right|ken_burns|static",
      "transition": "fade|fadeblack|wipeleft|wiperight|slidedown|slideup|smoothleft|smoothright|circlecrop|dissolve|pixelize"
    }
  ]
}

VISUAL_QUERY RULES — THIS IS CRITICAL:
Images come from anime wallpaper boards (Konachan, Danbooru). They use tag-based search.
You MUST write booru-style tags, NOT English sentences.

BAD (English prose — returns 0 results):
  "anime warrior with golden aura in dramatic battle"
  "mysterious figure in dark cloak cinematic scene"

GOOD (booru tags — returns beautiful anime art):
  "warrior dark_background aura wallpaper"
  "silhouette night_sky dramatic wallpaper"
  "battle explosion energy_ball wallpaper"
  "crying tears emotional close-up wallpaper"
  "sword katana rain dark wallpaper"
  "armor glowing_eyes determination wallpaper"
  "landscape scenery dramatic_sky wallpaper"
  "fire destruction dramatic wallpaper"

Tag reference — pick 3-5 that match the scene mood:
  ATMOSPHERE: dark_background, night_sky, sunset, rain, fire, lightning, smoke, fog, dramatic, glowing
  ACTION: battle, explosion, aura, energy_ball, sword, katana, warrior, fighter, armor
  EMOTION: crying, tears, smile, determination, despair, dramatic, silhouette, close-up
  STYLE: wallpaper, scenery, landscape, portrait, illustration (always include "wallpaper")

NEVER use character names (Goku, Itachi, etc.) — tag search doesn't know them.

OTHER RULES:
- Generate exactly ${numScenes} scenes totaling ~${duration} seconds
- Scene durations: 3-6s each. First transition: "fade"
- Narration: dramatic YouTube Shorts narrator voice
- Subtitle: max 5 words, ALL CAPS, punchy`;
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function generateScript(prompt, duration = 15, template = null) {
  const numScenes = Math.max(3, Math.min(8, Math.floor(duration / 3.5)));

  try {
    const systemPrompt = buildSystemPrompt(numScenes, duration);
    const raw = await callLLM(systemPrompt, prompt);
    const cleaned = raw.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    const script = JSON.parse(cleaned);

    if (!script.scenes || !Array.isArray(script.scenes) || script.scenes.length === 0) {
      throw new Error("LLM returned invalid script structure");
    }

    script.scenes = script.scenes.map((scene, i) => {
      const rawQuery = scene.visual_query || "dark_background warrior wallpaper";
      const safeQuery = sanitizeVisualQuery(rawQuery);
      return {
        id: i + 1,
        narration: scene.narration || "",
        subtitle: scene.subtitle || "",
        visual_query: safeQuery,
        duration: Math.max(2, Math.min(8, scene.duration || 4)),
        effect: scene.effect || "zoom_in",
        transition: i === 0 ? "fade" : scene.transition || "fade",
        searchQuery: safeQuery,
      };
    });

    script.prompt = prompt;
    script.totalDuration = script.scenes.reduce((sum, s) => sum + s.duration, 0);
    script.narration = script.scenes.map((s) => s.narration).join(" ... ");

    console.log(`   ✅ LLM script: ${script.scenes.length} scenes, ${script.totalDuration}s, mood=${script.mood}`);
    return script;
  } catch (err) {
    if (err.message === "NO_LLM_KEY") {
      console.warn("   ⚠️  No LLM API key — using fallback template");
    } else {
      console.error(`   ⚠️  LLM failed (${err.message}) — using fallback`);
    }
    return generateFallbackScript(prompt, duration);
  }
}

// ─── FALLBACK ─────────────────────────────────────────────────────────────────

function generateFallbackScript(prompt, duration) {
  const numScenes = Math.max(3, Math.floor(duration / 4));
  const sceneDuration = Math.floor(duration / numScenes);
  const subject = prompt.replace(/^(top\s+\d+|best|amazing|facts\s+about)\s+/i, "").trim();

  const effects = ["zoom_in", "zoom_out", "pan_left", "ken_burns", "static"];
  const transitions = ["fade", "fadeblack", "wipeleft", "dissolve", "smoothleft"];

  // Booru-style tag sets that reliably return good results on Konachan
  const booruQueries = [
    "warrior dark_background aura wallpaper",
    "battle explosion energy_ball dramatic wallpaper",
    "silhouette night_sky dramatic wallpaper",
    "armor sword determination wallpaper",
    "landscape scenery dramatic_sky wallpaper",
  ];

  const scenes = [];
  for (let i = 0; i < numScenes; i++) {
    let narration, subtitle;
    if (i === 0) {
      narration = `Let's talk about ${subject}. You won't want to miss this.`;
      subtitle = subject.toUpperCase().slice(0, 30);
    } else if (i === numScenes - 1) {
      narration = `That wraps up everything about ${subject}. Follow for more anime content!`;
      subtitle = "FOLLOW FOR MORE";
    } else {
      narration = `Here's something incredible about ${subject} that most people don't know.`;
      subtitle = `PART ${i}`;
    }
    scenes.push({
      id: i + 1,
      narration,
      subtitle,
      visual_query: booruQueries[i % booruQueries.length],
      duration: sceneDuration,
      effect: effects[i % effects.length],
      transition: i === 0 ? "fade" : transitions[i % transitions.length],
      searchQuery: booruQueries[i % booruQueries.length],
    });
  }

  return {
    title: `${subject} — Anime Edit`,
    mood: "epic",
    prompt,
    totalDuration: duration,
    scenes,
    narration: scenes.map((s) => s.narration).join(" ... "),
    _fallback: true,
  };
}

module.exports = { generateScript, sanitizeVisualQuery };
