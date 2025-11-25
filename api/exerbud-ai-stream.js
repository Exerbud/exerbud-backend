// api/exerbud-ai-stream.js
//
// Exerbud AI – SSE Streaming Endpoint
// -------------------------------------
// Produces REAL streaming responses using Server-Sent Events (SSE).
// Mirrors the logic of /api/exerbud-ai.js, but returns tokens as they arrive.
//

const { webSearch } = require("./utils/web-search");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const DEFAULT_MODEL = process.env.EXERBUD_MODEL || "gpt-4.1-mini";
const MAX_HISTORY_MESSAGES = 20;
const MAX_SEARCH_CONTEXT_CHARS = 8000;
const MAX_ATTACHMENTS = 8;

// ---------------------------------------------------------------------------
// Coach profiles
// ---------------------------------------------------------------------------
const COACH_PROFILES = {
  strength: {
    name: "Strength Coach",
    style: `
You specialize in strength training and progressive overload.
- Focus on compound lifts, measurable progress, and consistent technique.
- You care about long-term joint health as much as numbers on the bar.
- You prefer clear cues and simple, repeatable programming.
`.trim()
  },
  hypertrophy: {
    name: "Hypertrophy Coach",
    style: `
You specialize in muscle growth and physique-focused training.
- Focus on volume landmarks, proximity to failure, and exercise selection.
- You think in terms of muscle groups, tension, and mind–muscle connection.
- You use straightforward language that avoids overcomplication.
`.trim()
  },
  mobility: {
    name: "Mobility Specialist",
    style: `
You specialize in mobility, flexibility, and joint health.
- Focus on controlled range of motion, breathing, and posture.
- Include warm-up, cooldown, and simple daily movement habits.
- Prioritize pain-free movement and regressions over forcing range of motion.
`.trim()
  },
  fat_loss: {
    name: "Fat Loss Coach",
    style: `
You specialize in safe, sustainable fat loss.
- Focus on energy expenditure, consistency, and building habits that are actually doable.
- Use circuits, step targets, and time-efficient sessions when needed.
- Emphasize mindset, adherence, and realistic timeframes rather than crash approaches.
`.trim()
  }
};

// ---------------------------------------------------------------------------
// Lazy-load OpenAI client
// ---------------------------------------------------------------------------
async function getOpenAIClient() {
  const OpenAI = (await import("openai")).default;
  return new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
  });
}

// ---------------------------------------------------------------------------
// Utility: basic attachment summary
// ---------------------------------------------------------------------------
function summarizeAttachments(attachments) {
  if (!Array.isArray(attachments) || !attachments.length) return "";

  const limited = attachments.slice(0, MAX_ATTACHMENTS);
  const parts = limited.map((file, idx) => {
    const kind = file.type || "file";
    const sizeKb = file.size ? Math.round(file.size / 1024) : null;
    const sizeLabel = sizeKb ? `${sizeKb}KB` : "unknown size";
    return `  - [${idx + 1}] ${file.name || "unnamed"} (${kind}, ${sizeLabel})`;
  });

  let note = "The user attached the following files:\n" + parts.join("\n");

  if (attachments.length > MAX_ATTACHMENTS) {
    note += `\n  - (There are ${attachments.length - MAX_ATTACHMENTS} more files not listed here.)`;
  }

  note +=
    "\n\nIf you need to reference a file, mention it by index (e.g. 'in file #1').";
  return note;
}

// ---------------------------------------------------------------------------
// Build system prompt
// ---------------------------------------------------------------------------
function buildExerbudSystemPrompt(extraContext, coachProfileKey) {
  const coach =
    coachProfileKey && COACH_PROFILES[coachProfileKey]
      ? COACH_PROFILES[coachProfileKey]
      : null;

  let base = `
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
- Visually analyze user-uploaded photos (form, equipment, gym layout, etc.) to give practical feedback.
- When multiple images are provided, you can compare them and describe differences in form, posture, body position, or environment.
- With help from the Exerbud app, export the latest workout plan as a downloadable PDF whenever the user asks.

Limits & safety:
- Do NOT diagnose injuries or medical issues and never prescribe drugs.
- Do not estimate bodyfat percentage, diagnosis, or medical risk.
- If something sounds medically serious, tell the user to talk to a qualified professional.
- Be explicit when you are making reasonable assumptions.
- IMPORTANT: Do NOT say you are unable to create or send files or PDFs. When the user asks to export or download their plan, simply describe the plan clearly; the Exerbud app can handle exporting and downloading plans for the user.

Output style:
- Start with 1–2 short sentences reflecting what you understood.
- Use short paragraphs (1–3 sentences) with a blank line between paragraphs — avoid giant walls of text.
- When asking the user multiple questions, format them as a bulleted list (lines starting with "- ").
- When giving a workout plan, use clear headings (e.g. "Week 1", "Day 1 – Upper") and bullet points for exercises and notes.
- End with 2–4 clear "Next steps" so the user knows exactly what to do.
- Whenever you provide a full, structured workout plan, end with:
  "If you’d like, I can also turn this into a downloadable PDF — just say “export this as a PDF.”"
`.trim();

  if (coach) {
    base += `

You are currently operating as a ${coach.name}.
Adopt this coaching style:
${coach.style}
`;
  } else {
    base += `

If the user hasn't chosen a coach profile, use a balanced generalist style.
`;
  }

  if (!extraContext) return base;

  return (
    base +
    "\n\nAdditional live web context:\n" +
    extraContext +
    "\n\n(Reference this info as coming from live search, not memory.)"
  );
}

