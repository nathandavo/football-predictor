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

    const h2hUrl = `https://v3.football.api-sports.io/fixtures/headtohead?h2h=${homeTeamId}-${awayTeamId}`;
    const h2hRes = await fetch(h2hUrl, { headers });
    const h2hData = await h2hRes.json().catch(() => ({}));

    const h2hArray = h2hData?.response ?? [];
    const lastH2H = h2hArray.length > 0 ? [h2hArray[0]] : [];

    const [homeForm, awayForm] = await Promise.all([
      getRecentForm(homeTeamId),
      getRecentForm(awayTeamId)
    ]);

    const [homeStatsRes, awayStatsRes] = await Promise.all([
      fetch(`https://v3.football.api-sports.io/teams/statistics?league=${league}&season=2025&team=${homeTeamId}`, { headers }),
      fetch(`https://v3.football.api-sports.io/teams/statistics?league=${league}&season=2025&team=${awayTeamId}`, { headers }),
    ]);

    const safe = (obj, path, fallback = null) => {
      try {
        return path.split('.').reduce((a, b) => (a && a[b] !== undefined ? a[b] : undefined), obj) ?? fallback;
      } catch {
        return fallback;
      }
    };

    const homeData = await homeStatsRes.json().catch(() => ({}));
    const awayData = await awayStatsRes.json().catch(() => ({}));

    const stats = {
      h2h: lastH2H,
      homeStats: {
        id: homeTeamId,
        name: safe(homeData, 'response.team.name', 'Home Team'),
        goalsScored: safe(homeData, 'response.goals.for.total.total', 0),
        goalsConceded: safe(homeData, 'response.goals.against.total.total', 0),
        recentForm: homeForm,
        wins: safe(homeData, 'response.fixtures.wins.total', 0),
        draws: safe(homeData, 'response.fixtures.draws.total', 0),
        losses: safe(homeData, 'response.fixtures.loses.total', 0),
      },
      awayStats: {
        id: awayTeamId,
        name: safe(awayData, 'response.team.name', 'Away Team'),
        goalsScored: safe(awayData, 'response.goals.for.total.total', 0),
        goalsConceded: safe(awayData, 'response.goals.against.total.total', 0),
        recentForm: awayForm,
        wins: safe(awayData, 'response.fixtures.wins.total', 0),
        draws: safe(awayData, 'response.fixtures.draws.total', 0),
        losses: safe(awayData, 'response.fixtures.loses.total', 0),
      },
    };

    return stats;
  } catch (err) {
    console.log('Error fetching stats:', err);
    return {
      h2h: [],
      homeStats: { id: null, name: 'Home', goalsScored: 0, goalsConceded: 0, recentForm: [], wins: 0, draws: 0, losses: 0 },
      awayStats: { id: null, name: 'Away', goalsScored: 0, goalsConceded: 0, recentForm: [], wins: 0, draws: 0, losses: 0 },
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

    const stats = await fetchStats(homeTeam, awayTeam);
    console.log('Stats being sent to OpenAI:', JSON.stringify(stats, null, 2));

    // Random boldness (30% chance)
    const boldChance = Math.random() < 0.3;
    const boldInstruction = boldChance
      ? "Occasionally phrase your prediction boldly if the stats support it. Use confident language like 'will dominate', 'likely to win convincingly', or 'high chance of scoring multiple goals'."
      : "";

    // ⭐ ADDED — Upset Detector (25% chance)
    const upsetChance = Math.random() < 0.25;
    const upsetInstruction = upsetChance
      ? "Look specifically for a potential UPSET. Analyse whether the underdog has any statistical or situational advantages such as recent strong form, defensive improvements, opponent fatigue, missing key players, away disadvantage, or inconsistent play. If plausible, clearly state the upset scenario."
      : "";

    // Prompt
    const prompt = [
      `You are a football analyst. Provide a concise prediction in bullet points (score and reasoning).`,
      `Do NOT mention stadiums, grounds, or venue names.`,
      `Only mention: recent form, goals scored/conceded, team stats, home/away performance, and head-to-head.`,
      boldInstruction,
      upsetInstruction, // ⭐ INSERTED HERE
      `Home team: ${stats.homeStats.name} (ID: ${homeTeam})`,
      `Away team: ${stats.awayStats.name} (ID: ${awayTeam})`,
      `Stats: ${JSON.stringify(stats)}`
    ].join('\n');

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are a football analyst.' },
        { role: 'user', content: prompt }
      ],
      max_tokens: 300,
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
