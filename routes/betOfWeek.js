const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const OpenAI = require("openai");
const fetch = require("node-fetch");
const User = require("../models/User"); // ✅ fetch user from DB

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const FOOTBALL_API_KEY = process.env.FOOTBALL_API_KEY;
const LEAGUE_ID = 39; // Premier League

function getGameWeek() {
  const seasonStart = new Date("2025-08-01");
  const today = new Date();
  const diff = Math.floor((today - seasonStart) / (1000 * 60 * 60 * 24));
  return `GW${Math.max(1, Math.min(38, Math.ceil(diff / 7)))}`;
}

async function fetchRecentForm(teamId) {
  try {
    const res = await fetch(
      `https://v3.football.api-sports.io/fixtures?team=${teamId}&league=${LEAGUE_ID}&season=2025&status=FT`,
      { headers: { "x-apisports-key": FOOTBALL_API_KEY } }
    );
    const data = await res.json();
    if (!data.response) return [];
    const leagueMatches = data.response.filter(f => f.league.id === LEAGUE_ID);
    const sorted = leagueMatches.sort(
      (a, b) => new Date(a.fixture.date) - new Date(b.fixture.date)
    );
    return sorted.slice(-5).map(match => {
      const isHome = match.teams.home.id === teamId;
      const goalsFor = isHome ? match.goals.home : match.goals.away;
      const goalsAgainst = isHome ? match.goals.away : match.goals.home;
      if (goalsFor > goalsAgainst) return "W";
      if (goalsFor < goalsAgainst) return "L";
      return "D";
    });
  } catch (err) {
    console.error("Error fetching recent form:", err);
    return [];
  }
}

async function fetchTeamStats(teamId) {
  try {
    const res = await fetch(
      `https://v3.football.api-sports.io/teams/statistics?league=${LEAGUE_ID}&season=2025&team=${teamId}`,
      { headers: { "x-apisports-key": FOOTBALL_API_KEY } }
    );
    const data = await res.json();
    const safe = (obj, path, fallback = 0) => {
      try {
        return path.split(".").reduce((a, b) => (a && a[b] !== undefined ? a[b] : undefined), obj) ?? fallback;
      } catch {
        return fallback;
      }
    };
    return {
      goalsScored: safe(data, "response.goals.for.total.total"),
      goalsConceded: safe(data, "response.goals.against.total.total"),
      recentForm: await fetchRecentForm(teamId),
    };
  } catch (err) {
    console.error("Error fetching team stats:", err);
    return { goalsScored: 0, goalsConceded: 0, recentForm: [] };
  }
}

async function fetchUpcomingFixtures() {
  try {
    const res = await fetch(
      `https://v3.football.api-sports.io/fixtures?league=${LEAGUE_ID}&season=2025&next=10`,
      { headers: { "x-apisports-key": FOOTBALL_API_KEY } }
    );
    const data = await res.json();
    return data.response || [];
  } catch (err) {
    console.error("Error fetching upcoming fixtures:", err);
    return [];
  }
}

router.get("/", auth, async (req, res) => {
  try {
    // ✅ Fetch user from DB to get real isPremium value
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: "User not found" });
    if (!user.isPremium) return res.status(403).json({ error: "Premium only" });

    const gameweek = getGameWeek();
    const fixtures = await fetchUpcomingFixtures();
    if (!fixtures.length) return res.status(500).json({ error: "No upcoming fixtures found" });

    // Fetch stats for all fixtures
    const fixturesWithStats = await Promise.all(
      fixtures.map(async (fix) => {
        const homeStats = await fetchTeamStats(fix.teams.home.id);
        const awayStats = await fetchTeamStats(fix.teams.away.id);
        return {
          match: `${fix.teams.home.name} vs ${fix.teams.away.name}`,
          homeStats,
          awayStats,
        };
      })
    );

    // Build prompt with stats
    const prompt = `
You are a professional football betting analyst.
Select the SINGLE strongest bet for EACH market from the upcoming Premier League fixtures for ${gameweek}.
Use the following stats for each match: goals scored, goals conceded, recent form (last 5: W/D/L).

Return ONLY valid JSON in this format:
{
  "gameweek": "${gameweek}",
  "picks": [
    { "market": "Over 2.5 Goals", "match": "Team A vs Team B", "selection": "Over 2.5", "confidence": 75 },
    { "market": "Both Teams To Score", "match": "Team C vs Team D", "selection": "Yes", "confidence": 72 },
    { "market": "Match Winner", "match": "Team E vs Team F", "selection": "Team E", "confidence": 68 }
  ]
}
Do not include any text outside JSON.
Use real stats and recent form from the 2025/26 season.
Fixtures with stats: ${JSON.stringify(fixturesWithStats)}
`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
      max_tokens: 600,
    });

    const raw = completion.choices?.[0]?.message?.content ?? "";
    let data;
    try {
      // ✅ Safe JSON parse: extract object even if AI adds extra text
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error("No JSON found in AI output");
      data = JSON.parse(jsonMatch[0]);
    } catch (err) {
      console.error("OpenAI JSON parse error:", raw, err);
      // ✅ fallback: show 3 default picks so screen renders
      data = {
        gameweek,
        picks: [
          { market: "Over 2.5 Goals", match: "TBD vs TBD", selection: "Over 2.5", confidence: 0 },
          { market: "Both Teams To Score", match: "TBD vs TBD", selection: "Yes", confidence: 0 },
          { market: "Match Winner", match: "TBD vs TBD", selection: "TBD", confidence: 0 },
        ],
      };
    }

    res.json(data);
  } catch (err) {
    console.error("Bet of the week error:", err);
    res.status(500).json({ error: "Failed to generate bet of the week" });
  }
});

module.exports = router;
