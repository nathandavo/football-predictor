import axios from 'axios';

// --- FOOTBALL BACKEND (MongoDB) ---
const FOOTBALL_BASE_URL = 'http://YOUR_FOOTBALL_API_URL'; // replace with your football backend URL
export const footballApi = axios.create({
  baseURL: FOOTBALL_BASE_URL,
  timeout: 5000,
});

// --- OPENAI BACKEND ---
const OPENAI_BASE_URL = 'http://YOUR_OPENAI_API_URL'; // replace with your OpenAI backend URL
export const openAiApi = axios.create({
  baseURL: OPENAI_BASE_URL,
  timeout: 10000,
});

// --- FOOTBALL API FUNCTIONS ---
export const loginUser = async (email, password) => {
  const response = await footballApi.post('/login', { email, password });
  return response.data;
};

export const registerUser = async (email, password) => {
  const response = await footballApi.post('/register', { email, password });
  return response.data;
};

export const getFixtures = async () => {
  const response = await footballApi.get('/fixtures');
  return response.data;
};

// --- OPENAI PREDICTION FUNCTION ---
export const getPrediction = async (match) => {
  const response = await openAiApi.post('/predict', { match });
  return response.data;
};
