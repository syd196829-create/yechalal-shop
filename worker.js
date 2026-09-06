// ai-worker.js
// Cloudflare Worker — the "backend" for Yechalal Shop's AI Assistant.
// Uses Groq's API, which has a genuinely free tier — no credit card
// required to sign up or use it, only an email address.
//
// WHY THIS FILE EXISTS
// The AI provider's secret API key must NEVER be written inside index.html —
// anyone who views your site's source could copy it and use it. This tiny
// Worker holds the key safely on Cloudflare's servers instead, and your app
// only ever talks to THIS Worker, never directly to Groq.
//
// HOW TO GET A FREE GROQ API KEY (from your phone, no card needed)
// 1. Go to https://console.groq.com on your phone's browser.
// 2. Sign up with your email (or Google account) — no card, no payment.
// 3. Once logged in, go to "API Keys" in the left menu -> "Create API Key".
// 4. Copy the key it gives you (starts with "gsk_...") — you'll paste it
//    into Cloudflare in step 6 below.
//
// HOW TO DEPLOY THIS WORKER (from your phone, no computer needed)
// 1. Go to https://dash.cloudflare.com on your phone's browser and sign up
//    (free plan is enough).
// 2. In the sidebar, go to "Workers & Pages" -> "Create" -> "Create Worker".
// 3. Give it a name, e.g. "yechalal-ai-proxy". Deploy the default template
//    first so the Worker exists, then open it and go to "Edit code".
// 4. Delete everything in the editor and paste in this ENTIRE file.
// 5. Click "Save and deploy".
// 6. Go to the Worker's "Settings" -> "Variables" -> "Environment Variables"
//    -> "Add variable". Add one called GROQ_API_KEY, paste the gsk_... key
//    from step 4 above as the value, and click "Encrypt" so it's stored as
//    a secret. Save.
// 7. Your Worker's URL will look like:
//    https://yechalal-ai-proxy.<your-subdomain>.workers.dev
//    Copy that URL.
// 8. Back in index.html, find the line that says:
//      const AI_WORKER_URL = 'https://YOUR-WORKER-SUBDOMAIN.workers.dev/chat';
//    and replace it with your real URL + "/chat" at the end, e.g.:
//      const AI_WORKER_URL = 'https://yechalal-ai-proxy.said100.workers.dev/chat';
//
// That's it — completely free, no card, no computer required.

export default {
  async fetch(request, env) {
    // Allow the browser to call this Worker from your site (CORS).
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*", // you can restrict this to your exact domain later
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (request.method !== "POST") {
      return new Response(JSON.stringify({ error: "Use POST" }), {
        status: 405,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    try {
      const body = await request.json();
      const messages = Array.isArray(body.messages) ? body.messages : [];

      // Groq's free tier includes fast open models like Llama 3.1 — this
      // one is a good balance of quality and speed for a chat assistant.
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
          Authorization: `Bearer ${env.GROQ_API_KEY}`,
        },
        body: JSON.stringify(payload),
      });

      if (!aiResp.ok) {
        const errText = await aiResp.text();
        return new Response(
          JSON.stringify({ error: "AI provider error", detail: errText }),
          { status: 502, headers: { "Content-Type": "application/json", ...corsHeaders } }
        );
      }

      const data = await aiResp.json();
      const reply = data.choices?.[0]?.message?.content?.trim() || "Sorry, I don't have an answer for that.";

      return new Response(JSON.stringify({ reply }), {
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: "Worker error", detail: String(err) }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }
  },
};
