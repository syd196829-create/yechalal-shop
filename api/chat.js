export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { messages, image } = req.body || {};

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'messages array is required' });
    }

    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_API_KEY) {
      return res.status(500).json({ error: 'Server misconfiguration: missing GEMINI_API_KEY' });
    }

    const hasImage = !!image;

    const systemInstructionText =
      "Your name is 'የመዳም ቅመም ነኝ'. You are a helpful AI assistant inside the Yechalal Shop app, " +
      "an Amharic-language social commerce platform. Always respond primarily in Amharic unless the user " +
      "writes in another language. Be friendly, concise, and helpful. If asked your name, answer with " +
      "'የመዳም ቅመም ነኝ'.";

    const model = hasImage ? 'gemini-2.0-flash' : 'gemini-2.0-flash';

    const contents = messages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: String(m.content || '') }]
    }));

    if (hasImage) {
      const match = /^data:(image\/[a-zA-Z]+);base64,(.+)$/.exec(image);
      if (match) {
        const mimeType = match[1];
        const base64Data = match[2];
        let lastUserIdx = -1;
        for (let i = contents.length - 1; i >= 0; i--) {
          if (contents[i].role === 'user') { lastUserIdx = i; break; }
        }
        if (lastUserIdx >= 0) {
          contents[lastUserIdx].parts.push({
            inline_data: { mime_type: mimeType, data: base64Data }
          });
        }
      }
    }

    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;

    const geminiResp = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: {
          parts: [{ text: systemInstructionText }]
        },
        contents,
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 1024
        }
      })
    });

    const geminiData = await geminiResp.json();

    if (!geminiResp.ok) {
      console.error('GEMINI ERROR STATUS:', geminiResp.status);
      console.error('GEMINI ERROR BODY:', JSON.stringify(geminiData));
      return res.status(502).json({
        error: 'AI provider error',
        details: geminiData
      });
    }

    const replyText =
      geminiData?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') ||
      'ይቅርታ፣ መልስ ማምጣት አልቻልኩም።';

    return res.status(200).json({
      reply: replyText,
      raw: undefined
    });
  } catch (err) {
    console.error('CHAT.JS CAUGHT ERROR:', err);
    return res.status(500).json({
      error: 'Internal server error',
      message: err?.message || String(err)
    });
  }
}
