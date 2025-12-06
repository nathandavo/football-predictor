// routes/prediction.js
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth'); // fixed middleware
const OpenAI = require('openai');
const User = require('../models/User');
const fetch = require('node-fetch'); // ensure installed: npm i node-fetch@2

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Helper to get current Premier League gameweek (1–38)
function getGameWeek() {
  const seasonStart = new Date('2025-08-01'); // adjust each season if needed
  const today = new Date();
  const diff = Math.floor((today - seasonStart) / (1000 * 60 * 60 * 24));
  return Math.max(1, Math.min(38, Math.ceil(diff / 7)));
}

async function fetchStats(homeTeamId, awayTeamId) {
  try {
    const key = process.env.FOOTBALL_API_KEY;
    if (!key) {
      console.log('No FOOTBALL_API_KEY found in env');
      return { h2h: [], homeStats: {}, awayStats: {} };
    }

    const headers = { 'x-apisports-key': key };
    const league = 39;  // Premier League

    // Helper to get last 5 matches form for a team
    const getRecentForm = async (teamId) => {
      const res = await fetch(
        `https://v3.football.api-sports.io/fixtures?team=${teamId}&league=${league}&last=5`,
        { headers }
      );
      const data = await res.json().catch(() => ({}));
      if (!data.response) return [];

      const sortedMatches = data.response.sort(
        (a, b) => new Date(a.fixture.date) - new Date(b.fixture.date)
      );

      return sortedMatches.map(match => {
        if (match.teams.home.id === teamId) {
          if (match.goals.home > match.goals.away) return "W";
          if (match.goals.home < match.goals.away) return "L";
          return "D";
        } else {
          if (match.goals.away > match.goals.home) return "W";
          if (match.goals.away < match.goals.home) return "L";
          return "D";
        }
      });
    };

    // H2H for completeness
    const h2hUrl = `https://v3.football.api-sports.io/fixtures/headtohead?h2h=${homeTeamId}-${awayTeamId}`;
    const h2hRes = await fetch(h2hUrl, { headers });
    const h2hData = await h2hRes.json().catch(() => ({}));

    const h2hArray = h2hData?.response ?? [];
    const lastH2H = h2hArray.length > 0 ? [h2hArray[0]] : [];

    const [homeForm, awayForm] = await Promise.all([
      getRecentForm(homeTeamId),
      getRecentForm(awayTeamId)
    ]);

    const safe = (obj, path, fallback = null) => {
      try {
        return path.split('.').reduce((a, b) => (a && a[b] !== undefined ? a[b] : undefined), obj) ?? fallback;
      } catch {
        return fallback;
      }
    };

    const stats = {
      h2h: lastH2H,
      homeStats: {
        id: homeTeamId,
        name: `Home Team ${homeTeamId}`,
        recentForm: homeForm
      },
      awayStats: {
        id: awayTeamId,
        name: `Away Team ${awayTeamId}`,
        recentForm: awayForm
      }
    };

    return stats;
  } catch (err) {
    console.log('Error fetching stats:', err);
    return {
      h2h: [], 
      homeStats: { id: null, name: 'Home', recentForm: [] },
      awayStats: { id: null, name: 'Away', recentForm: [] },
    };
  }
}

// ----- FREE WEEKLY PREDICTION -----
router.post('/free', auth, async (req, res) => {
  try {
    let { fixtureId, homeTeam, awayTeam } = req.body;

    if (!homeTeam && req.body.fixture) {
      const f = req.body.fixture;
      homeTeam = f?.home?.id ?? homeTeam;
      awayTeam = f?.away?.id ?? awayTeam;
      fixtureId = fixtureId ?? f?.id;
    }

    if (homeTeam?.id) homeTeam = homeTeam.id;
    if (awayTeam?.id) awayTeam = awayTeam.id;

    if (!homeTeam || !awayTeam) {
      return res.status(400).json({ error: 'homeTeam and awayTeam IDs required' });
    }

    const gameweek = `GW${getGameWeek()}`;

    if (!req.user || !req.user.id) {
      return res.status(401).json({ error: 'Unauthorized: user missing' });
    }

    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (!user.isPremium && user.freePredictions && user.freePredictions[gameweek]) {
      return res.status(403).json({ error: 'Free prediction already used this week' });
    }

    // Get stats
    const stats = await fetchStats(homeTeam, awayTeam);
    console.log('Stats being sent to OpenAI:', JSON.stringify(stats, null, 2));

    // Random boldness (30% chance)
    const boldChance = Math.random() < 0.3;
    const boldInstruction = boldChance
      ? "Occasionally phrase predictions boldly if stats support it, using concise confident words."
      : "";

    // --- Chart prompt instruction ---
    const chartInstruction = `
Generate multiple text-based charts with minimal reasoning. Include:
1. Win probability chart (Home/Draw/Away) using bars like █
2. Expected goals chart for both teams using bars
3. Include recent 5-match form (W/D/L)
Do not write paragraphs; only charts and bullet points.
`;

    const prompt = [
      `You are a football analyst. Provide concise prediction charts for the upcoming match.`,
      boldInstruction,
      chartInstruction,
      `Home team: ${stats.homeStats.name} (ID: ${homeTeam})`,
      `Away team: ${stats.awayStats.name} (ID: ${awayTeam})`,
      `Stats: ${JSON.stringify(stats)}`
    ].join("\n");

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are a football analyst.' },
        { role: 'user', content: prompt }
      ],
      max_tokens: 400,
      temperature: 0.75,
    });

    const prediction = completion.choices?.[0]?.message?.content ?? 'No prediction returned';

    if (!user.isPremium) {
      user.freePredictions = user.freePredictions || {};
      user.freePredictions[gameweek] = true;
      await user.save();
    }

    res.json({ prediction, stats });
  } catch (err) {
    console.error('Prediction route error:', err);
    if (err?.status === 429) {
      return res.status(429).json({ error: 'OpenAI quota/rate limit. Check your API key and quota.' });
    }
    res.status(500).json({ error: 'Prediction failed' });
  }
});

module.exports = router;
