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

    // --- Compute Win Probabilities (simple form-based heuristic) ---
    const homeForm = stats.homeStats.recentForm.slice(-5);
    const awayForm = stats.awayStats.recentForm.slice(-5);

    const count = arr => arr.reduce((acc, v) => {
      if (v === 'W') acc.wins++;
      else if (v === 'D') acc.draws++;
      else if (v === 'L') acc.losses++;
      return acc;
    }, { wins: 0, draws: 0, losses: 0 });

    const h = count(homeForm);
    const a = count(awayForm);

    const calcProb = (wins, draws) => wins + draws * 0.5;
    let homeScore = calcProb(h.wins, h.draws);
    let awayScore = calcProb(a.wins, a.draws);
    let drawScore = h.draws + a.draws;
    let total = homeScore + awayScore + drawScore || 1;

    let homePct = Math.round((homeScore / total) * 100);
    let awayPct = Math.round((awayScore / total) * 100);
    let drawPct = 100 - homePct - awayPct;

    // enforce minimum draw percentage
    const minDraw = 20;
    if (drawPct < minDraw) {
      const diff = minDraw - drawPct;
      drawPct = minDraw;
      const reduceHome = Math.round((homePct / (homePct + awayPct)) * diff);
      const reduceAway = diff - reduceHome;
      homePct = Math.max(0, homePct - reduceHome);
      awayPct = Math.max(0, awayPct - reduceAway);
    }

    // --- Compute BTTS Probability (simple heuristic using goals scored + team trends) ---
    // This is a quick heuristic: if both teams have scored often recently, BTTS higher.
    const homeGoals = stats.homeStats.goalsScored ?? 0;
    const awayGoals = stats.awayStats.goalsScored ?? 0;

    // Base BTTS on whether teams score and concede, averaged into a percentage
    const homeScoreFactor = Math.min(1, homeGoals / 1.5); // approx scaling
    const awayScoreFactor = Math.min(1, awayGoals / 1.5);
    let bttsPct = Math.round(((homeScoreFactor + awayScoreFactor) / 2) * 100);

    // clamp
    bttsPct = Math.max(5, Math.min(95, bttsPct));

    // --- Ask OpenAI for a concise score + short explanation + explicit BTTS guess in JSON ---
    // We instruct the model to reply with strict JSON ONLY to avoid parsing errors on the backend.
    const jsonPrompt = [
      `You are a football analyst. Output ONLY strict JSON (no surrounding text).`,
      `Return an object with keys: "score" (string, format "H-A"), "explanation" (short single sentence), "btts" (integer percent).`,
      `Use the teams: Home = ${stats.homeStats.name}, Away = ${stats.awayStats.name}.`,
      `Keep explanation concise (one sentence).`,
      `Example output: {"score":"2-1","explanation":"Home have better form and are scoring more; expect a narrow home win.","btts":62}`
    ].join('\n');

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are a helpful football analyst.' },
        { role: 'user', content: jsonPrompt }
      ],
      max_tokens: 200,
      temperature: 0.6,
    });

    const raw = completion.choices?.[0]?.message?.content ?? '';
    let parsed = null;
    try {
      // try to extract JSON substring first (in case of stray whitespace)
      const firstBrace = raw.indexOf('{');
      const lastBrace = raw.lastIndexOf('}');
      const jsonText = firstBrace !== -1 && lastBrace !== -1 ? raw.slice(firstBrace, lastBrace + 1) : raw;
      parsed = JSON.parse(jsonText);
    } catch (e) {
      // fallback: if parsing fails, create a fallback structured object using heuristics
      parsed = {
        score: "1-1",
        explanation: typeof raw === 'string' ? raw.trim().split('\n')[0].slice(0, 200) : 'Tight match; no clear edge.',
        btts: bttsPct
      };
    }

    // Ensure parsed fields exist and are sensible
    const score = typeof parsed.score === 'string' ? parsed.score : '1-1';
    const explanation = typeof parsed.explanation === 'string' ? parsed.explanation : (parsed.explain || 'Prediction unavailable');
    const aiBtts = Number.isFinite(parsed.btts) ? Math.round(parsed.btts) : bttsPct;

    // Mark free prediction used for non-premium users
    if (!user.isPremium) {
      user.freePredictions = user.freePredictions || {};
      user.freePredictions[gameweek] = true;
      await user.save();
    }

    // --- Send everything frontend expects ---
    return res.json({
      // Ai-provided score and explanation (clean)
      score,
      explanation,
      // Raw AI text (for debugging / display if needed)
      rawAi: raw,
      // Win chances (home/draw/away)
      winChances: { home: homePct, draw: drawPct, away: awayPct },
      // BTTS percentage
      bttsPct: aiBtts,
      // recent form arrays (oldest -> most recent)
      recentForm: { home: stats.homeStats.recentForm, away: stats.awayStats.recentForm },
      // include some stats for frontend if needed
      stats
    });

  } catch (err) {
    console.error('Prediction route error:', err);
    if (err?.status === 429)
      return res.status(429).json({ error: 'OpenAI quota/rate limit. Check your API key and quota.' });
    res.status(500).json({ error: 'Prediction failed' });
  }
});

module.exports = router;
