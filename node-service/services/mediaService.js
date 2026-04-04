/**
 * Media Service v3.0
 *
 * OVERHAUL: Replace Pexels/Pixabay (stock photo APIs — no anime art) with
 * anime-native image boards that actually return relevant artwork:
 *
 *   1. Konachan.net  — high-res anime wallpapers, safe mode, no API key needed
 *   2. Danbooru      — massive tag library, no API key for public posts, safe only
 *   3. Pexels        — kept as final fallback for generic atmosphere shots
 *
 * Query format changed: booru-style space-separated tags work far better
 * than English prose sentences on these APIs.
 */

const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const { exec } = require("child_process");

const UPLOADS_DIR = path.join(__dirname, "..", "uploads");
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ─── KONACHAN.NET ─────────────────────────────────────────────────────────────
// Free, no auth, high-res anime wallpapers. Use .net domain (safe-mode only).
// Tag format: space-separated booru tags, e.g. "dark_background warrior glowing_eyes"

async function searchKonachan(tags, count = 3) {
  try {
    // Add rating:s to ensure safe content. Konachan.net automatically filters
    // NSFW but being explicit is more reliable.
    const tagQuery = `${tags} rating:s`;

    const res = await axios.get("https://konachan.net/post.json", {
      params: {
        tags: tagQuery,
        limit: Math.min(count + 5, 20),
        page: 1,
      },
      headers: {
        "User-Agent": "AnimeVideoGenerator/3.0 (educational project)",
        "Accept": "application/json",
      },
      timeout: 12000,
    });

    const posts = res.data || [];
    // Filter: only keep posts with a sample_url or jpeg_url, min 800px wide
    const valid = posts
      .filter(p => (p.sample_url || p.jpeg_url || p.file_url) && p.width >= 800)
      .slice(0, count);

    return valid.map(p => ({
      url: p.sample_url || p.jpeg_url || p.file_url,
      source: "konachan",
      id: p.id,
      width: p.width,
      height: p.height,
      tags: p.tags,
    }));
  } catch (err) {
    console.error(`   ❌ Konachan search failed: ${err.message}`);
    return [];
  }
}

// ─── DANBOORU ─────────────────────────────────────────────────────────────────
// Free public API, no key needed for safe posts. Excellent tag coverage.

async function searchDanbooru(tags, count = 3) {
  try {
    // Force safe rating; danbooru tag format is underscore_separated
    const tagQuery = `${tags} rating:g`;  // 'g' = general (safest)

    const res = await axios.get("https://danbooru.donmai.us/posts.json", {
      params: {
        tags: tagQuery,
        limit: Math.min(count + 5, 20),
        page: 1,
      },
      headers: {
        "User-Agent": "AnimeVideoGenerator/3.0 (educational project)",
        "Accept": "application/json",
      },
      timeout: 12000,
    });

    const posts = res.data || [];
    const valid = posts
      .filter(p => p.large_file_url || p.file_url)
      .filter(p => !p.is_deleted && !p.is_banned)
      .slice(0, count);

    return valid.map(p => ({
      url: p.large_file_url || p.file_url,
      source: "danbooru",
      id: p.id,
      width: p.image_width,
      height: p.image_height,
      tags: p.tag_string,
    }));
  } catch (err) {
    console.error(`   ❌ Danbooru search failed: ${err.message}`);
    return [];
  }
}

// ─── PEXELS (legacy fallback) ─────────────────────────────────────────────────

async function searchPexels(query, count = 1) {
  if (!process.env.PEXELS_API_KEY) return [];
  try {
    const res = await axios.get("https://api.pexels.com/v1/search", {
      params: { query, per_page: Math.min(count + 2, 10), orientation: "portrait" },
      headers: { Authorization: process.env.PEXELS_API_KEY },
      timeout: 10000,
    });
    return (res.data.photos || []).slice(0, count).map(p => ({
      url: p.src.large2x || p.src.large || p.src.original,
      source: "pexels",
      id: p.id,
    }));
  } catch (err) {
    console.error(`   ❌ Pexels search failed: ${err.message}`);
    return [];
  }
}

