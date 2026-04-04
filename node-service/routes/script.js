/**
 * Script Routes — Generate scripts independently
 */

const express = require("express");
const router = express.Router();
const { generateScript } = require("../services/scriptGenerator");

/**
 * POST /api/script/generate
 * Generate a script without producing a video.
 * Useful for previewing before committing to video generation.
 */
router.post("/generate", async (req, res) => {
  try {
    const { prompt, duration = 15, template = null } = req.body;

    if (!prompt) {
      return res.status(400).json({ error: "Missing 'prompt' field" });
    }

    const script = await generateScript(prompt, duration, template);
    res.json({ success: true, script });
  } catch (err) {
    res.status(500).json({ error: `Script generation failed: ${err.message}` });
  }
});

module.exports = router;
