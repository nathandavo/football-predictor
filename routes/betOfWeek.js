const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const OpenAI = require("openai");
const fetch = require("node-fetch");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function getGameWeek() {
  const seasonStart = new Date("2025-08-01");
  const today = new Date();
  const diff = Math.floor((today - seasonStart) / (1000 * 60 * 60 * 24));
  return `GW${Math.max(1, Math.min(38, Math.ceil(diff / 7)))}`;
}

router.get("/", auth, async (req, res) => {
  try {
    // 🔒 Premium only
    if (!req.user?.isPremium) {
      return res.status(403).json({ error: "Premium only" });
    }

    const gameweek = getGameWeek();

    const prompt = `
You are a professional football betting analyst.

Select the SINGLE strongest bet for EACH of these markets from the upcoming Premier League fixtures for ${gameweek}:

1. Over 2.5 Goals
2. Both Teams To Score (BTTS)
3. Match Winner

Rules:
- All selections must be from DIFFERENT matches
- Choose only HIGH CONFIDENCE bets
- Base decisions on stats, form, goals scored/conceded
- Be conservative, avoid risky picks

Return ONLY JSON in this format:

{
  "gameweek": "${gameweek}",
  "picks": [
    {
      "market": "Over 2.5 Goals",
      "match": "Team A vs Team B",
      "selection": "Over 2.5",
      "confidence": 75
    },
    {
      "market": "Both Teams To Score",
      "match": "Team C vs Team D",
      "selection": "Yes",
      "confidence": 72
    },
    {
      "market": "Match Winner",
      "match": "Team E vs Team F",
      "selection": "Team E",
      "confidence": 68
    }
  ]
}
`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.6,
      max_tokens: 400,
    });

    const raw = completion.choices[0].message.content;
    const data = JSON.parse(raw);

    res.json(data);
  } catch (err) {
    console.error("Bet of the week error:", err);
    res.status(500).json({ error: "Failed to generate bet of the week" });
  }
});

module.exports = router;
