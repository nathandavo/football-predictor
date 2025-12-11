const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const fetch = require("node-fetch");
const OpenAI = require("openai");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Simple helper: score a prediction to pick best one
function scorePrediction(pred) {
  const winMax = Math.max(pred.winChances.home, pred.winChances.away);
  const score = winMax * 1.5 + pred.bttsPct * 0.5;
  return score;
}

router.post("/weekly", auth, async (req, res) => {
  try {
    if (!req.user.isPremium) {
      return res.status(403).json({ error: "Premium Only" });
    }

    const fixtures = req.body.fixtures;
    if (!fixtures || fixtures.length === 0) {
      return res.status(400).json({ error: "No fixtures provided" });
    }

    let best = null;
    let bestScore = -1;

    for (const f of fixtures) {
      const prompt = `
Predict:
${f.home} vs ${f.away}

Return ONLY JSON:
{
  "score": "2-1",
  "winChances": { "home": %, "draw": %, "away": % },
  "bttsPct": %
}`;

      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 200,
        temperature: 0.7,
      });

      let raw = completion.choices[0].message.content.trim();
      let pred;

      try {
        pred = JSON.parse(raw);
      } catch {
        continue;
      }

      const sc = scorePrediction(pred);

      if (sc > bestScore) {
        bestScore = sc;
        best = { ...pred, fixture: f };
      }
    }

    if (!best) {
      return res.status(500).json({ error: "Failed to generate best bet" });
    }

    res.json(best);

  } catch (err) {
    console.log("BET OF WEEK ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
