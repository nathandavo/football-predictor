// routes/prediction.js
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const OpenAI = require('openai');
const User = require('../models/User');
const fetch = require('node-fetch'); // ensure installed: npm i node-fetch@2

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Helper to get current Premier League gameweek (1–38)
function getGameWeek() {
  const seasonStart = new Date('2025-08-01'); // adjust if needed
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
    const league = 39; // Premier League

    const getRecentForm = async (teamId) => {
      const res = await fetch(
        `https://v3.football.api-sports.io/fixtures?team=${teamId}&league=${league}&last=5`,
        { headers }
      );
      const data = await res.json().catch(() => ({}));
      if (!data.response) return [];

      // sort oldest -> newest
      const sortedMatches = data.response.sort((a, b) => new Date(a.fixture.date) - new Date(b.fixture.date));

      return sortedMatches.map(match => {
        if (match.teams.home.id === teamId) {
          if ((match.goals.home ?? 0) > (match.goals.away ?? 0)) return "W";
          if ((match.goals.home ?? 0) < (match.goals.away ?? 0)) return "L";
          return "D";
        } else {
          if ((match.goals.away ?? 0) > (match.goals.home ?? 0)) return "W";
          if ((match.goals.away ?? 0) < (match.goals.home ?? 0)) return "L";
          return "D";
        }
      });
    };

    // H2H: take most recent only (if available)
    const h2hUrl = `https://v3.football.api-sports.io/fixtures/headtohead?h2h=${homeTeamId}-${awayTeamId}`;
    const h2hRes = await fetch(h2hUrl, { headers });
    const h2hData = await h2hRes.json().catch(() => ({}));
    const h2hArray = h2hData?.response ?? [];
    const lastH2H = h2hArray.length > 0 ? [h2hArray[0]] : []; // only most recent

    const [homeForm, awayForm] = await Promise.all([
      getRecentForm(homeTeamId),
      getRecentForm(awayTeamId),
    ]);

    const safe = (obj, path, fallback = null) => {
      try {
        return path.split('.').reduce((a, b) => (a && a[b] !== undefined ? a[b] : undefined), obj) ?? fallback;
      } catch {
        return fallback;
      }
    };

    const [homeStatsRes, awayStatsRes] = await Promise.all([
      fetch(`https://v3.football.api-sports.io/teams/statistics?league=${league}&season=2025&team=${homeTeamId}`, { headers }),
      fetch(`https://v3.football.api-sports.io/teams/statistics?league=${league}&season=2025&team=${awayTeamId}`, { headers }),
    ]);

    const homeData = await homeStatsRes.json().catch(() => ({}));
    const awayData = await awayStatsRes.json().catch(() => ({}));

    return {
      h2h: lastH2H,
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
      }
    };
  } catch (err) {
    console.error('Error fetching stats:', err);
    return {
      h2h: [],
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

    if (!homeTeam || !awayTeam) return res.status(400).json({ error: 'homeTeam and awayTeam IDs required' });

    const gameweek = `GW${getGameWeek()}`;

    if (!req.user || !req.user.id) return res.status(401).json({ error: 'Unauthorized: user missing' });

    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (!user.isPremium && user.freePredictions && user.freePredictions[gameweek]) {
      return res.status(403).json({ error: 'Free prediction already used this week' });
    }

    // Fetch stats
    const stats = await fetchStats(homeTeam, awayTeam);

    // --- Compute win probabilities from recent form (basic, deterministic) ---
    // Convert form to simple scores: W=1, D=0.5, L=0
    const countWins = arr => (arr || []).filter(x => x === 'W').length;
    const countDraws = arr => (arr || []).filter(x => x === 'D').length;

    const homeForm = (stats.homeStats.recentForm || []).slice(-5);
    const awayForm = (stats.awayStats.recentForm || []).slice(-5);

    const homeScoreRaw = countWins(homeForm) + 0.5 * countDraws(homeForm);
    const awayScoreRaw = countWins(awayForm) + 0.5 * countDraws(awayForm);
    let drawScore = (countDraws(homeForm) + countDraws(awayForm)) || 0;

    let total = homeScoreRaw + awayScoreRaw + drawScore || 1;

    let homePct = Math.round((homeScoreRaw / total) * 100);
    let awayPct = Math.round((awayScoreRaw / total) * 100);
    let drawPct = 100 - homePct - awayPct;

    // enforce minimum draw percentage (helps avoid 0 draws)
    const minDraw = 15;
    if (drawPct < minDraw) {
      const diff = minDraw - drawPct;
      drawPct = minDraw;
      const reduceHome = Math.round((homePct / (homePct + awayPct || 1)) * diff);
      const reduceAway = diff - reduceHome;
      homePct = Math.max(0, homePct - reduceHome);
      awayPct = Math.max(0, awayPct - reduceAway);
    }

    // adjust to sum 100 in case rounding drift
    const fixSum = () => {
      const sum = homePct + drawPct + awayPct;
      if (sum !== 100) {
        const diff = 100 - sum;
        // add diff to the largest
        const maxKey = homePct >= drawPct && homePct >= awayPct ? 'home' : (drawPct >= homePct && drawPct >= awayPct ? 'draw' : 'away');
        if (maxKey === 'home') homePct += diff;
        if (maxKey === 'draw') drawPct += diff;
        if (maxKey === 'away') awayPct += diff;
      }
    };
    fixSum();

    // --- BTTS calculation: simple heuristic (can be replaced with better model) ---
    // We'll estimate based on goalsScored: if both teams have non-zero season goals -> higher btts
    const homeGoals = stats.homeStats.goalsScored || 0;
    const awayGoals = stats.awayStats.goalsScored || 0;
    let bttsPct = 0;
    if (homeGoals > 1.5 && awayGoals > 1.5) bttsPct = 85;
    else if (homeGoals > 1 && awayGoals > 1) bttsPct = 70;
    else if (homeGoals > 0 && awayGoals > 0) bttsPct = 55;
    else bttsPct = 30;

    // --- Ask AI to predict a likely score and give a short explanation. Return JSON to avoid parsing issues. ---
    const aiPrompt = [
      `You are a precise football analyst.`,
      `Return a JSON object ONLY (no extra commentary) with keys: score and explanation.`,
      `score should be a simple string like "2-1" (Home-Away).`,
      `explanation should be 2-3 concise sentences explaining the reasoning (mention form, scoring tendency, or key matchup).`,
      `Do NOT include markdown or extra fields. Example response: {"score":"2-1","explanation":"Short reasoning..."}`
    ].join('\n');

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are a football analyst.' },
        { role: 'user', content: aiPrompt }
      ],
      max_tokens: 200,
      temperature: 0.7,
    });

    // parse AI JSON safely
    let aiScore = null;
    let aiExplanation = null;
    try {
      const raw = completion.choices?.[0]?.message?.content ?? '';
      // sometimes the model emits code blocks - strip them
      const cleaned = raw.replace(/```json|```/g, '').trim();
      const parsed = JSON.parse(cleaned);
      aiScore = parsed.score ?? null;
      aiExplanation = parsed.explanation ?? (typeof parsed === 'string' ? parsed : null);
    } catch (err) {
      // fallback: treat whole text as explanation, and no structured score
      console.warn('AI JSON parse failed, fallback to raw text. Error:', err);
      const raw = completion.choices?.[0]?.message?.content ?? 'No prediction returned';
      aiExplanation = raw;
    }

    if (!user.isPremium) {
      user.freePredictions = user.freePredictions || {};
      user.freePredictions[gameweek] = true;
      await user.save();
    }

    // Send structured response expected by frontend
    return res.json({
      score: aiScore, // may be null if parse failed
      explanation: aiExplanation,
      stats,
      winChances: { home: homePct, draw: drawPct, away: awayPct },
      recentForm: { home: homeForm, away: awayForm },
      bttsPct
    });

  } catch (err) {
    console.error('Prediction route error:', err);
    if (err?.status === 429) return res.status(429).json({ error: 'OpenAI quota/rate limit. Check your API key and quota.' });
    res.status(500).json({ error: 'Prediction failed' });
  }
});

module.exports = router;
