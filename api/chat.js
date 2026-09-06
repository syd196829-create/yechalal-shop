// api/chat.js
//
// This is a Vercel Serverless Function — it runs on Vercel (the same place
// that already hosts your index.html), so you do NOT need Cloudflare,
// a new account, or anything extra. It safely holds your Groq API key on
// the server side, away from anyone viewing your site's source code.
//
// HOW TO SET THIS UP (from your phone, using the GitHub repo you already have)
//
// 1. In your GitHub repo (the one with index.html), create a new folder
//    called exactly:  api
//    Inside that folder, create a new file called exactly:  chat.js
//    (So the full path is:  api/chat.js )
//
// 2. Paste this ENTIRE file's content into that new api/chat.js file.
//    Commit it (same way you added worker.js earlier).
//
// 3. Go to vercel.com on your phone, sign in to your existing account
//    (whichever way you signed in when you first set up your site).
//
// 4. Open your project (the one serving index.html). Vercel will notice
//    the new api/chat.js file automatically on the next deploy — you
//    usually don't have to do anything else, it redeploys itself whenever
//    you commit to GitHub.
//
// 5. In your Vercel project, go to "Settings" -> "Environment Variables".
//    Add a new one:
//      Name:  GROQ_API_KEY
//      Value: (paste the gsk_... key you got from console.groq.com)
//    Save, then trigger a redeploy (Vercel usually does this by itself
//    when you save an environment variable, or you can just push any
//    small change to GitHub again to force it).
//
// 6. Your endpoint will now be live at:
//      https://<your-site>.vercel.app/api/chat
//    (Use your actual Vercel domain — the same one your site already
//    uses, e.g. https://yechalal-shop.vercel.app/api/chat )
//
// 7. Back in index.html, find the line that says:
//      const AI_WORKER_URL = 'https://YOUR-WORKER-SUBDOMAIN.workers.dev/chat';
//    and replace it with your real Vercel URL, e.g.:
//      const AI_WORKER_URL = 'https://yechalal-shop.vercel.app/api/chat';
//
// That's it — no Cloudflare, no second account, no clipboard headaches.

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

    const payload = {
      model: "llama-3.1-8b-instant",
      messages: [
        {
          role: "system",
          content:
            "You are the helpful AI Assistant inside the Yechalal Shop app. Be friendly, concise, and helpful. Keep answers short unless the user asks for detail.",
        },
        ...messages,
      ],
      max_tokens: 400,
    };

    const aiResp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify(payload),
    });

    if (!aiResp.ok) {
      const errText = await aiResp.text();
      return res.status(502).json({ error: "AI provider error", detail: errText });
    }

    const data = await aiResp.json();
    const reply =
      data.choices?.[0]?.message?.content?.trim() ||
      "Sorry, I don't have an answer for that.";

    return res.status(200).json({ reply });
  } catch (err) {
    return res.status(500).json({ error: "Server error", detail: String(err) });
  }
}
