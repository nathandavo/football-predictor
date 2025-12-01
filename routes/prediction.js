const express = require("express");
const OpenAI = require("openai");
const router = express.Router();

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

router.post("/", async (req, res) => {
  try {
    const { homeTeam, awayTeam } = req.body;

    if (!homeTeam || !awayTeam) {
      return res.status(400).json({ error: "homeTeam and awayTeam are required." });
    }

    const prompt = `
      Predict the result of the upcoming Premier League match:
      - Home team: ${homeTeam}
      - Away team: ${awayTeam}

      Give me:
      1. Predicted scoreline (e.g., 2-1)
      2. Likely winner
      3. A short explanation (2 sentences)
      
      Respond ONLY in JSON:
      {
        "prediction": "2-1",
        "winner": "Home/Away/Draw",
        "explanation": "..."
      }
    `;

    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You predict football matches." },
        { role: "user", content: prompt }
      ]
    });

    const text = completion.choices[0].message.content;

    const jsonStart = text.indexOf("{");
    const jsonEnd = text.lastIndexOf("}");
    const cleanJson = text.substring(jsonStart, jsonEnd + 1);

    const responseJson = JSON.parse(cleanJson);

    res.json(responseJson);

  } catch (error) {
    console.error("Prediction Error:", error);
    res.status(500).json({
      error: "Failed to generate prediction",
      details: error.message
    });
  }
});

module.exports = router;