// ---------------------------------------------------------------------------
// Should we run web search?
// ---------------------------------------------------------------------------
function shouldUseSearch(message) {
  if (!message) return false;
  const lower = message.toLowerCase();

  if (
    lower.includes("find a gym") ||
    lower.includes("gyms near me") ||
    lower.includes("find personal trainer") ||
    lower.includes("personal trainers near me")
  ) {
    return true;
  }

  if (
    lower.includes("near me") ||
    lower.includes("closest") ||
    lower.includes("best gym") ||
    lower.includes("open now")
  ) {
    return true;
  }

  if (
    lower.includes("latest research") ||
    lower.includes("study on") ||
    lower.includes("recent guidelines")
  ) {
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Build message history for OpenAI
// ---------------------------------------------------------------------------
async function buildMessages({
  userMessage,
  history,
  attachments,
  enableSearch,
  coachProfile
}) {
  const trimmedHistory = Array.isArray(history)
    ? history.slice(-MAX_HISTORY_MESSAGES)
    : [];

  let webContext = "";
  if (enableSearch && shouldUseSearch(userMessage)) {
    try {
      const results = await webSearch(userMessage);
      if (results && results.length) {
        const joined = results
          .map(
            (r, idx) =>
              `Result ${idx + 1}: ${r.title}\n${r.snippet}\n${r.link}\n`
          )
          .join("\n");

        webContext =
          joined.length > MAX_SEARCH_CONTEXT_CHARS
            ? joined.slice(0, MAX_SEARCH_CONTEXT_CHARS) +
              "\n\n(Truncated search results.)"
            : joined;
      }
    } catch (err) {
      console.error("Web search error:", err);
    }
  }

  let attachmentNote = "";
  if (attachments && attachments.length) {
    attachmentNote = summarizeAttachments(attachments);
  }

  const systemText = buildExerbudSystemPrompt(
    webContext,
    coachProfile || null
  );

  const messages = [
    {
      role: "system",
      content: systemText
    }
  ];

  if (attachmentNote) {
    messages.push({
      role: "system",
      content: attachmentNote
    });
  }

  trimmedHistory.forEach(msg => {
    if (!msg || !msg.role || !msg.content) return;
    const r = msg.role === "assistant" ? "assistant" : "user";
    messages.push({
      role: r,
      content: msg.content
    });
  });

  messages.push({
    role: "user",
    content: userMessage
  });

  return messages;
}

// ---------------------------------------------------------------------------
// Streaming handler
// ---------------------------------------------------------------------------
async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Content-Type", "application/json");
    res.statusCode = 405;
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  try {
    const body = await new Promise((resolve, reject) => {
      let data = "";
      req.on("data", chunk => {
        data += chunk.toString();
      });
      req.on("end", () => {
        try {
          resolve(JSON.parse(data || "{}"));
        } catch (err) {
          reject(err);
        }
      });
      req.on("error", reject);
    });

    const {
      message,
      history,
      attachments,
      enableSearch = true,
      coachProfile = null
    } = body || {};

    if (!message && !(attachments && attachments.length)) {
      res.setHeader("Content-Type", "application/json");
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "Missing message." }));
      return;
    }

    const client = await getOpenAIClient();
    const messages = await buildMessages({
      userMessage: message || "",
      history: history || [],
      attachments: attachments || [],
      enableSearch,
      coachProfile
    });

    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    function sendChunk(text) {
      if (!text) return;
      res.write(`data:${text}\n\n`);
    }

    const stream = await client.chat.completions.create({
      model: DEFAULT_MODEL,
      messages,
      temperature: 0.4,
      max_tokens: 1200,
      stream: true
    });

    let fullText = "";

    for await (const chunk of stream) {
      const delta =
        chunk.choices?.[0]?.delta?.content ??
        chunk.choices?.[0]?.delta?.text ??
        "";
      if (!delta) continue;
      fullText += delta;
      sendChunk(delta);
    }

    res.write("data:[DONE]\n\n");
    res.end();
  } catch (err) {
    console.error("Exerbud SSE handler error:", err);
    if (!res.headersSent) {
      res.setHeader("Content-Type", "application/json");
      res.statusCode = 500;
      res.end(
        JSON.stringify({
          error: "Exerbud streaming error",
          details: err?.message || String(err)
        })
      );
    } else {
      try {
        res.write(
          `data:${"⚠️ Streaming error from Exerbud. Please try again."}\n\n`
        );
        res.write("data:[DONE]\n\n");
        res.end();
      } catch (_) {
        // ignore
      }
    }
  }
}

module.exports = handler;
