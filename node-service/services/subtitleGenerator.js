/**
 * Subtitle Generator Service
 * Generates styled ASS/SSA subtitle files for FFmpeg overlay.
 *
 * ASS (Advanced SubStation Alpha) supports:
 * - Custom fonts, colors, outlines, shadows
 * - Fade-in/fade-out animations
 * - Precise positioning on the 9:16 canvas
 * - Multiple style layers (title overlay + narration caption)
 */

const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");

const TEMP_DIR = path.join(__dirname, "..", "temp");
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// ─── STYLE PRESETS ──────────────────────────────────────────────────────────

const STYLE_PRESETS = {
  epic: {
    titleColor: "&H0000BFFF",     // Gold/amber
    titleOutline: "&H00000000",
    captionColor: "&H00FFFFFF",
    captionOutline: "&H00000000",
    titleFont: "Impact",
    captionFont: "Arial",
  },
  dark: {
    titleColor: "&H004040FF",     // Red
    titleOutline: "&H00000000",
    captionColor: "&H00CCCCCC",
    captionOutline: "&H00000000",
    titleFont: "Impact",
    captionFont: "Arial",
  },
  hype: {
    titleColor: "&H0000FFFF",     // Cyan/yellow
    titleOutline: "&H00000000",
    captionColor: "&H00FFFFFF",
    captionOutline: "&H00000000",
    titleFont: "Impact",
    captionFont: "Arial",
  },
  chill: {
    titleColor: "&H00FFDDAA",     // Soft blue
    titleOutline: "&H00222222",
    captionColor: "&H00EEEEDD",
    captionOutline: "&H00333333",
    titleFont: "Arial",
    captionFont: "Arial",
  },
  emotional: {
    titleColor: "&H00FFAACC",     // Soft pink
    titleOutline: "&H00111111",
    captionColor: "&H00FFFFFF",
    captionOutline: "&H00222222",
    titleFont: "Arial",
    captionFont: "Arial",
  },
};

// ─── GENERATE ASS FILE ──────────────────────────────────────────────────────

/**
 * Generate a styled .ass subtitle file from scenes.
 * @param {Array} scenes - Scene objects with subtitle, narration, duration
 * @param {string} mood - Video mood (epic, dark, chill, hype, emotional)
 * @returns {string} Path to the generated .ass file
 */
function generateSubtitleFile(scenes, mood = "epic") {
  const preset = STYLE_PRESETS[mood] || STYLE_PRESETS.epic;
  const filename = `subs_${uuidv4().slice(0, 8)}.ass`;
  const filepath = path.join(TEMP_DIR, filename);

  const header = `[Script Info]
Title: Anime Edit Subtitles
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Title,${preset.titleFont},72,${preset.titleColor},&H000000FF,${preset.titleOutline},&H80000000,-1,0,0,0,100,100,3,0,1,4,2,5,40,40,400,1
Style: Caption,${preset.captionFont},40,${preset.captionColor},&H000000FF,${preset.captionOutline},&HB4000000,-1,0,0,0,100,100,1,0,1,3,1,2,40,40,100,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const events = [];
  let currentTime = 0;

  scenes.forEach((scene, i) => {
    const start = formatASSTime(currentTime + 0.1);
    const end = formatASSTime(currentTime + scene.duration - 0.1);

    // Title overlay (big punchy text, upper portion of screen)
    if (scene.subtitle && scene.subtitle.trim()) {
      const titleText = escapeASS(scene.subtitle.trim());
      events.push(
        `Dialogue: 0,${start},${end},Title,,0,0,0,,{\\fad(300,300)\\pos(540,400)}${titleText}`
      );
    }

    // Narration caption (smaller, bottom of screen)
    if (scene.narration && scene.narration.trim()) {
      // Break long narration into max ~50 char lines
      const lines = wordWrap(scene.narration.trim(), 45);
      const captionText = escapeASS(lines.join("\\N"));

      events.push(
        `Dialogue: 1,${start},${end},Caption,,0,0,0,,{\\fad(200,200)}${captionText}`
      );
    }

    currentTime += scene.duration;
  });

  const content = header + events.join("\n") + "\n";
  fs.writeFileSync(filepath, content, "utf-8");

  console.log(`   📝 Subtitles: ${filepath} (${events.length} events)`);
  return filepath;
}

// ─── HELPERS ────────────────────────────────────────────────────────────────

function formatASSTime(seconds) {
  if (seconds < 0) seconds = 0;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const cs = Math.floor((seconds % 1) * 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

function escapeASS(text) {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\{/g, "\\{")
    .replace(/\}/g, "\\}")
    .replace(/\n/g, "\\N");
}

function wordWrap(text, maxLineLength) {
  const words = text.split(" ");
  const lines = [];
  let currentLine = "";

  for (const word of words) {
    if (currentLine.length + word.length + 1 > maxLineLength && currentLine.length > 0) {
      lines.push(currentLine.trim());
      currentLine = word;
    } else {
      currentLine += (currentLine ? " " : "") + word;
    }
  }
  if (currentLine.trim()) lines.push(currentLine.trim());

  return lines;
}

module.exports = { generateSubtitleFile, STYLE_PRESETS };
