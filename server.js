// server.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const OpenAI = require("openai");

const app = express();
app.use(cors());
app.use(express.json());

// --------------------------
// CONNECT TO MONGO
// --------------------------
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB connected"))
  .catch((err) => console.log("Mongo error:", err));

// --------------------------
// USER MODEL
// --------------------------
const UserSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
});

const User = mongoose.model("User", UserSchema);

// --------------------------
// REGISTER ROUTE
// --------------------------
app.post("/register", async (req, res) => {
  const { email, password } = req.body;

  const existing = await User.findOne({ email });
  if (existing)
    return res.status(400).json({ error: "Email already exists" });

  const hashedPassword = await bcrypt.hash(password, 10);

  const user = new User({ email, password: hashedPassword });
  await user.save();

  res.json({ message: "User registered successfully" });
});

// --------------------------
// LOGIN ROUTE
// --------------------------
app.post("/login", async (req, res) => {
  const { email, password } = req.body;

  const user = await User.findOne({ email });
  if (!user)
    return res.status(400).json({ error: "Invalid email or password" });

  const valid = await bcrypt.compare(password, user.password);
  if (!valid)
    return res.status(400).json({ error: "Invalid email or password" });

  res.json({ message: "Login successful", userId: user._id });
});

// --------------------------
// OPENAI ENDPOINT
// --------------------------
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.post("/chat", async (req, res) => {
  try {
    const { message } = req.body;

    if (!message)
      return res.status(400).json({ error: "Message is required" });

    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: message }
      ],
    });

    res.json({ reply: completion.choices[0].message.content });
  } catch (err) {
    console.log("OpenAI error:", err);
    res.status(500).json({ error: "Something went wrong" });
  }
});

// --------------------------
// START SERVER
// --------------------------
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on ${PORT}`));



// ------------ START SERVER ------------
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

