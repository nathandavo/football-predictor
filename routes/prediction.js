const express = require("express");
const router = express.Router();
const axios = require("axios");
const OpenAI = require("openai");

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Helper: fetch upcoming matches from API-Football
async function getUpcomingMatches() {
  const response = await axios.get(
    "https://api-football-v1.p.rapidapi.com/v3/fixtures",
    {
      params: { league: 39, season: 2025, next: 10 }, // adjust league/season as needed
      headers: {
        "X-RapidAPI-Key": process.env.FOOTBALL_API_KEY,
        "X-RapidAPI-Host": "api-football-v1.p.rapidapi.com",
      },
    }
  );
  return response.data.response;
}

// Helper: format stats for OpenAI prompt
function formatMatchStats(match) {
  const home = match.teams.home.name;
  const away = match.teams.away.name;

  const homeForm = match.teams.home.form || "No recent form data";
  const awayForm = match.teams.away.form || "No recent form data";

  return `Match: ${home} vs ${away}\nHome form: ${homeForm}\nAway form: ${awayForm}\n`;
}

// Prediction endpoint
router.get("/", async (req, res) => {
  try {
    const matches = await getUpcomingMatches();
    if (!matches.length) return res.json({ message: "No upcoming matches found." });

    // Example: predict first upcoming match
    const matchStats = formatMatchStats(matches[0]);

    const prompt = `
      Based on the following stats, predict the most likely score for the match:
      ${matchStats}
    `;

    const completion = await client.chat.completions.create({
      model: "gpt-5-mini",
      messages: [{ role: "user", content: prompt }],
    });

    res.json({ prediction: completion.choices[0].message.content });
  } catch (err) {
    console.error("Prediction error:", err);
    res.status(500).json({ error: "Failed to get prediction." });
  }
});

module.exports = router;
