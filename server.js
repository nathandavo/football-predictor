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
          price: process.env.STRIPE_PRICE_ID, // Stripe Price ID from your env
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
// STRIPE WEBHOOK ENDPOINT
// --------------------------
app.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.log("Webhook signature verification failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Handle the event
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      console.log("✅ Payment completed:", session);
      // Here you can update user premium status in your DB
      // e.g., find user by session.client_reference_id and set isPremium = true
    }

    res.json({ received: true });
  }
);

// --------------------------
// START SERVER
// --------------------------
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
