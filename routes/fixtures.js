const express = require("express");
const axios = require("axios");
const router = express.Router();

router.get("/", async (req, res) => {
  try {
    const response = await axios.get("https://v3.football.api-sports.io/fixtures", {
      params: {
        live: "all" // you can change this to date, league, etc.
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
