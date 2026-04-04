/**
 * Media Routes — Search and fetch images
 */

const express = require("express");
const router = express.Router();
const { searchPexels, searchPixabay } = require("../services/mediaService");

/**
 * GET /api/media/search?q=anime+battle&count=5
 * Search for images (useful for previewing before video generation).
 */
router.get("/search", async (req, res) => {
  const { q, count = 5 } = req.query;

  if (!q) {
    return res.status(400).json({ error: "Missing 'q' query parameter" });
  }

  try {
    let images = await searchPexels(q, parseInt(count));
    if (images.length === 0) {
      images = await searchPixabay(q, parseInt(count));
    }

    res.json({
      query: q,
      results: images.length,
      images,
    });
  } catch (err) {
    res.status(500).json({ error: `Image search failed: ${err.message}` });
  }
});

module.exports = router;
