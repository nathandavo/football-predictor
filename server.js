require("dotenv").config();
const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const OpenAI = require("openai");

// --------------------------
// ROUTES
// --------------------------
const authRoutes = require("./routes/auth");
const fixtureRoutes = require("./routes/fixtures");
const predictionRoutes = require("./routes/prediction");

const app = express();
app.use(cors());
app.use(express.json());

// --------------------------
// CONNECT TO MONGO
// --------------------------
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB connected"))
  .catch((err) => console.error("❌ Mongo error:", err));

// --------------------------
// OPENAI CLIENT
// --------------------------
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// --------------------------
// TEST HOME ROUTE
// --------------------------
app.get("/", (req, res) => {
  res.send("⚽ Football Predictor API is running!");
});

// --------------------------
// AUTH ROUTES (register / login)
// --------------------------
app.use("/auth", authRoutes);

// --------------------------
// FIXTURE ROUTES
// --------------------------
app.use("/fixtures", fixtureRoutes);

// --------------------------
// PREDICTION ROUTES
// --------------------------
app.use("/predict", predictionRoutes);

// --------------------------
// CHAT ENDPOINT (optional)
// --------------------------
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

// --------------------------
// STRIPE PAYMENT ENDPOINT
// --------------------------
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

app.post("/payment", async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      line_items: [
        {
          price: process.env.STRIPE_PRICE_ID, // Render environment variable
          quantity: 1,
        },
      ],
      success_url: `${process.env.APP_URL}/success`,
      cancel_url: `${process.env.APP_URL}/cancel`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("Stripe error:", err);
    res.status(500).json({ error: "Failed to create Stripe session" });
  }
});

// --------------------------
// START SERVER
// --------------------------
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
