require('dotenv').config();

const config = require('./config');
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');

// ── Startup credential check ─────────────────────────────────────────────────
const missingKeys = ['IBM_API_KEY', 'IBM_PROJECT_ID'].filter(k => !config[k]);
if (missingKeys.length) {
  console.error('[STARTUP ERROR] Missing required environment variables:', missingKeys.join(', '));
  console.error('  Create a .env file (see .env.example) or set them in your deployment environment.');
  process.exit(1);
}

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── IBM IAM Token cache ───────────────────────────────────────────────────────
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
    {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 15000,
    }
  );

  cachedToken = response.data.access_token;
  // Refresh 5 minutes before actual expiry
  tokenExpiry = now + (response.data.expires_in - 300) * 1000;
  return cachedToken;
}

// ── POST /api/travel — main AI endpoint ──────────────────────────────────────
app.post('/api/travel', async (req, res) => {
  const { message, history } = req.body;

  if (!message || typeof message !== 'string' || message.trim() === '') {
    return res.status(400).json({ error: 'Please enter a travel question.' });
  }

  if (message.length > 4000) {
    return res.status(400).json({ error: 'Message is too long. Please shorten your question.' });
  }

  try {
    const token = await getIBMToken();

    // Build conversation context from history
    let conversationContext = '';
    if (Array.isArray(history) && history.length > 0) {
      conversationContext = history
        .slice(-6)
        .map(h => `User: ${h.user}\nAssistant: ${h.assistant}`)
        .join('\n\n');
      conversationContext += '\n\n';
    }

    const systemPrompt = `You are Yatra, a reliable and friendly India travel planning assistant.

IMPORTANT RULES:
1. Answer the user's travel question clearly and completely.
2. For simple questions (e.g. best time to visit, food, transport), give a concise, well-structured answer — no itinerary required.
3. If the user asks for N days, provide exactly N days (Day 1, Day 2, ... Day N). Never stop early.
4. For itineraries, always use this exact structure:
   **Day 1: [Short title]**
   - Morning: ...
   - Afternoon: ...
   - Evening: ...

   **Day 2: [Short title]**
   ...and so on for every requested day.
5. Never invent specific hotel names, restaurant names, exact prices, opening hours, transport schedules, or real-time information.
6. If you are uncertain about a fact, say "Please verify this before travelling."
7. Use clear headings (**bold**) and bullet points for readability.
8. Never produce garbled, repetitive, or incomplete text. End each response cleanly.
9. Keep recommendations practical and realistic.
10. Include approximate budget only when useful; clearly label it as an estimate.
11. Use Indian currency (₹) when discussing costs.
12. Focus on India travel. If a question is not about India travel, politely redirect.
13. Maintain context from earlier in the conversation for follow-up questions.
14. Do not claim any information is real-time or officially verified.`;

    const fullPrompt = `${systemPrompt}

${conversationContext}User: ${message.trim()}
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
      timeout: 60000,
    });

    const generated = response.data?.results?.[0]?.generated_text?.trim() || '';

    if (!generated) {
      console.warn('[WARN] Granite returned empty generated_text. Full response:', JSON.stringify(response.data));
      return res.status(500).json({ error: 'The AI returned an empty response. Please try again.' });
    }

    res.json({ reply: generated });

  } catch (err) {
    // Detailed diagnostic logging — NEVER logs the API key or token
    const status  = err?.response?.status;
    const ibmCode = err?.response?.data?.errors?.[0]?.code || err?.response?.data?.error || '';
    const ibmMsg  = err?.response?.data?.errors?.[0]?.message
                 || err?.response?.data?.errorMessage
                 || err?.response?.data?.message
                 || '';

    if (status === 400 && ibmMsg.includes('disabled')) {
      console.error(`[ERROR] IBM API key is DISABLED. Renew it in IBM Cloud → Manage → Access → API keys.`);
      return res.status(503).json({ error: 'The AI service credentials have expired. Please contact the administrator.' });
    }

    if (status === 401 || status === 403) {
      // Token expired mid-flight — force refresh next request
      cachedToken = null;
      tokenExpiry = 0;
      console.error(`[ERROR] IBM auth failed (HTTP ${status}). Token cache cleared for retry.`);
      return res.status(503).json({ error: 'AI authentication failed. Please try again in a moment.' });
    }

    if (status === 429) {
  console.error(
    '[IBM 429]',
    JSON.stringify(err?.response?.data || {}, null, 2)
  );

  return res.status(429).json({
    error: 'IBM temporarily rejected the request. Please try again shortly.'
  });
}
    if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') {
      console.error('[ERROR] IBM API request timed out.');
      return res.status(504).json({ error: 'The AI took too long to respond. Please try again.' });
    }

    // Generic fallback — log safely
    console.error(`[ERROR] IBM API call failed — HTTP ${status || 'N/A'} | code: ${ibmCode} | message: ${ibmMsg} | js: ${err.message}`);
    res.status(500).json({ error: 'Failed to get a response from the AI. Please try again.' });
  }
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', model: config.IBM_MODEL_ID });
});

// ── Serve frontend ────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start server ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌏 Yatra — India Travel Agent running on http://0.0.0.0:${PORT}`);
  console.log(`   Model : ${config.IBM_MODEL_ID}`);
  console.log(`   Health: http://localhost:${PORT}/health`);
});
