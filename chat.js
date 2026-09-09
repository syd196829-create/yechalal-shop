// api/chat.js
// Yechalal Shop AI Assistant — Groq backend

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Use POST"
    });
  }

  if (!process.env.GROQ_API_KEY) {
    return res.status(500).json({
      error: "GROQ_API_KEY is not configured in Vercel."
    });
  }

  try {
    const messages = Array.isArray(req.body?.messages)
      ? req.body.messages
      : [];

    if (messages.length === 0) {
      return res.status(400).json({
        error: "No messages provided."
      });
    }

    // Check whether the conversation contains an image
    const hasImage = messages.some(
      (m) =>
        Array.isArray(m.content) &&
        m.content.some(
          (c) => c && c.type === "image_url"
        )
    );

    // Current Groq models
    // Text: GPT-OSS 20B
    // Image + text: Qwen 3.6 27B
    const model = hasImage
      ? "qwen/qwen3.6-27b"
      : "openai/gpt-oss-20b";

    const systemMessage = {
      role: "system",
      content:
        "You are the AI Assistant inside Yechalal Shop. " +
        "Be helpful, friendly, accurate and concise. " +
        "You can communicate in Amharic, English and other languages. " +
        "If the user sends an image, carefully analyze it and answer questions about it. " +
        "Do not claim to see something that is not visible in the image."
    };

    const payload = {
      model,
      messages: [
        systemMessage,
        ...messages
      ],
      temperature: 0.5,
      max_completion_tokens: 1024
    };

    const aiResp = await fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`
        },
        body: JSON.stringify(payload)
      }
    );

    const data = await aiResp.json();

    if (!aiResp.ok) {
      console.error("Groq API error:", data);

      return res.status(aiResp.status).json({
        error: "AI provider error",
        detail: data?.error?.message || "Groq request failed."
      });
    }

    const reply =
      data?.choices?.[0]?.message?.content?.trim() ||
      "ይቅርታ፣ መልስ ማመንጨት አልቻልኩም።";

    return res.status(200).json({
      reply,
      modelUsed: model
    });

  } catch (error) {
    console.error("Server error:", error);

    return res.status(500).json({
      error: "Server error",
      detail: error?.message || String(error)
    });
  }
}
