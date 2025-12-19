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
  return `GW${Math.max(1, Math.min(38, Math.ceil(diff / 7)))}`;
}

async function fetchStats(homeTeamId, awayTeamId) {
  try {
    const key = process.env.FOOTBALL_API_KEY;
    if (!key) return { homeStats: {}, awayStats: {} };

    const headers = { 'x-apisports-key': key };
    const league = 39;

    const getRecentForm = async (teamId) => {
      const res = await fetch(
        `https://v3.football.api-sports.io/fixtures?team=${teamId}&league=${league}&season=2025&status=FT`,
        { headers }
      );
      const data = await res.json().catch(() => ({}));
      if (!data.response) return [];

      return data.response
        .filter(f => f.league.id === league)
        .sort((a, b) => new Date(a.fixture.date) - new Date(b.fixture.date))
        .slice(-5)
        .map(match => {
          const isHome = match.teams.home.id === teamId;
          const gf = isHome ? match.goals.home : match.goals.away;
          const ga = isHome ? match.goals.away : match.goals.home;
          if (gf > ga) return 'W';
          if (gf < ga) return 'L';
          return 'D';
        });
    };

    const [homeForm, awayForm] = await Promise.all([
      getRecentForm(homeTeamId),
      getRecentForm(awayTeamId),
    ]);

    const safe = (obj, path, fallback = 0) => {
      try {
        return path.split('.').reduce((a, b) => a?.[b], obj) ?? fallback;
      } catch {
        return fallback;
      }
    };

    const [homeRes, awayRes] = await Promise.all([
      fetch(`https://v3.football.api-sports.io/teams/statistics?league=${league}&season=2025&team=${homeTeamId}`, { headers }),
      fetch(`https://v3.football.api-sports.io/teams/statistics?league=${league}&season=2025&team=${awayTeamId}`, { headers }),
    ]);

    const homeData = await homeRes.json().catch(() => ({}));
    const awayData = await awayRes.json().catch(() => ({}));

    return {
      homeStats: {
        name: safe(homeData, 'response.team.name', 'Home Team'),
        goalsScored: safe(homeData, 'response.goals.for.total.total'),
        goalsConceded: safe(homeData, 'response.goals.against.total.total'),
        recentForm: homeForm,
      },
      awayStats: {
        name: safe(awayData, 'response.team.name', 'Away Team'),
        goalsScored: safe(awayData, 'response.goals.for.total.total'),
        goalsConceded: safe(awayData, 'response.goals.against.total.total'),
        recentForm: awayForm,
      },
    };
  } catch (err) {
    console.error('Error fetching stats:', err);
    return {
      homeStats: { recentForm: [] },
      awayStats: { recentForm: [] },
    };
  }
}

/* ============================
   FREE WEEKLY PREDICTION
============================ */

router.post('/free', auth, async (req, res) => {
  try {
    let { fixtureId, homeTeam, awayTeam } = req.body;

    if (!homeTeam && req.body.fixture) {
      const f = req.body.fixture;
      homeTeam = f?.home?.id;
      awayTeam = f?.away?.id;
      fixtureId = f?.id;
    }

    if (homeTeam?.id) homeTeam = homeTeam.id;
    if (awayTeam?.id) awayTeam = awayTeam.id;

    if (!homeTeam || !awayTeam) {
      return res.status(400).json({ error: 'homeTeam and awayTeam IDs required' });
    }

    const gameweek = getGameWeek();
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // ✅ FIX: Ensure freePredictions is a Map so new users can get prediction
    if (!user.isPremium) {
      if (!(user.freePredictions instanceof Map)) {
        user.freePredictions = new Map(Object.entries(user.freePredictions || {}));
      }

      if (user.freePredictions.get(gameweek)) {
        return res.status(403).json({ error: 'Free prediction already used this week' });
      }
    }

    const stats = await fetchStats(homeTeam, awayTeam);

    // ✅ OpenAI prompt unchanged
    const prompt = `
You are a professional football betting analyst.

Match:
${stats.homeStats.name} vs ${stats.awayStats.name}

Stats context:
- ${stats.homeStats.name} goals scored this season: ${stats.homeStats.goalsScored}
- ${stats.homeStats.name} goals conceded this season: ${stats.homeStats.goalsConceded}
- Recent form (${stats.homeStats.name}): ${stats.homeStats.recentForm.join(" ")}

- ${stats.awayStats.name} goals scored this season: ${stats.awayStats.goalsScored}
- ${stats.awayStats.name} goals conceded this season: ${stats.awayStats.goalsConceded}
- Recent form (${stats.awayStats.name}): ${stats.awayStats.recentForm.join(" ")}

TASK:
- Predict the most likely score
- Estimate win probabilities
- Estimate BTTS probability
- Provide a **specific, non-generic explanation**
- Reference concrete factors (form trend, defensive weakness, goal patterns)
- Avoid phrases like "home advantage" unless supported by stats
- Keep reasoning under 3 sentences

Return ONLY valid JSON:
{
  "score": "2-1",
  "winChances": { "home": 45, "draw": 25, "away": 30 },
  "bttsPct": 62,
  "reasoning": "Concise analytical explanation",
  "recentForm": {
    "home": ["W","D","L","W","W"],
    "away": ["L","D","W","L","D"]
  }
}
`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.6,
      max_tokens: 350,
    });

    let aiRaw = completion.choices?.[0]?.message?.content ?? '';
    let ai;

    try {
      ai = JSON.parse(aiRaw);
    } catch {
      ai = {
        score: 'N/A',
        winChances: { home: 33, draw: 34, away: 33 },
        bttsPct: 50,
        reasoning: 'Prediction unavailable',
        recentForm: {
          home: stats.homeStats.recentForm,
          away: stats.awayStats.recentForm,
        },
      };
    }

    // ✅ Mark free prediction used
    if (!user.isPremium) {
      user.freePredictions.set(gameweek, true);
      await user.save();
    }

    res.json(ai);
  } catch (err) {
    console.error('Prediction route error:', err);
    res.status(500).json({ error: 'Prediction failed' });
  }
});

module.exports = router;

