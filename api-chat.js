// api/chat.js
// Vercel Serverless Function — backend for Yechalal Shop's AI Assistant.
// Holds the Groq API key safely (via the GROQ_API_KEY environment
// variable in Vercel's project settings) instead of exposing it in
// index.html. The app calls this endpoint at /api/chat.

export default async function handler(req, res) {
  // Allow the browser to call this from your site.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Use POST" });
  }

  try {
    const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];

    // If any message includes an image, switch to a vision-capable model —
    // the plain text model can't see photos at all.
    const hasImage = messages.some(
      (m) => Array.isArray(m.content) && m.content.some((c) => c.type === "image_url")
    );

    // Try a short list of models in order — Groq occasionally renames or
    // retires "preview" models, so if the first choice fails we
    // automatically retry with the next one instead of just erroring out.
    const modelsToTry = hasImage
      ? ["llama-3.2-11b-vision-preview", "llama-3.2-90b-vision-preview"]
      : ["llama-3.1-8b-instant", "llama-3.3-70b-versatile", "gemma2-9b-it"];

    let lastErrText = "";
    for (const model of modelsToTry) {
      const payload = {
        model,
        messages: [
          {
            role: "system",
            content:
              "You are the helpful AI Assistant inside the Yechalal Shop app. Be friendly, concise, and helpful. Keep answers short unless the user asks for detail. If the user sends a photo, describe what you see and answer their question about it.",
          },
          ...messages,
        ],
        max_tokens: 500,
      };

      const aiResp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        },
        body: JSON.stringify(payload),
      });

      if (aiResp.ok) {
        const data = await aiResp.json();
        const reply =
          data.choices?.[0]?.message?.content?.trim() ||
          "Sorry, I don't have an answer for that.";
        return res.status(200).json({ reply, modelUsed: model });
      }

      lastErrText = await aiResp.text();
      // If it's specifically a bad/retired model name, try the next one.
      // For any other error (bad key, rate limit, etc.), stop and report it.
      if (!/model/i.test(lastErrText)) break;
    }

    return res.status(502).json({ error: "AI provider error", detail: lastErrText });
  } catch (err) {
    return res.status(500).json({ error: "Server error", detail: String(err) });
  }
}
