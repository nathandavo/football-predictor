require("dotenv").config();
const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const OpenAI = require("openai");

// ROUTES
const authRoutes = require("./routes/auth");
const fixtureRoutes = require("./routes/fixtures");
const predictionRoutes = require("./routes/prediction");
const stripeRoutes = require("./routes/stripe"); // ✅ add stripe routes

const app = express();
app.use(cors());
app.use(express.json());

// MONGO
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB connected"))
  .catch((err) => console.error("❌ Mongo error:", err));

// OPENAI
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// TEST
app.get("/", (req, res) => res.send("⚽ Football Predictor API is running!"));

// ROUTES
app.use("/auth", authRoutes);
app.use("/fixtures", fixtureRoutes);
app.use("/predict", predictionRoutes);
app.use("/stripe", stripeRoutes); // ✅ mount stripe routes

// CHAT endpoint (unchanged)
app.post("/chat", async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: "Message required" });

    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: message },
      ],
    });

    res.json({ reply: completion.choices[0].message.content });
  } catch (error) {
    console.error("Chat error:", error);
    res.status(500).json({ error: "Chat endpoint failed" });
  }
});

// START SERVER
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
