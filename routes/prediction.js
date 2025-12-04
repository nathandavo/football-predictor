const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const OpenAI = require('openai');
const User = require('../models/User');
const fetch = require('node-fetch'); // make sure to install node-fetch

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Helper to get current Premier League gameweek (1–38)
function getGameWeek() {
  const seasonStart = new Date('2025-08-01'); // adjust each season
  const today = new Date();
  const diff = Math.floor((today - seasonStart) / (1000 * 60 * 60 * 24));
  return Math.max(1, Math.min(38, Math.ceil(diff / 7)));
}

// Function to fetch H2H, goals scored/conceded, xG, recent form, wins/draws/losses
async function fetchStats(homeTeamId, awayTeamId) {
  try {
    const headers = {
      'x-apisports-key': process.env.API_FOOTBALL_KEY,
      'x-apisports-host': 'v3.football.api-sports.io'
    };

    const league = 39;  // Premier League
    const season = 2025;

    // 1️⃣ Head-to-Head
    const h2hRes = await fetch(
      `https://v3.football.api-sports.io/fixtures/headtohead?h2h=${homeTeamId}-${awayTeamId}`,
      { headers }
    );
    const h2hData = await h2hRes.json();

    // 2️⃣ Home Team Stats
    const homeRes = await fetch(
      `https://v3.football.api-sports.io/teams/statistics?league=${league}&season=${season}&team=${homeTeamId}`,
      { headers }
    );
    const homeData = await homeRes.json();

    // 3️⃣ Away Team Stats
    const awayRes = await fetch(
      `https://v3.football.api-sports.io/teams/statistics?league=${league}&season=${season}&team=${awayTeamId}`,
      { headers }
    );
    const awayData = await awayRes.json();

    // Helper to parse recent form → "WWDLW"
    const parseForm = (formString) => formString ? formString.split('') : [];

    return {
      h2h: h2hData.response || [],

      homeStats: {
        goalsScored: homeData.response?.goals?.for?.total?.total ?? 0,
        goalsConceded: homeData.response?.goals?.against?.total?.total ?? 0,
        xG: homeData.response?.expected?.goals ?? 0,
        recentForm: parseForm(homeData.response?.form),
        wins: homeData.response?.fixtures?.wins?.total ?? 0,
        draws: homeData.response?.fixtures?.draws?.total ?? 0,
        losses: homeData.response?.fixtures?.loses?.total ?? 0,
      },

      awayStats: {
        goalsScored: awayData.response?.goals?.for?.total?.total ?? 0,
        goalsConceded: awayData.response?.goals?.against?.total?.total ?? 0,
        xG: awayData.response?.expected?.goals ?? 0,
        recentForm: parseForm(awayData.response?.form),
        wins: awayData.response?.fixtures?.wins?.total ?? 0,
        draws: awayData.response?.fixtures?.draws?.total ?? 0,
        losses: awayData.response?.fixtures?.loses?.total ?? 0,
      },
    };

  } catch (err) {
    console.log("Error fetching stats:", err);
    return {
      h2h: [],
      homeStats: { goalsScored: 0, goalsConceded: 0, xG: 0, recentForm: [], wins: 0, draws: 0, losses: 0 },
      awayStats: { goalsScored: 0, goalsConceded: 0, xG: 0, recentForm: [], wins: 0, draws: 0, losses: 0 },
    };
  }
}

// ----- FREE WEEKLY PREDICTION -----
router.post('/free', auth, async (req, res) => {
  try {
    // Ensure we are getting numeric IDs
    let { fixtureId, homeTeam, awayTeam } = req.body;

    // If someone sends objects instead of IDs
    if (homeTeam?.id) homeTeam = homeTeam.id;
    if (awayTeam?.id) awayTeam = awayTeam.id;

    const gameweek = `GW${getGameWeek()}`;

    // Fetch the user from DB
    if (!req.user || !req.user.id) {
      return res.status(401).json({ error: 'Unauthorized: user missing' });
    }
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Check if user can use free prediction
    if (!user.isPremium && user.freePredictions[gameweek]) { // <-- FIXED
      return res.status(403).json({ error: 'Free prediction already used this week' });
    }

    // Fetch stats from Football API
    const stats = await fetchStats(homeTeam, awayTeam);
    console.log("Stats being sent to OpenAI:", stats);

    // Call OpenAI to generate prediction
    const prompt = `
      Predict the outcome of the football match:
      Home Team: ${homeTeam}
      Away Team: ${awayTeam}
      Stats: ${JSON.stringify(stats)}
      Include likely score and a brief reasoning.
    `;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are a football analyst.' },
        { role: 'user', content: prompt }
      ],
    });

    const prediction = completion.choices[0].message.content;

    // Mark free prediction as used
    if (!user.isPremium) {
      user.freePredictions[gameweek] = true; // <-- FIXED
      await user.save();
    }

    res.json({ prediction });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Prediction failed' });
  }
});

module.exports = router;

