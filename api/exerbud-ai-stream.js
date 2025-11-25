// /api/exerbud-ai-stream.js

import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Basic CORS helper for Vercel Node
function applyCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

// Make sure history is well-formed & trimmed
function sanitizeHistory(rawHistory) {
  if (!Array.isArray(rawHistory)) return [];

  const allowedRoles = new Set(["user", "assistant", "system"]);

  return rawHistory
    .map((m) => {
      const role = allowedRoles.has(m.role) ? m.role : "user";
      const content =
        typeof m.content === "string" && m.content.trim()
          ? m.content
          : "";
      return { role, content };
    })
    .filter((m) => m.content)
    .slice(-20);
}

// Build system prompt with coach flavour + formatting rules
function buildSystemPrompt(coachProfile) {
  let coachFlavor = "";

  switch (coachProfile) {
    case "strength":
      coachFlavor =
        "You are a strength-focused coach. Prioritize compound lifts, progressive overload, and clear structure. ";
      break;
    case "hypertrophy":
      coachFlavor =
        "You are a hypertrophy-focused coach. Emphasize training volume, mind-muscle connection, and muscle growth. ";
      break;
    case "mobility":
      coachFlavor =
        "You are a mobility-focused coach. Emphasize range of motion, control, warm-ups, and never push through sharp pain. ";
      break;
    case "fat_loss":
      coachFlavor =
        "You are a fat-loss-focused coach. Emphasize sustainable activity, simple nutrition guidance, and habit building. Avoid extreme dieting. ";
      break;
    default:
      coachFlavor =
        "You are a balanced strength-and-general-fitness coach. ";
  }

  return `
You are Exerbud, a friendly, expert fitness coach embedded in a website chat widget.

${coachFlavor}

Your job:
- Ask a few focused follow-up questions when needed.
- Give specific, realistic, actionable workout guidance.
- Stay within your lane: do NOT diagnose injuries or medical conditions. For serious pain, dizziness, heart issues, eating disorders, or other health risks, clearly recommend they see a qualified medical professional.

Formatting rules (VERY IMPORTANT):
- ALWAYS use real newline characters (\n) to separate sentences and items.
- Never run everything into one long line.
- When you list questions, put each question on its own line.
- For numbered lists, each item MUST start on its own line, e.g.:
  1. First item
  2. Second item
  3. Third item
- For bullet lists, use "-" and put each bullet on its own line.
- Keep paragraphs short (1–3 sentences) with blank lines between paragraphs.
- Do NOT use markdown headings like "#", "##", etc. Simple text + line breaks is enough.
`.trim();
}

export default async function handler(req, res) {
  applyCors(res);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "Missing OPENAI_API_KEY" });
  }

  try {
    const body = req.body || {};
    const userMessage = (body.message || "").toString();
    const rawHistory = body.history || [];
    const coachProfile = body.coachProfile || "strength";

    if (!userMessage.trim()) {
      return res.status(400).json({ error: "Missing message" });
    }

    const history = sanitizeHistory(rawHistory);

    const messages = [
      {
        role: "system",
        content: buildSystemPrompt(coachProfile),
      },
      ...history,
      {
        role: "user",
        content: userMessage,
      },
    ];

    // SSE headers
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");

    // In some runtimes this helps flush headers
    if (typeof res.flushHeaders === "function") {
      res.flushHeaders();
    } else {
      res.write("\n");
    }

    const stream = await client.chat.completions.create({
      model: process.env.EXERBUD_MODEL || "gpt-4.1-mini",
      messages,
      temperature: 0.6,
      max_tokens: 900,
      stream: true,
    });

    for await (const delta of stream) {
      const piece = delta.choices?.[0]?.delta?.content ?? "";
      if (!piece) continue;

      // Convert escaped "\n" to real newline characters, just in case
      let text = piece.replace(/\\n/g, "\n");

      // Emit plain text chunk to match frontend expectations: "data: <text>\n\n"
      res.write(`data: ${text}\n\n`);
    }

    // Signal completion
    res.write("data: [DONE]\n\n");
    res.end();
  } catch (err) {
    console.error("Exerbud stream error:", err);
    // Try to send an SSE error message if headers already sent
    try {
      res.write(
        "data: Sorry, something went wrong while generating your workout. Please try again.\n\n"
      );
      res.write("data: [DONE]\n\n");
      res.end();
    } catch {
      if (!res.headersSent) {
        res
          .status(500)
          .json({ error: "Streaming error", details: String(err?.message || err) });
      }
    }
  }
}
