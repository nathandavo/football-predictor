const express = require("express");
const axios = require("axios");
const router = express.Router();

// Premier League = League ID 39
// Season = 2025
// Next = upcoming matches

router.get("/", async (req, res) => {
  try {
    const response = await axios.get("https://v3.football.api-sports.io/fixtures", {
      params: {
        league: 39,
        season: 2025,
        next: 10   // number of upcoming fixtures to return
      },
      headers: {
        "x-rapidapi-key": process.env.FOOTBALL_API_KEY,
        "x-rapidapi-host": "v3.football.api-sports.io"
      }
    });

    res.json(response.data);
  } catch (error) {
    console.error("Fixtures Error:", error.response?.data || error.message);
    res.status(500).json({
      error: "Failed to fetch fixtures",
      details: error.response?.data || error.message
    });
  }
});

module.exports = router;



