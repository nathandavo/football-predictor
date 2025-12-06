// routes/prediction.js
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const OpenAI = require('openai');
const User = require('../models/User');
const fetch = require('node-fetch'); // npm i node-fetch@2

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Helper to get current Premier League gameweek (1–38)
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

    // Fetch last 5 matches
    const getRecentMatches = async (teamId) => {
      const res = await fetch(
        `https://v3.football.api-sports.io/fixtures?team=${teamId}&league=${league}&last=5`,
        { headers }
      );
      const data = await res.json().catch(() => ({}));
      return (data.response ?? []).sort((a, b) => new Date(a.fixture.date) - new Date(b.fixture.date));
    };

    // Compute stats from matches
    const calcStatsFromMatches = (matches, teamId) => {
      let goalsScored = 0, goalsConceded = 0, wins = 0, draws = 0, losses = 0;
      const recentForm = [];
      matches.forEach(match => {
        let scored = match.teams.home.id === teamId ? match.goals.home : match.goals.away;
        let conceded = match.teams.home.id === teamId ? match.goals.away : match.goals.home;
        goalsScored += scored;
        goalsConceded += conceded;

        if (scored > conceded) { wins++; recentForm.push("W"); }
        else if (scored < conceded) { losses++; recentForm.push("L"); }
        else { draws++; recentForm.push("D"); }
      });
      return { goalsScored, goalsConceded, wins, draws, losses, recentForm };
    };

    const [homeMatches, awayMatches] = await Promise.all([
      getRecentMatches(homeTeamId),
      getRecentMatches(awayTeamId)
    ]);

    const homeStats = calcStatsFromMatches(homeMatches, homeTeamId);
    const awayStats = calcStatsFromMatches(awayMatches, awayTeamId);

    // H2H - most recent match
    const h2hRes = await fetch(
      `https://v3.football.api-sports.io/fixtures/headtohead?h2h=${homeTeamId}-${awayTeamId}`,
      { headers }
    );
    const h2hData = await h2hRes.json().catch(() => ({}));
    const h2hArray = (h2hData?.response ?? []).sort((a, b) => new Date(b.fixture.date) - new Date(a.fixture.date));
    const lastH2H = h2hArray.length > 0 ? [h2hArray[0]] : [];

    return {
      h2h: lastH2H,
      homeStats: {
        id: homeTeamId,
        name: homeMatches[0]?.teams.home.name ?? "Home Team",
        ...homeStats
      },
      awayStats: {
        id: awayTeamId,
        name: awayMatches[0]?.teams.home.name ?? "Away Team",
        ...awayStats
      }
    };
  } catch (err) {
    console.log('Error fetching stats:', err);
    return { h2h: [], homeStats: {}, awayStats: {} };
  }
}

// ----- FREE WEEKLY PREDICTION -----
router.post('/free', auth, async (req, res) => {
  try {
    let { fixtureId, homeTeam, awayTeam, date } = req.body;

    if (!homeTeam && req.body.fixture) {
      const f = req.body.fixture;
      homeTeam = f?.home?.id ?? homeTeam;
      awayTeam = f?.away?.id ?? awayTeam;
      fixtureId = fixtureId ?? f?.id;
      date = date ?? f?.date;
    }

    if (homeTeam?.id) homeTeam = homeTeam.id;
    if (awayTeam?.id) awayTeam = awayTeam.id;

    if (!homeTeam || !awayTeam) return res.status(400).json({ error: 'homeTeam and awayTeam IDs required' });

    const gameweek = `GW${getGameWeek()}`;

    if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized: user missing' });

    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (!user.isPremium && user.freePredictions?.[gameweek]) {
      return res.status(403).json({ error: 'Free prediction already used this week' });
    }

    // Get stats
    const stats = await fetchStats(homeTeam, awayTeam);
    stats.fixture = { id: fixtureId, date };

    console.log('Stats being sent to OpenAI:', JSON.stringify(stats, null, 2));

    // Boldness and upset logic
    const boldChance = Math.random() < 0.3;
    const upsetChance = Math.random() < 0.2;

    const boldInstruction = boldChance
      ? "Occasionally phrase your prediction boldly if the stats support it. Use confident language like 'will dominate', 'likely to win convincingly', or 'high chance of scoring multiple goals'."
      : "";

    const upsetInstruction = upsetChance
      ? "Additionally, highlight if an underdog might pull off a potential upset based on recent form."
      : "";

    const prompt = [
      `You are a football analyst. Provide a concise prediction in bullet points (score and reasoning) for the upcoming fixture on ${date}.`,
      `Do NOT mention stadiums, grounds, or venue names.`,
      `Only mention: recent form, goals scored/conceded, team stats, home/away performance, and head-to-head.`,
      boldInstruction,
      upsetInstruction,
      `Home team: ${stats.homeStats.name} (ID: ${homeTeam})`,
      `Away team: ${stats.awayStats.name} (ID: ${awayTeam})`,
      `Stats (only last 5 matches considered): ${JSON.stringify(stats)}`
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
    if (err?.status === 429) return res.status(429).json({ error: 'OpenAI quota/rate limit. Check your API key and quota.' });
    res.status(500).json({ error: 'Prediction failed' });
  }
});

module.exports = router;
