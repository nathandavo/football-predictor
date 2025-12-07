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
    if (!key) return { h2h: [], homeStats: {}, awayStats: {} };

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

    const h2hRes = await fetch(
      `https://v3.football.api-sports.io/fixtures/headtohead?h2h=${homeTeamId}-${awayTeamId}`,
      { headers }
    );
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
      } catch { return fallback; }
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
      },
    };
  } catch (err) {
    console.log('Error fetching stats:', err);
    return {
      h2h: [],
      homeStats: { id: null, name: 'Home', goalsScored: 0, goalsConceded: 0, recentForm: [] },
      awayStats: { id: null, name: 'Away', goalsScored: 0, goalsConceded: 0, recentForm: [] },
    };
  }
}

// ----- FREE WEEKLY PREDICTION -----
// This endpoint asks the AI to return strict JSON with percentages (AI generates percentages)
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

    // fetch stats (real API)
    const stats = await fetchStats(homeTeam, awayTeam);

    // Build a strict JSON-only prompt. We ask the model to produce numeric percentages that sum to 100.
    const prompt = [
      `You are a football analyst. Based on the provided stats, return strictly valid JSON (no commentary) with these fields:`,
      `- "score": string predicted score like "2-1"`,
      `- "winChances": { "home": number, "draw": number, "away": number } (integers summing to 100)`,
      `- "bttsPct": number (0-100)`,
      `- "reasoning": short reasoning sentence (one or two sentences) that mentions the real team names (not "home" or "away")`,
      ``,
      `Provide the JSON only. Example output exactly as JSON:`,
      `{"score":"2-1","winChances":{"home":55,"draw":25,"away":20},"bttsPct":60,"reasoning":"TeamA's attack is strong..."}`
    ].join('\n');

    // Append stats JSON after the strict instructions, so the model uses them
    const userMessage = `STATS:\n${JSON.stringify(stats)}\n\nINSTRUCTIONS:\n${prompt}`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are a precise football analyst. Output only JSON.' },
        { role: 'user', content: userMessage }
      ],
      max_tokens: 300,
      temperature: 0.7,
    });

    const raw = completion.choices?.[0]?.message?.content ?? '';
    let parsed = null;

    // Try to parse JSON strictly; if AI wraps it in backticks or text, extract JSON substring
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      // try to find first { ... } substring
      const firstBrace = raw.indexOf('{');
      const lastBrace = raw.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        const jsonStr = raw.slice(firstBrace, lastBrace + 1);
        try {
          parsed = JSON.parse(jsonStr);
        } catch (e2) {
          parsed = null;
        }
      }
    }

    // If parsing failed, fallback to a conservative computed output (so frontend still works)
    if (!parsed || typeof parsed !== 'object') {
      // fallback: simple heuristic from recent form and goals
      const homeForm = stats.homeStats.recentForm.slice(-5);
      const awayForm = stats.awayStats.recentForm.slice(-5);
      const calcProb = (wins, draws) => wins + draws * 0.5;
      const homeScore = calcProb(homeForm.filter(f => f==="W").length, homeForm.filter(f => f==="D").length);
      const awayScore = calcProb(awayForm.filter(f => f==="W").length, awayForm.filter(f => f==="D").length);
      let drawScore = homeForm.filter(f => f==="D").length + awayForm.filter(f => f==="D").length;
      let total = homeScore + awayScore + drawScore || 1;
      let homePct = Math.round((homeScore/total)*100);
      let awayPct = Math.round((awayScore/total)*100);
      let drawPct = 100 - homePct - awayPct;

      // ensure sum 100
      if (homePct + drawPct + awayPct !== 100) {
        const diff = 100 - (homePct + drawPct + awayPct);
        homePct = Math.max(0, homePct + diff);
      }

      const bttsPct = Math.min(100, Math.round(((stats.homeStats.goalsScored>0?1:0)+(stats.awayStats.goalsScored>0?1:0))*50));
      parsed = {
        score: "1-1",
        winChances: { home: homePct, draw: drawPct, away: awayPct },
        bttsPct,
        reasoning: `${stats.homeStats.name} vs ${stats.awayStats.name}: fallback prediction based on recent form.`,
      };
    }

    // Basic validation/corrections: ensure winChances exist & sum to 100
    parsed.winChances = parsed.winChances || { home: 33, draw: 34, away: 33 };
    const sum = (parsed.winChances.home||0) + (parsed.winChances.draw||0) + (parsed.winChances.away||0);
    if (sum !== 100) {
      // normalize to 100 (rounding)
      const rawHome = parsed.winChances.home || 0;
      const rawDraw = parsed.winChances.draw || 0;
      const rawAway = parsed.winChances.away || 0;
      const totalRaw = rawHome + rawDraw + rawAway || 1;
      parsed.winChances.home = Math.round((rawHome/totalRaw)*100);
      parsed.winChances.draw = Math.round((rawDraw/totalRaw)*100);
      parsed.winChances.away = 100 - parsed.winChances.home - parsed.winChances.draw;
    }

    // Ensure numeric bttsPct
    parsed.bttsPct = Number(parsed.bttsPct) || 0;
    parsed.score = String(parsed.score || "N/A");
    parsed.reasoning = String(parsed.reasoning || '');

    // mark free usage if needed
    if (!user.isPremium) {
      user.freePredictions = user.freePredictions || {};
      user.freePredictions[gameweek] = true;
      await user.save();
    }

    // Send structured response
    res.json({
      predictionText: raw, // raw AI content (for debugging if needed)
      score: parsed.score,
      winChances: parsed.winChances,
      bttsPct: parsed.bttsPct,
      reasoning: parsed.reasoning,
      recentForm: {
        home: stats.homeStats.recentForm.slice(-5),
        away: stats.awayStats.recentForm.slice(-5),
      },
      stats,
    });
  } catch (err) {
    console.error('Prediction route error:', err);
    if (err?.status === 429) return res.status(429).json({ error: 'OpenAI quota/rate limit. Check your API key and quota.' });
    res.status(500).json({ error: 'Prediction failed' });
  }
});

module.exports = router;