async function searchPixabay(query, count = 1) {
  if (!process.env.PIXABAY_API_KEY) return [];
  try {
    const res = await axios.get("https://pixabay.com/api/", {
      params: {
        key: process.env.PIXABAY_API_KEY,
        q: query,
        image_type: "illustration",
        orientation: "vertical",
        per_page: Math.min(count + 2, 10),
        safesearch: true,
      },
      timeout: 10000,
    });
    return (res.data.hits || []).slice(0, count).map(h => ({
      url: h.largeImageURL || h.webformatURL,
      source: "pixabay",
      id: h.id,
    }));
  } catch (err) {
    console.error(`   ❌ Pixabay search failed: ${err.message}`);
    return [];
  }
}

// ─── TAG CONVERSION ───────────────────────────────────────────────────────────
/**
 * Convert a natural-language visual_query into booru-style tags.
 * e.g. "anime warrior dramatic power cinematic dark background"
 *   → "warrior dark_background glowing_eyes dramatic"
 *
 * Booru APIs work best with short underscore tags, not sentences.
 */
const PROSE_TO_TAG_MAP = {
  // atmosphere / mood
  "dramatic":         "dramatic",
  "cinematic":        "cinematic_angle",
  "dark background":  "dark_background",
  "dark":             "dark",
  "epic":             "epic",
  "emotional":        "emotionally_resonant",
  "intense":          "intense",
  "moody":            "moody_lighting",
  "glowing":          "glowing_eyes",
  "light rays":       "light_rays",
  "silhouette":       "silhouette",
  "sunset":           "sunset",
  "night":            "night_sky",
  "rain":             "rain",
  "fire":             "fire",
  "lightning":        "lightning",
  "smoke":            "smoke",

  // character descriptors
  "warrior":          "warrior",
  "fighter":          "fighter",
  "soldier":          "soldier",
  "figure":           "1girl",    // default; overridden below
  "mysterious figure":"mysterious_person",
  "cloaked":          "cloak",
  "armored":          "armor",
  "sword":            "sword",
  "katana":           "katana",
  "battle":           "battle",
  "power":            "power_aura",
  "energy":           "energy_ball",
  "explosion":        "explosion",
  "aura":             "aura",
  "determination":    "determined_look",
  "tears":            "tears",
  "crying":           "crying",
  "smiling":          "smile",

  // art style
  "anime":            "anime_style",
  "manga":            "manga",
  "illustration":     "illustration",
  "wallpaper":        "wallpaper",
  "scenery":          "scenery",
  "landscape":        "landscape",
  "close-up":         "close-up",
  "portrait":         "portrait",
};

function toBooru(query) {
  if (!query) return "anime_style wallpaper dark_background";

  const lower = query.toLowerCase();
  const matched = new Set();

  // Multi-word matches first
  for (const [phrase, tag] of Object.entries(PROSE_TO_TAG_MAP)) {
    if (lower.includes(phrase)) matched.add(tag);
  }

  // Always add wallpaper + anime_style as anchors for Konachan
  matched.add("anime_style");
  matched.add("wallpaper");

  const result = [...matched].slice(0, 6).join(" ");
  return result;
}

// ─── MAIN: FETCH IMAGES FOR SCENES ───────────────────────────────────────────

