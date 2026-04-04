/**
 * Audio Routes — TTS + custom audio upload
 */

const express = require("express");
const router = express.Router();
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const multer = require("multer");

const TTS_URL = process.env.TTS_SERVICE_URL || "http://localhost:5050";
const UPLOADS_DIR = path.join(__dirname, "..", "uploads");

const upload = multer({
  dest: UPLOADS_DIR,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("audio/")) cb(null, true);
    else cb(new Error("Only audio files allowed"), false);
  },
});

/**
 * POST /api/audio/tts — Generate TTS via Python service
 */
router.post("/tts", async (req, res) => {
  try {
    const { text, voice = "male_en", rate = "+0%" } = req.body;

    if (!text) {
      return res.status(400).json({ error: "Missing 'text' field" });
    }

    const response = await axios.post(`${TTS_URL}/tts/save`, { text, voice, rate }, { timeout: 60000 });

    if (response.data.success) {
      res.json({
        success: true,
        audioPath: response.data.path,
        audioUrl: `${TTS_URL}${response.data.download_url}`,
        filename: response.data.filename,
      });
    } else {
      res.status(500).json({ error: "TTS generation failed" });
    }
  } catch (err) {
    console.error("TTS error:", err.message);
    res.status(500).json({
      error: "TTS service unavailable. Make sure Python TTS service is running on port 5050.",
    });
  }
});

/**
 * POST /api/audio/upload — Upload custom audio
 */
router.post("/upload", upload.single("audio"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No audio file uploaded" });
  }

  const ext = path.extname(req.file.originalname) || ".mp3";
  const newPath = req.file.path + ext;
  fs.renameSync(req.file.path, newPath);

  res.json({
    success: true,
    audioPath: newPath,
    audioUrl: `/uploads/${path.basename(newPath)}`,
    filename: req.file.originalname,
  });
});

/**
 * GET /api/audio/voices — List available TTS voices
 */
router.get("/voices", async (req, res) => {
  try {
    const response = await axios.get(`${TTS_URL}/voices`, { timeout: 5000 });
    res.json(response.data);
  } catch {
    res.json({
      voices: {
        male_en: "English Male",
        female_en: "English Female",
        male_en_dramatic: "English Male (Dramatic)",
        female_en_bright: "English Female (Bright)",
        male_jp: "Japanese Male",
        female_jp: "Japanese Female",
        male_in: "Indian English Male",
        female_in: "Indian English Female",
      },
    });
  }
});

module.exports = router;
