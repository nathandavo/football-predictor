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
    if (!key) return { h2h: [], homeStats: {}, awayStats: {} };

    const headers = { 'x-apisports-key': key };
    const league = 39;

    // Fetch last 5 matches for a team
    const getRecentMatches = async (teamId) => {
      const res = await fetch(
        `https://v3.football.api-sports.io/fixtures?team=${teamId}&league=${league}&last=5`,
        { headers }
      );
      const data = await res.json().catch(() => ({}));
      if (!data.response) return [];
      return data.response.sort((a, b) => new Date(a.fixture.date) - new Date(b.fixture.date));
    };

    // Calculate stats from matches
    const calcStatsFromMatches = (matches, teamId) => {
      let goalsScored = 0;
      let goalsConceded = 0;
      let wins = 0;
      let draws = 0;
      let losses = 0;
      const recentForm = [];

      matches.forEach(match => {
        let scored, conceded, result;
        if (match.teams.home.id === teamId) {
          scored = match.goals.home;
          conceded = match.goals.away;
        } else {
          scored = match.goals.away;
          conceded = match.goals.home;
        }
        goalsScored += scored;
        goalsConceded += conceded;

        if (scored > conceded) { wins++; result = "W"; }
        else if (scored < conceded) { losses++; result = "L"; }
        else { draws++; result = "D"; }
        recentForm.push(result);
      });

      return { goalsScored, goalsConceded, wins, draws, losses, recentForm };
    };

    const [homeMatches, awayMatches] = await Promise.all([
      getRecentMatches(homeTeamId),
      getRecentMatches(awayTeamId)
    ]);

    const homeStatsRecent = calcStatsFromMatches(homeMatches, homeTeamId);
    const awayStatsRecent = calcStatsFromMatches(awayMatches, awayTeamId);

    // H2H last match
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
        ...homeStatsRecent
      },
      awayStats: {
        id: awayTeamId,
        name: awayMatches[0]?.teams.home.name ?? "Away Team",
        ...awayStatsRecent
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

    if (!req.user || !req.user.id) return res.status(401).json({ error: 'Unauthorized: user missing' });

    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (!user.isPremium && user.freePredictions && user.freePredictions[gameweek]) {
      return res.status(403).json({ error: 'Free prediction already used this week' });
    }

    // Get stats
    const stats = await fetchStats(homeTeam, awayTeam);
    console.log('Stats being sent to OpenAI:', JSON.stringify(stats, null, 2));

    // Random boldness (30% chance) and potential upset (20% chance)
    const boldChance = Math.random() < 0.3;
    const upsetChance = Math.random() < 0.2;

    const boldInstruction = boldChance
      ? "Occasionally phrase your prediction boldly if the stats support it. Use confident language like 'will dominate', 'likely to win convincingly', or 'high chance of scoring multiple goals'."
      : "";

    const upsetInstruction = upsetChance
      ? "Additionally, highlight if an underdog might pull off a potential upset based on recent form."
      : "";

    // ✅ Prompt with recent stats, bold and upset logic
    const prompt = [
      `You are a football analyst. Provide a concise prediction in bullet points (score and reasoning).`,
      `Do NOT mention stadiums, grounds, or venue names.`,
      `Only mention: recent form, goals scored/conceded, team stats, home/away performance, and head-to-head.`,
      boldInstruction,
      upsetInstruction,
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
    if (err?.status === 429) return res.status(429).json({ error: 'OpenAI quota/rate limit. Check your API key and quota.' });
    res.status(500).json({ error: 'Prediction failed' });
  }
});

module.exports = router;
