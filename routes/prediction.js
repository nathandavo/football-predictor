const express = require("express");
const router = express.Router();
const axios = require("axios");
const OpenAI = require("openai");

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ------------ Helpers ------------

// Fetch upcoming fixtures
async function getUpcomingFixtures() {
  const response = await axios.get("https://api-football-v1.p.rapidapi.com/v3/fixtures", {
    params: { league: 39, season: 2025, next: 10 },
    headers: {
      "X-RapidAPI-Key": process.env.FOOTBALL_API_KEY,
      "X-RapidAPI-Host": "api-football-v1.p.rapidapi.com",
    },
  });
  return response.data.response;
}

// Fetch team stats
async function getTeamStats(teamId) {
  const response = await axios.get("https://api-football-v1.p.rapidapi.com/v3/teams/statistics", {
    params: { league: 39, season: 2025, team: teamId },
    headers: {
      "X-RapidAPI-Key": process.env.FOOTBALL_API_KEY,
      "X-RapidAPI-Host": "api-football-v1.p.rapidapi.com",
    },
  });
  return response.data.response;
}

// Fetch head-to-head
async function getHeadToHead(homeId, awayId) {
  const response = await axios.get("https://api-football-v1.p.rapidapi.com/v3/fixtures/headtohead", {
    params: { h2h: `${homeId}-${awayId}` },
    headers: {
      "X-RapidAPI-Key": process.env.FOOTBALL_API_KEY,
      "X-RapidAPI-Host": "api-football-v1.p.rapidapi.com",
    },
  });
  return response.data.response;
}

// Fetch injuries
async function getInjuries(teamId) {
  const response = await axios.get("https://api-football-v1.p.rapidapi.com/v3/players/injuries", {
    params: { team: teamId, season: 2025 },
    headers: {
      "X-RapidAPI-Key": process.env.FOOTBALL_API_KEY,
      "X-RapidAPI-Host": "api-football-v1.p.rapidapi.com",
    },
  });
  return response.data.response;
}

// Format stats for OpenAI prompt
function formatMatchPrompt(fixture, homeStats, awayStats, headToHead, homeInjuries, awayInjuries) {
  const homeForm = homeStats.form ? homeStats.form.join(", ") : "No data";
  const awayForm = awayStats.form ? awayStats.form.join(", ") : "No data";

  const headHistory = headToHead.length
    ? headToHead.map(h => `${h.teams.home.name} ${h.goals.home} - ${h.goals.away} ${h.teams.away.name}`).join("; ")
    : "No previous matches";

  const homeInj = homeInjuries.length ? homeInjuries.map(p => p.player.name).join(", ") : "None";
  const awayInj = awayInjuries.length ? awayInjuries.map(p => p.player.name).join(", ") : "None";

  return `
Match: ${fixture.teams.home.name} vs ${fixture.teams.away.name}
Date: ${fixture.fixture.date}
Venue: ${fixture.fixture.venue.name}

Home Team Stats:
- Last 5 games: ${homeForm}
- Injured players: ${homeInj}

Away Team Stats:
- Last 5 games: ${awayForm}
- Injured players: ${awayInj}

Head-to-head: ${headHistory}

Predict the most likely score and explain why based on these stats.
`;
}

// ------------ Prediction Endpoint ------------
router.get("/", async (req, res) => {
  try {
    const fixtures = await getUpcomingFixtures();
    if (!fixtures.length) return res.json({ message: "No upcoming matches found." });

    const predictions = [];

    for (const fixture of fixtures) {
      const homeId = fixture.teams.home.id;
      const awayId = fixture.teams.away.id;

      // Fetch stats in parallel
      const [homeStats, awayStats, headToHead, homeInjuries, awayInjuries] = await Promise.all([
        getTeamStats(homeId),
        getTeamStats(awayId),
        getHeadToHead(homeId, awayId),
        getInjuries(homeId),
        getInjuries(awayId),
      ]);

      const prompt = formatMatchPrompt(fixture, homeStats, awayStats, headToHead, homeInjuries, awayInjuries);

      const completion = await client.chat.completions.create({
        model: "gpt-5-mini",
        messages: [{ role: "user", content: prompt }],
      });

      predictions.push({
        match: `${fixture.teams.home.name} vs ${fixture.teams.away.name}`,
        prediction: completion.choices[0].message.content,
      });
    }

    res.json({ predictions });
  } catch (err) {
    console.error("Prediction error:", err);
    res.status(500).json({ error: "Failed to generate predictions." });
  }
});

module.exports = router;