async function fetchSceneImages(scenes) {
  console.log(`   🖼️  Fetching images for ${scenes.length} scenes...`);
  const results = [];

  for (const scene of scenes) {
    const rawQuery = scene.visual_query || scene.searchQuery || "anime dramatic";

    // Convert prose → booru tags for anime boards
    const booruTags = toBooru(rawQuery);
    // Keep prose for Pexels fallback
    const proseQuery = rawQuery;

    let images = [];

    // 1. Konachan (best for anime wallpapers)
    images = await searchKonachan(booruTags, 3);

    // 2. Danbooru fallback
    if (images.length === 0) {
      console.log(`   🔄 Scene ${scene.id}: Konachan miss → trying Danbooru (tags: "${booruTags}")`);
      images = await searchDanbooru(booruTags, 3);
    }

    // 3. Pexels fallback
    if (images.length === 0 && process.env.PEXELS_API_KEY) {
      console.log(`   🔄 Scene ${scene.id}: Danbooru miss → trying Pexels (query: "${proseQuery.slice(0, 30)}")`);
      images = await searchPexels(proseQuery, 1);
    }

    // 4. Pixabay fallback
    if (images.length === 0 && process.env.PIXABAY_API_KEY) {
      images = await searchPixabay(proseQuery, 1);
    }

    if (images.length > 0) {
      const img = images[0];
      try {
        const localPath = await downloadImage(img.url, scene.id);
        results.push({ ...scene, imagePath: localPath, imageSource: img.source });
        console.log(`   ✅ Scene ${scene.id}: from ${img.source} (tags: "${booruTags.slice(0, 40)}")`);
      } catch (dlErr) {
        // If first image fails to download, try next
        let downloaded = false;
        for (let i = 1; i < images.length; i++) {
          try {
            const localPath = await downloadImage(images[i].url, scene.id);
            results.push({ ...scene, imagePath: localPath, imageSource: images[i].source });
            console.log(`   ✅ Scene ${scene.id}: from ${images[i].source} (retry ${i})`);
            downloaded = true;
            break;
          } catch {}
        }
        if (!downloaded) {
          console.error(`   ❌ Scene ${scene.id}: all downloads failed — using placeholder`);
          const placeholder = await generatePlaceholder(scene);
          results.push({ ...scene, imagePath: placeholder, imageSource: "placeholder" });
        }
      }
    } else {
      console.warn(`   ⚠️  Scene ${scene.id}: no images found anywhere, using placeholder`);
      const placeholder = await generatePlaceholder(scene);
      results.push({ ...scene, imagePath: placeholder, imageSource: "placeholder" });
    }

    await sleep(300); // rate limit courtesy delay
  }

  return results;
}

// ─── DOWNLOAD ─────────────────────────────────────────────────────────────────

async function downloadImage(url, sceneId) {
  const filename = `scene_${sceneId}_${uuidv4().slice(0, 6)}.jpg`;
  const filepath = path.join(UPLOADS_DIR, filename);

  const res = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: 20000,
    headers: { "User-Agent": "AnimeVideoGenerator/3.0" },
  });

  fs.writeFileSync(filepath, res.data);

  const resizedPath = path.join(UPLOADS_DIR, `resized_${filename}`);
  await resizeImage(filepath, resizedPath, 1080, 1920);
  try { fs.unlinkSync(filepath); } catch {}
  return resizedPath;
}

function resizeImage(input, output, width, height) {
  return new Promise((resolve, reject) => {
    const cmd = `ffmpeg -y -i "${input}" -vf "scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black" -q:v 2 "${output}"`;
    exec(cmd, { timeout: 15000 }, (error) => {
      if (error) reject(new Error(`Resize failed: ${error.message}`));
      else resolve(output);
    });
  });
}

// ─── PLACEHOLDER ──────────────────────────────────────────────────────────────

function generatePlaceholder(scene) {
  return new Promise((resolve, reject) => {
    const filename = `placeholder_${scene.id}_${uuidv4().slice(0, 6)}.jpg`;
    const filepath = path.join(UPLOADS_DIR, filename);
    const colors = ["0x0a0a1a","0x0d0a1f","0x1a0a0a","0x0a1a0d","0x140a1f","0x0a0f1a","0x1a1a0a"];
    const color = colors[scene.id % colors.length];
    const text = (scene.subtitle || `Scene ${scene.id}`).replace(/'/g, "'\\''");
    const cmd = `ffmpeg -y -f lavfi -i "color=c=${color}:s=1080x1920:d=1" ` +
      `-vf "drawtext=text='${text}':fontsize=64:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2:borderw=3:bordercolor=black" ` +
      `-frames:v 1 "${filepath}"`;
    exec(cmd, { timeout: 10000 }, (error) => {
      if (error) {
        const simple = `ffmpeg -y -f lavfi -i "color=c=${color}:s=1080x1920:d=1" -frames:v 1 "${filepath}"`;
        exec(simple, { timeout: 10000 }, (err2) => {
          if (err2) reject(new Error("Cannot generate placeholder"));
          else resolve(filepath);
        });
      } else resolve(filepath);
    });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { fetchSceneImages, searchKonachan, searchDanbooru, searchPexels, searchPixabay, toBooru };
