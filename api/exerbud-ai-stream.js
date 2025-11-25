// api/exerbud-ai-stream.js
//
// Exerbud AI – SSE Streaming Endpoint
// -------------------------------------
// This endpoint produces REAL streaming responses using Server-Sent Events (SSE).
// It mirrors the logic of /api/exerbud-ai.js but returns tokens as they arrive.
// Safe to run alongside your existing non-streaming endpoint.
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
You specialize in strength and performance.
- Focus on progressive overload, compound lifts, and sound technique.
- Prefer clear, direct programming with sets, reps, RPE/effort guidance, and rest times.
- Emphasize tracking progress over time and realistic expectations for load increases.
`.trim()
  },
  hypertrophy: {
    name: "Hypertrophy Coach",
    style: `
You specialize in muscle growth and aesthetics.
- Emphasize adequate weekly volume per muscle group, controlled tempo, and mind–muscle connection.
- Use techniques like supersets, straight sets, and higher rep ranges where appropriate.
- Care about symmetry and balanced development, not just chasing max weight.
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
// Lazy-load OpenAI client (required for openai@4.x in CJS)
// ---------------------------------------------------------------------------
async function getOpenAIClient() {
  const OpenAI = (await import("openai")).default;
  return new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
  });
}

// ---------------------------------------------------------------------------
// Build System Prompt (same as main endpoint)
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
- With help from the Exerbud app, export the latest workout plan as a downloadable PDF whenever the user asks.

Limits & safety:
- Do NOT diagnose injuries or medical issues and never prescribe drugs.
- If something sounds medically serious, tell the user to talk to a qualified professional.
- Be explicit when you are making reasonable assumptions.
- IMPORTANT: Do NOT say you are unable to create or send files or PDFs. The Exerbud app can handle exporting and downloading plans for the user.

Output style:
- Start with 1–2 sentences reflecting what you understood.
- Then give structured guidance with headings and bullet points.
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
  return (
    lower.includes("near me") ||
    lower.includes("find a gym") ||
    lower.includes("personal trainer") ||
    lower.includes("search") ||
    lower.startsWith("find ")
  );
}

