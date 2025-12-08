// routes/prediction.js
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const OpenAI = require('openai');
const User = require('../models/User');
const fetch = require('node-fetch');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function getGameWeek() {
  const seasonStart = new Date('2025-08-01');
  const today = new Date();
  const diff = Math.floor((today - seasonStart) / (1000 * 60 * 60 * 24));
  return Math.max(1, Math.min(38, Math.ceil(diff / 7)));
}

async function fetchStats(homeTeamId, awayTeamId) {
  try {
    const key = process.env.FOOTBALL_API_KEY;
    if (!key) return { homeStats: {}, awayStats: {} };

    const headers = { 'x-apisports-key': key };
    const league = 39;

    // ★★★★★ FIXED VERSION — ONLY CHANGE ★★★★★
    const getRecentForm = async (teamId) => {
      const res = await fetch(
        `https://v3.football.api-sports.io/fixtures?team=${teamId}&league=${league}&season=2025&last=5`,
        { headers }
      );
      const data = await res.json().catch(() => ({}));
      if (!data.response) return [];

      // sort oldest → newest (correct)
      const matches = data.response.sort(
        (a, b) => new Date(a.fixture.date) - new Date(b.fixture.date)
      );

      // convert to W/D/L correctly
      const form = matches.map(match => {
        const isHome = match.teams.home.id === teamId;
        const gf = isHome ? match.goals.home : match.goals.away;
        const ga = isHome ? match.goals.away : match.goals.home;

        if (gf > ga) return "W";
        if (gf < ga) return "L";
        return "D";
      });

      return form; // front-end already shows newest on the right
    };
    // ★★★★★ END OF FIX — NOTHING ELSE TOUCHED ★★★★★

    const [homeForm, awayForm] = await Promise.all([
      getRecentForm(homeTeamId),
      getRecentForm(awayTeamId)
    ]);

    const safe = (obj, path, fallback = null) => {
      try { return path.split('.').reduce((a,b) => (a && a[b] !== undefined ? a[b] : undefined), obj) ?? fallback; }
      catch { return fallback; }
    };

    const homeStatsRes = await fetch(
      `https://v3.football.api-sports.io/teams/statistics?league=${league}&season=2025&team=${homeTeamId}`,
      { headers }
    );
    const awayStatsRes = await fetch(
      `https://v3.football.api-sports.io/teams/statistics?league=${league}&season=2025&team=${awayTeamId}`,
      { headers }
    );

    const homeData = await homeStatsRes.json().catch(() => ({}));
    const awayData = await awayStatsRes.json().catch(() => ({}));

    return {
      homeStats: {
        id: homeTeamId,
        name: safe(homeData, 'response.team.name', 'Home Team'),
        goalsScored: safe(homeData, 'response.goals.for.total.total', 0),
        goalsConceded: safe(homeData, 'response.goals.against.total.total', 0),
        recentForm: homeForm,
      },
      awayStats: {
        id: awayTeamId,
        name: safe(awayData, 'response.team.name', 'Away Team'),
        goalsScored: safe(awayData, 'response.goals.for.total.total', 0),
        goalsConceded: safe(awayData, 'response.goals.against.total.total', 0),
        recentForm: awayForm,
      },
    };
  } catch (err) {
    console.log('Error fetching stats:', err);
    return {
      homeStats: { id: null, name: 'Home', goalsScored: 0, goalsConceded: 0, recentForm: [] },
      awayStats: { id: null, name: 'Away', goalsScored: 0, goalsConceded: 0, recentForm: [] },
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

    if (!homeTeam || !awayTeam)
      return res.status(400).json({ error: 'homeTeam and awayTeam IDs required' });

    const gameweek = `GW${getGameWeek()}`;

    if (!req.user || !req.user.id)
      return res.status(401).json({ error: 'Unauthorized: user missing' });

    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (!user.isPremium && user.freePredictions && user.freePredictions[gameweek]) {
      return res.status(403).json({ error: 'Free prediction already used this week' });
    }

    const stats = await fetchStats(homeTeam, awayTeam);

    const prompt = `
You are a football analyst. Using the real season stats and recent form, predict the upcoming match between ${stats.homeStats.name} (Home) and ${stats.awayStats.name} (Away).
Return a JSON object ONLY with the following keys:
- "score"
- "winChances" (home/draw/away)
- "bttsPct"
- "reasoning"
- "recentForm" (use real last 5 from API, do NOT change order)
    `;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are a football analyst.' },
        { role: 'user', content: prompt }
      ],
      max_tokens: 350,
      temperature: 0.75
    });

    let aiPredictionRaw = completion.choices?.[0]?.message?.content ?? '';
    let aiPrediction;
    try {
      aiPrediction = JSON.parse(aiPredictionRaw);
    } catch (err) {
      console.log('GPT output parsing failed:', aiPredictionRaw);
      aiPrediction = {
        score: 'N/A',
        winChances: { home: 33, draw: 34, away: 33 },
        bttsPct: 50,
        reasoning: 'Prediction unavailable',
        recentForm: { home: stats.homeStats.recentForm.slice(-5), away: stats.awayStats.recentForm.slice(-5) }
      };
    }

    if (!user.isPremium) {
      user.freePredictions = user.freePredictions || {};
      user.freePredictions[gameweek] = true;
      await user.save();
    }

    res.json({
      score: aiPrediction.score,
      winChances: aiPrediction.winChances,
      bttsPct: aiPrediction.bttsPct,
      reasoning: aiPrediction.reasoning,
      recentForm: aiPrediction.recentForm
    });

  } catch (err) {
    console.error('Prediction route error:', err);
    if (err?.status === 429)
      return res.status(429).json({ error: 'OpenAI quota/rate limit. Check your API key and quota.' });
    res.status(500).json({ error: 'Prediction failed' });
  }
});

module.exports = router;
