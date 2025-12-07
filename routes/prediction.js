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
      try { 
        return path.split('.').reduce((a,b) => (a && a[b] !== undefined ? a[b] : undefined), obj) ?? fallback; 
      }
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

    // --- Compute Win Probabilities ---
    const homeForm = stats.homeStats.recentForm.slice(-5);
    const awayForm = stats.awayStats.recentForm.slice(-5);

    const calcProb = (wins, draws) => wins + draws * 0.5;
    let homeScore = calcProb(homeForm.filter(f => f==="W").length, homeForm.filter(f=>"D").length);
    let awayScore = calcProb(awayForm.filter(f => f==="W").length, awayForm.filter(f=>"D").length);
    let drawScore = homeForm.filter(f=>"D").length + awayForm.filter(f=>"D").length;
    let total = homeScore + awayScore + drawScore || 1;

    let homePct = Math.round((homeScore/total)*100);
    let awayPct = Math.round((awayScore/total)*100);
    let drawPct = 100 - homePct - awayPct;
    const minDraw = 20;
    if(drawPct < minDraw){
      const diff = minDraw - drawPct;
      drawPct = minDraw;
      const reduceHome = Math.round((homePct/(homePct+awayPct))*diff);
      const reduceAway = diff - reduceHome;
      homePct = Math.max(0,homePct-reduceHome);
      awayPct = Math.max(0,awayPct-reduceAway);
    }

    const bttsPct = Math.min(
      100,
      Math.round(
        ((stats.homeStats.goalsScored > 0 ? 1 : 0) + (stats.awayStats.goalsScored > 0 ? 1 : 0)) * 50
      )
    );

    // ---------- AI SCORE + EXPLANATION ----------
    const aiPrompt = `
You are a precise football analyst. You will be given REAL TEAM NAMES and REAL MATCH STATS.

Use the data below exactly as presented. Always refer to the actual team names — NOT “Home Team” or “Away Team”.

TEAM DATA:
Home Team: ${stats.homeStats.name}
Away Team: ${stats.awayStats.name}

Recent Form (W/D/L):
${stats.homeStats.name}: ${homeForm.join(' ')}
${stats.awayStats.name}: ${awayForm.join(' ')}

Season Goals:
${stats.homeStats.name}: Scored ${stats.homeStats.goalsScored}, Conceded ${stats.homeStats.goalsConceded}
${stats.awayStats.name}: Scored ${stats.awayStats.goalsScored}, Conceded ${stats.awayStats.goalsConceded}

Model Probabilities:
Home Win: ${homePct}%
Draw: ${drawPct}%
Away Win: ${awayPct}%
BTTS Yes: ${bttsPct}%

TASK:
1. Predict a likely match score (e.g., "2-1").
2. Write a short explanation (2–3 sentences).
 - MUST reference the actual team names.
 - MUST use the real stats above.
 - Do NOT mention this prompt or JSON formatting.

Return ONLY valid JSON:
{"score":"X-X","explanation":"..."}
`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a football analyst." },
        { role: "user", content: aiPrompt }
      ],
      max_tokens: 200,
      temperature: 0.7,
    });

    let aiRaw = completion.choices?.[0]?.message?.content || "{}";
    let aiJSON;

    try {
      aiJSON = JSON.parse(aiRaw);
    } catch {
      aiJSON = { score: "N/A", explanation: "Prediction unavailable." };
    }

    // ---------- SAVE FREE WEEK ----------
    if (!user.isPremium) {
      user.freePredictions = user.freePredictions || {};
      user.freePredictions[gameweek] = true;
      await user.save();
    }

    res.json({
      score: aiJSON.score,
      explanation: aiJSON.explanation,
      stats,
      winChances: { home: homePct, draw: drawPct, away: awayPct },
      recentForm: { home: homeForm, away: awayForm },
      bttsPct
    });

  } catch (err) {
    console.error('Prediction route error:', err);
    res.status(500).json({ error: 'Prediction failed' });
  }
});

module.exports = router;