// ---------------------------------------------------------------------------
// Automatic User Profile Summary (Option A)
// ---------------------------------------------------------------------------
async function buildUserProfileSummary(client, historyMessages) {
  if (!historyMessages || historyMessages.length === 0) return null;

  try {
    const convoText = historyMessages
      .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
      .join("\n\n")
      .slice(0, 8000);

    const messages = [
      {
        role: "system",
        content: `
You are a fitness coach assistant that extracts a compact user fitness profile from the conversation so far.

Your job:
- Summarize ONLY what the user has clearly stated about:
  - Training experience (beginner/intermediate/advanced, or unknown)
  - Main goals (strength, hypertrophy, fat loss, performance, health, etc.)
  - Weekly schedule and constraints (how many days, time limits, lifestyle)
  - Equipment available (gym access, home equipment, specific tools)
  - Injury or medical considerations (ONLY if explicitly mentioned)
  - Strong preferences (e.g. hates running, loves heavy lifting, etc.)
- Do NOT invent or guess details that were not clearly stated.

Output format:
- A short paragraph (max 120 words) in natural language.
- If something is unknown, just omit it instead of guessing.
`.trim()
      },
      {
        role: "user",
        content: convoText
      }
    ];

    const completion = await client.chat.completions.create({
      model: DEFAULT_MODEL,
      messages,
      temperature: 0,
      max_tokens: 220,
    });

    const summary = completion.choices?.[0]?.message?.content?.trim();
    if (!summary) return null;
    return summary;
  } catch (err) {
    console.error("User profile summary (stream) error:", err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// SSE streaming endpoint
// ---------------------------------------------------------------------------
module.exports = async (req, res) => {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Parse body
  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch (err) {
      return res.status(400).json({ error: "Invalid JSON" });
    }
  }

  const userMessage = (body.message || "").trim();
  const history = Array.isArray(body.history) ? body.history : [];
  const attachments = Array.isArray(body.attachments) ? body.attachments : [];
  const coachProfile =
    typeof body.coachProfile === "string" ? body.coachProfile : null;

  if (!userMessage && attachments.length === 0) {
    return res.status(400).json({ error: "Missing 'message'." });
  }

  // -------------------------------------------------------------------------
  // Web Search
  // -------------------------------------------------------------------------
  let extraSearchContext = "";
  if (body.enableSearch !== false && shouldUseSearch(userMessage)) {
    try {
      const searchResults = await webSearch(userMessage);
      if (Array.isArray(searchResults)) {
        const trimmed = searchResults.slice(0, 5);
        const serialized = JSON.stringify(trimmed, null, 2);
        extraSearchContext = serialized.slice(0, MAX_SEARCH_CONTEXT_CHARS);
      }
    } catch (err) {
      console.error("Search error (stream):", err);
    }
  }

  // -------------------------------------------------------------------------
  // Build Chat Messages (same as main endpoint)
  // -------------------------------------------------------------------------
  const systemPrompt = buildExerbudSystemPrompt(
    extraSearchContext || undefined,
    coachProfile
  );

  const historyMessages = history
    .filter((h) => h?.content)
    .slice(-MAX_HISTORY_MESSAGES)
    .map((h) => ({
      role: h.role === "assistant" ? "assistant" : "user",
      content: h.content,
    }));

  // Vision attachments → convert into message objects
  const imageMessages = [];
  const attachmentNoteParts = [];

  const limited = attachments.slice(0, MAX_ATTACHMENTS);

  for (const att of limited) {
    const name = att?.name || "file";
    const mime = att?.type || "";
    const sizeKb = att?.size ? Math.round(att.size / 1024) : null;

    attachmentNoteParts.push(
      `- ${name} (${mime}${sizeKb ? `, ~${sizeKb} KB` : ""})`
    );

    if (mime.startsWith("image/")) {
      const dataUrl = `data:${mime};base64,${att.data}`;
      imageMessages.push({
        role: "user",
        content: [
          {
            type: "text",
            text: `User uploaded an image (${name}). Use it as context.`,
          },
          {
            type: "image_url",
            image_url: { url: dataUrl },
          },
        ],
      });
    }
  }

  let attachmentNote = "";
  if (attachmentNoteParts.length > 0) {
    attachmentNote =
      "The user uploaded these files:\n" + attachmentNoteParts.join("\n");
  }

  const client = await getOpenAIClient();
  const userProfileSummary = await buildUserProfileSummary(client, historyMessages);

  const messages = [{ role: "system", content: systemPrompt }];

  if (userProfileSummary) {
    messages.push({
      role: "system",
      content:
        "User profile summary based on the conversation so far (use this to keep recommendations consistent, and do NOT invent missing details):\n" +
        userProfileSummary,
    });
  }

  if (historyMessages.length > 0) {
    messages.push(...historyMessages);
  }

  if (attachmentNote) {
    messages.push({ role: "system", content: attachmentNote });
  }

  if (imageMessages.length > 0) {
    messages.push(...imageMessages);
  }

  const lastUserContent =
    userMessage ||
    "The user sent attachments without text. Use them for your reply.";
  messages.push({ role: "user", content: lastUserContent });

  // -------------------------------------------------------------------------
  // Start SSE Response
  // -------------------------------------------------------------------------
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });

  // Helper to send SSE chunks:
  function sendChunk(token) {
    res.write(`data: ${token}\n\n`);
  }

  function endStream() {
    res.write(`data: [DONE]\n\n`);
    res.end();
  }

  // -------------------------------------------------------------------------
  // OpenAI Streaming
  // -------------------------------------------------------------------------
  try {
    const stream = await client.chat.completions.create({
      model: DEFAULT_MODEL,
      messages,
      temperature: 0.7,
      max_tokens: 900,
      stream: true,
    });

    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;

      const token = delta.content || "";
      if (token) sendChunk(token);
    }

    endStream();
  } catch (err) {
    console.error("Streaming error:", err);
    sendChunk("⚠️ Streaming error occurred.");
    endStream();
  }
};
