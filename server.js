const config = require('./config');
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// IBM IAM Token cache
let cachedToken = null;
let tokenExpiry = 0;

async function getIBMToken() {
  const now = Date.now();
  if (cachedToken && now < tokenExpiry) return cachedToken;

  const response = await axios.post(
    'https://iam.cloud.ibm.com/identity/token',
    new URLSearchParams({
      grant_type: 'urn:ibm:params:oauth:grant-type:apikey',
      apikey: config.IBM_API_KEY,
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );

  cachedToken = response.data.access_token;
  // Expire 5 minutes before actual expiry
  tokenExpiry = now + (response.data.expires_in - 300) * 1000;
  return cachedToken;
}

// POST /api/travel — main AI endpoint
app.post('/api/travel', async (req, res) => {
  const { message, history } = req.body;

  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'message is required' });
  }

  try {
    const token = await getIBMToken();

    // Build conversation context from history
    let conversationContext = '';
    if (history && Array.isArray(history) && history.length > 0) {
      conversationContext = history
        .slice(-6) // keep last 6 exchanges for context
        .map(h => `User: ${h.user}\nAssistant: ${h.assistant}`)
        .join('\n\n');
      conversationContext += '\n\n';
    }

    const systemPrompt = `You are Yatra, a reliable India travel planning assistant.

IMPORTANT RULES:
1. Answer only the user's travel question — nothing more, nothing less.
2. If the user asks for N days, provide exactly N days (e.g. Day 1, Day 2, Day 3). Never stop early.
3. Never invent hotels, restaurants, prices, opening hours, transport schedules, or historical facts.
4. If you are uncertain about a fact, clearly say it should be verified before travel.
5. Use clear headings, bullet points, and short paragraphs.
6. Never produce garbled, repetitive, or nonsensical text. Stop cleanly when done.
7. Do not continue beyond what the user requested.
8. For itineraries, always use this structure:
   Day 1: [Title]
   Day 2: [Title]
   Day 3: [Title]
   ... (one section per day, no days skipped)
9. Keep recommendations practical and realistic.
10. Include approximate budget only when useful; label it clearly as an estimate.
11. Prioritise useful travel information: places to visit, suggested order, transportation, food, approximate time needed, and travel tips.
12. Do not claim any information is real-time or verified.
13. Keep the response concise but complete.
14. Use Indian currency (₹) when discussing budgets for Indian travel.
15. Do not generate fictional names or details just to make the response longer.
16. If the question is not about travel in India, politely redirect to India travel planning.`;

    const fullPrompt = `${systemPrompt}

${conversationContext}User: ${message}
Assistant:`;

    const payload = {
      model_id: config.IBM_MODEL_ID,
      project_id: config.IBM_PROJECT_ID,
      input: fullPrompt,
      parameters: {
        decoding_method: 'greedy',
        max_new_tokens: 1200,
        min_new_tokens: 20,
        stop_sequences: ['\nUser:', '\n\nUser:'],
        repetition_penalty: 1.1,
      },
    };

    const response = await axios.post(config.IBM_URL, payload, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });

    const generated = response.data?.results?.[0]?.generated_text?.trim() || '';
    res.json({ reply: generated });
  } catch (err) {
    console.error('IBM API error:', err?.response?.data || err.message);
    res.status(500).json({
      error: 'Failed to get response from AI. Please try again.',
    });
  }
});

// Serve frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = config.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌏 India Travel Agent running at http://localhost:${PORT}`);
});
