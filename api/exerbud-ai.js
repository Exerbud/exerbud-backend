// api/exerbud-ai.js

const OpenAI = require("openai");
const { webSearch } = require("./utils/web-search");
const { logInfo, logError } = require("./utils/logger");

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Default model comes from env, falls back to gpt-4.1-mini
const MODEL = process.env.EXERBUD_MODEL || "gpt-4.1-mini";

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------
function buildExerbudSystemPrompt(extraContext) {
  const base = `
You are Exerbud — a realistic, no-bullshit strength and conditioning coach.

Tone:
- Direct but kind.
- Grounded and practical, no bro-science.
- Respect people's actual lives, schedules, stress, and recovery.

You can:
- Build and adjust workout plans (gym, home, travel, limited equipment).
- Suggest sustainable programming (not extreme).
- Help with exercise selection, sets/reps, weekly splits, progression, deloads.
- Interpret descriptions of gym equipment, constraints, and schedules.

Limits & safety:
- Do NOT diagnose injuries or medical issues and never prescribe drugs.
- If something sounds medically serious, tell them to talk to a qualified professional.
- Be explicit when you are making reasonable assumptions.

Output style:
- Start with 1–2 sentences reflecting what you understood.
- Then give structured guidance with headings and bullet points.
- End with 2–4 clear "Next steps" so the user knows exactly what to do.
`.trim();

  if (!extraContext) return base;

  return (
    base +
    "\n\n" +
    "Additional live context from a recent web search (treat as external info, not absolute truth):\n" +
    extraContext +
    "\n\nWhen you reference specific places or facts from this block, make it clear you're basing it on recent web search results, not your own memory."
  );
}

// Simple heuristic for when to trigger web search
function shouldUseSearch(message) {
  if (!message) return false;
  const lower = message.toLowerCase();

  return (
    lower.includes("near me") ||
    lower.includes("find a gym") ||
    lower.includes("find gym") ||
    lower.includes("yoga studio") ||
    lower.includes("class near me") ||
    lower.includes("search") ||
    lower.startsWith("find ")
  );
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------
module.exports = async (req, res) => {
  // Basic CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // ---------- Parse body ----------
  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch (err) {
      logError("exerbud_invalid_json_body", { errorMessage: err.message });
      return res.status(400).json({ error: "Invalid JSON in request body" });
    }
  }

  if (!body || typeof body !== "object") {
    return res
      .status(400)
      .json({ error: "Request body must be a JSON object" });
  }

  const userMessage = (body.message || "").trim();
  const history = Array.isArray(body.history) ? body.history : [];
  const attachments = Array.isArray(body.attachments) ? body.attachments : [];

  if (!userMessage) {
    return res.status(400).json({ error: "Missing 'message' in body" });
  }

  // Request metadata for logs
  const requestId =
    Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const startedAt = Date.now();

  logInfo("exerbud_request_received", {
    requestId,
    messagePreview: userMessage.slice(0, 120),
    historyCount: history.length,
    attachmentsCount: attachments.length,
  });

  // ---------- Convert history for chat.completions ----------
  const historyMessages = history
    .filter((h) => h && typeof h.content === "string")
    .map((h) => ({
      role: h.role === "assistant" ? "assistant" : "user",
      content: h.content,
    }));

  // ---------- Summarise attachments (names only, no raw data) ----------
  let attachmentNote = "";
  if (attachments.length > 0) {
    const lines = attachments.map((att, idx) => {
      const name = att?.name || `file-${idx + 1}`;
      const type = att?.type || "unknown";
      const sizeKb = att?.size ? Math.round(att.size / 1024) : null;
      return `- ${name} (${type}${sizeKb ? `, ~${sizeKb} KB` : ""})`;
    });

    attachmentNote =
      "The user also uploaded these files (you cannot see the image pixels or file contents directly; treat them as described context only):\n" +
      lines.join("\n");
  }

  // ---------- Optional web search ----------
  let extraSearchContext = "";
  let usedSearch = false;

  if (shouldUseSearch(userMessage)) {
    usedSearch = true;
    try {
      const results = await webSearch(userMessage);

      if (Array.isArray(results) && results.length > 0) {
        extraSearchContext =
          "Recent web search results:\n\n" +
          results
            .map(
              (r, i) =>
                `${i + 1}. ${r.title}\n${r.url}\n${r.snippet || ""}`.trim()
            )
            .join("\n\n");
      } else {
        extraSearchContext =
          "Note: A live web search was performed for this query but did not return any clearly useful results.";
      }
    } catch (err) {
      logError("exerbud_web_search_failed", {
        requestId,
        errorMessage: err.message,
      });

      extraSearchContext =
        "Note: A live web search was attempted for this query, but it failed or is not configured. Answer based on general training data instead.";
    }
  }

  const systemPrompt = buildExerbudSystemPrompt(extraSearchContext);

  // ---------- Build messages ----------
  const messages = [{ role: "system", content: systemPrompt }, ...historyMessages];

  if (attachmentNote) {
    messages.push({
      role: "system",
      content: attachmentNote,
    });
  }

  messages.push({
    role: "user",
    content: userMessage,
  });

  try {
    const completion = await client.chat.completions.create({
      model: MODEL,
      messages,
      temperature: 0.7,
      max_tokens: 900,
    });

    const reply =
      completion.choices?.[0]?.message?.content?.trim() ||
      "I’m not sure what to say yet — try asking again with a bit more detail about your training.";

    logInfo("exerbud_response_success", {
      requestId,
      durationMs: Date.now() - startedAt,
      replyLength: reply.length,
      usedSearch,
      model: MODEL,
    });

    return res.status(200).json({ reply });
  } catch (err) {
    logError("exerbud_response_error", {
      requestId,
      durationMs: Date.now() - startedAt,
      errorMessage: err.message,
      stack: err.stack,
      openaiStatus: err.status,
    });

    return res.status(500).json({
      error: "Exerbud backend failed.",
      details:
        process.env.NODE_ENV === "development"
          ? err.message || String(err)
          : undefined,
    });
  }
};
