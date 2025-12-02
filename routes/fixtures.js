const express = require("express");
const axios = require("axios");
const router = express.Router();

router.get("/", async (req, res) => {
  try {
    const response = await axios.get("https://v3.football.api-sports.io/fixtures", {
      params: {
        league: 39,
        season: 2025,
        next: 10
      },
      headers: {
        "x-apisports-key": process.env.FOOTBALL_API_KEY   // direct API-Football key
      }
    });

    res.json(response.data.response);
  } catch (error) {
    console.error("Fixtures Error:", error.response?.data || error.message);
    res.status(500).json({
      error: "Failed to fetch fixtures",
      details: error.response?.data || error.message
    });
  }
});

module.exports = router;
