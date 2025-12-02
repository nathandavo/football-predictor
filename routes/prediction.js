const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const OpenAI = require('openai');
const User = require('../models/User');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Helper to get current Premier League gameweek (1–38)
function getGameWeek() {
  const seasonStart = new Date('2025-08-01'); // adjust each season
  const today = new Date();
  const diff = Math.floor((today - seasonStart) / (1000 * 60 * 60 * 24));
  return Math.max(1, Math.min(38, Math.ceil(diff / 7)));
}

// ----- FREE WEEKLY PREDICTION -----
router.post('/free', auth, async (req, res) => {
  try {
    const { fixtureId, homeTeam, awayTeam, stats } = req.body; // stats: optional advanced stats
    const gameweek = `GW${getGameWeek()}`;

    // Fetch the user from DB
    const user = await User.findById(req.user.id);

    if (!user) return res.status(404).json({ error: 'User not found' });

    // Check if user can use free prediction
    if (!user.isPremium && user.freePredictions.get(gameweek)) {
      return res.status(403).json({ error: 'Free prediction already used this week' });
    }

    // Call OpenAI to generate prediction
    const prompt = `
      Predict the outcome of the football match:
      Home Team: ${homeTeam}
      Away Team: ${awayTeam}
      Stats: ${JSON.stringify(stats || {})}
      Include likely score and a brief reasoning.
    `;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are a football analyst.' },
        { role: 'user', content: prompt }
      ],
    });

    const prediction = completion.choices[0].message.content;

    // Mark free prediction as used
    if (!user.isPremium) {
      user.freePredictions.set(gameweek, true);
      await user.save();
    }

    res.json({ prediction });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Prediction failed' });
  }
});

module.exports = router;
