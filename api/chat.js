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

    // System / persona instructions
    const systemInstructionText =
      "Your name is 'የመዳም ቅመም ነኝ'. You are a general-purpose AI assistant available inside the Yechalal Shop app, " +
      "similar to a full AI assistant like ChatGPT or Claude — you can help with absolutely anything the user asks: " +
      "general knowledge, science, history, technology, coding, health, education, translation, advice, writing, " +
      "math, current events, or any other topic — not only shopping or the Yechalal Shop app. You can also create " +
      "images, banners, logos, and pictures when asked. Always respond " +
      "primarily in Amharic unless the user writes in another language. Be friendly, clear, and thorough. Never " +
      "refer to yourself as 'Yechalal Shop' or any other name — your name is always 'የመዳም ቅመም ነኝ'. When greeting " +
      "the user or introducing yourself, always say your name is 'የመዳም ቅመም ነኝ'. If asked your name, answer with " +
      "'የመዳም ቅመም ነኝ'.";

    // Choose model: vision-capable model if an image is attached, otherwise the fast text model
    const model = hasImage ? 'gemini-3.6-flash' : 'gemini-3.6-flash';

    // Detect if the user is asking the assistant to CREATE/GENERATE an image or banner
    // (as opposed to just chatting or analyzing an uploaded photo).
    const lastUserMsg = [...messages].reverse().find((m) => m.role !== 'assistant');
    const lastUserText = String(lastUserMsg?.content || '');
    const imageGenTriggers = /(ባነር|ፎቶ\s*(ስራ|ፍጠር|ስራልኝ|አዘጋጅ)|ስዕል\s*(ሳል|ስራ|ፍጠር)|ሎጎ\s*(ስራ|ፍጠር)|banner|generate\s+(an?\s+)?(image|photo|picture)|create\s+(an?\s+)?(image|photo|picture|banner|logo)|draw\s+(an?|me)|design\s+(a\s+)?banner|make\s+(an?\s+)?(image|banner|logo|poster))/i;
    const wantsImageGeneration = !hasImage && imageGenTriggers.test(lastUserText);

    // Convert incoming chat-style messages (role: 'user'|'assistant', content: string)
    // into Gemini's "contents" format (role: 'user'|'model', parts: [{text}])
    const contents = messages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: String(m.content || '') }]
    }));

    // If an image was sent, attach it as inline_data to the LAST user message
    if (hasImage) {
      // image expected as a data URL: "data:image/jpeg;base64,XXXXX"
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

    // ---- Image generation path (banners, logos, pictures) ----
    if (wantsImageGeneration) {
      const imageModel = 'gemini-2.5-flash-image';
      const imgUrl = `https://generativelanguage.googleapis.com/v1beta/models/${imageModel}:generateContent?key=${GEMINI_API_KEY}`;
      const imgResp = await fetch(imgUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: lastUserText }] }],
          generationConfig: { temperature: 0.8, responseModalities: ['IMAGE', 'TEXT'] }
        })
      });
      const imgData = await imgResp.json();

      if (!imgResp.ok) {
        console.error('GEMINI IMAGE ERROR STATUS:', imgResp.status);
        console.error('GEMINI IMAGE ERROR BODY:', JSON.stringify(imgData));
        return res.status(502).json({ error: 'AI image provider error', details: imgData });
      }

      const parts = imgData?.candidates?.[0]?.content?.parts || [];
      let imageDataUrl = null;
      let captionText = '';
      for (const p of parts) {
        if (p.inlineData?.data) {
          const mt = p.inlineData.mimeType || 'image/png';
          imageDataUrl = `data:${mt};base64,${p.inlineData.data}`;
        } else if (p.text) {
          captionText += p.text;
        }
      }

      if (!imageDataUrl) {
        return res.status(200).json({
          reply: captionText || 'ይቅርታ፣ ምስል መፍጠር አልቻልኩም። እባክህ ጥያቄህን በድጋሚ ግለጽልኝ።'
        });
      }

      return res.status(200).json({
        reply: captionText || 'ይሄው ፈጠርኩልህ! 🎨',
        image: imageDataUrl
      });
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
          maxOutputTokens: 2048
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
