const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const OpenAI = require('openai');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Helper to get current Premier League gameweek (1–38)
function getGameWeek() {
  const seasonStart = new Date('2024-08-01'); // adjust each season
  const today = new Date();
  const diff = Math.floor((today - seasonStart) / (1000 * 60 * 60 * 24));
  return Math.max(1, Math.min(38, Math.ceil(diff / 7)));
}

// ----- FREE WEEKLY PREDICTION -----
router.post('/free', auth, async (req, res) => {
  const { fixtureId, homeTeam, awayTeam } = req.body;

  const gameweek = getGameWeek();

  // Ensure the user has a freePredictions object
  if (!req.user.freePredictions) {
    req.user.freePredictions = {};
  }

  // Block if used already this week
  if (req.user.freePredictions[gameweek]) {
    return res.status(403).json({
      error: 'You already used your free prediction this gameweek'
    });
  }

  try {
    const prompt = `
      Predict the Premier League match result.
      Match: ${homeTeam} vs ${awayTeam}.
      Include:
      - Final score
      - Winner
      - Win probability %
      - Very short reasoning
    `;

    const aiResponse = await openai.responses.create({
      model: 'gpt-4.1-mini',
      input: prompt
    });

    const prediction = aiResponse.output[0].content[0].text;

    // Save that the user has used the free prediction
    req.user.freePredictions[gameweek] = fixtureId;
    await req.user.save();

    return res.json({ prediction });

  } catch (err) {
    console.error('OpenAI error:', err);
    return res.status(500).json({ error: 'Prediction failed' });
  }
});

module.exports = router;
