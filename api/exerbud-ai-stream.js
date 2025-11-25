// api/exerbud-ai-stream.js
//
// Exerbud AI – SSE Streaming Endpoint
// -------------------------------------
// Produces REAL streaming responses using Server-Sent Events (SSE).
// Mirrors the logic of /api/exerbud-ai.js, but returns tokens as they arrive.
//

const OpenAI = require("openai");
const { webSearch } = require("./utils/web-search");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const DEFAULT_MODEL = process.env.EXERBUD_MODEL || "gpt-4.1-mini";
const MAX_HISTORY_MESSAGES = 20;
const MAX_SEARCH_CONTEXT_CHARS = 8000;
const MAX_ATTACHMENT_NOTE_CHARS = 1200;

// Vision / attachment constraints (also enforced client-side)
const MAX_IMAGE_ATTACHMENTS = 4;
const MAX_TOTAL_ATTACHMENT_BYTES = 8 * 1024 * 1024; // 8MB

// ---------------------------------------------------------------------------
// Helper: basic CORS headers (adjust origin if you want to lock it down)
// ---------------------------------------------------------------------------
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

// ---------------------------------------------------------------------------
// OpenAI client helper
// ---------------------------------------------------------------------------
async function getOpenAIClient() {
  return new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });
}

// ---------------------------------------------------------------------------
// Simple coach profiles (lightweight "personas")
// ---------------------------------------------------------------------------
const COACH_PROFILES = {
  strength: {
    label: "Strength",
    description:
      "Focus on getting stronger in the main barbell and compound lifts with simple, progressive programming.",
  },
  hypertrophy: {
    label: "Hypertrophy",
    description:
      "Prioritize muscle growth with higher volume, a variety of rep ranges, and smart exercise selection.",
  },
  mobility: {
    label: "Mobility",
    description:
      "Emphasize joint health, range of motion, and movement quality alongside strength work.",
  },
  fat_loss: {
    label: "Fat loss",
    description:
      "Support sustainable fat loss with realistic training volume and an eye on recovery and adherence.",
  },
};

// ---------------------------------------------------------------------------
// Utility: normalize/trim conversation history
// ---------------------------------------------------------------------------
function sanitizeHistory(rawHistory) {
  if (!Array.isArray(rawHistory)) return [];

  return rawHistory
    .slice(-MAX_HISTORY_MESSAGES)
    .map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: typeof m.content === "string" ? m.content.slice(0, 4000) : "",
      timestamp: m.timestamp || Date.now(),
    }))
    .filter((m) => m.content);
}

// ---------------------------------------------------------------------------
// Utility: make a small, human-readable summary of uploaded files
// (non-images are only described here; images may also be sent to Vision)
// ---------------------------------------------------------------------------
function buildAttachmentNote(attachments) {
  if (!Array.isArray(attachments) || !attachments.length) return "";

  const parts = [];
  let totalBytes = 0;

  for (const file of attachments) {
    if (!file || !file.name) continue;
    const size = Number(file.size) || 0;
    totalBytes += size;

    const isImage =
      typeof file.type === "string" && file.type.toLowerCase().startsWith("image/");

    parts.push(
      `- ${file.name} (${isImage ? "image" : "file"}, approx ${
        size > 0 ? Math.round(size / 1024) + "KB" : "unknown size"
      })`
    );
  }

  let note = `The user has attached the following files:\n${parts.join("\n")}`;

  if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
    note +=
      "\n\nNote: Total attachment size is quite large. Focus on high-level insights rather than pixel-perfect details.";
  }

  return note.slice(0, MAX_ATTACHMENT_NOTE_CHARS);
}

// ---------------------------------------------------------------------------
// Utility: extract up to N base64 images from attachments for Vision
// ---------------------------------------------------------------------------
function extractImageInputs(attachments) {
  if (!Array.isArray(attachments)) return [];

  const imageInputs = [];
  let totalBytes = 0;

  for (const file of attachments) {
    if (imageInputs.length >= MAX_IMAGE_ATTACHMENTS) break;
    if (!file || !file.type || !file.data) continue;

    const isImage = file.type.toLowerCase().startsWith("image/");
    if (!isImage) continue;

    const size = Number(file.size) || 0;
    totalBytes += size;
    if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) break;

    imageInputs.push({
      type: "input_image",
      image_url: {
        url: `data:${file.type};base64,${file.data}`,
      },
    });
  }

  return imageInputs;
}

// ---------------------------------------------------------------------------
// Utility: optional web search (Google CSE wrapper)
// ---------------------------------------------------------------------------
async function maybeRunSearch(userMessage, enableSearch) {
  if (!enableSearch) return null;
  if (!userMessage || typeof userMessage !== "string") return null;

  const lower = userMessage.toLowerCase();

  const looksLikeSearch =
    /\b(near me|gyms?|personal trainers?|coach|best [^.?]{0,30}|review|compare|vs\.?)\b/.test(
      lower
    ) || /https?:\/\//.test(lower);

  if (!looksLikeSearch) return null;

  try {
    const results = await webSearch(userMessage);
    if (!results || !Array.isArray(results.items) || !results.items.length) return null;

    const items = results.items.slice(0, 5);

    let text = "Here are some recent web search results that may be useful:\n\n";
    for (const item of items) {
      text += `- **${item.title || "Result"}** — ${item.snippet || ""}\n  ${item.link}\n\n`;
    }

    return text.slice(0, MAX_SEARCH_CONTEXT_CHARS);
  } catch (err) {
    console.error("Exerbud web search error:", err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Extended system prompt builder
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
- IMPORTANT: Do NOT say you are unable to create or send files or PDFs — the Exerbud app can handle exporting and downloading plans for the user.

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

Active coach style:
- Name: ${coach.label}
- How this should affect your answers: ${coach.description}
`;
  }

  if (extraContext && typeof extraContext === "string") {
    base += `

Additional context from tools or system:
${extraContext}
`;
  }

  return base;
}

// ---------------------------------------------------------------------------
// Weekly planner / calendar helper – compresses recent convo
// ---------------------------------------------------------------------------
async function summarizeRecentConversationForPlanner(client, history, userMessage) {
  try {
    const recent = (history || []).slice(-10);
    const convoText = recent
      .map((m) => `${m.role === "assistant" ? "Coach" : "User"}: ${m.content}`)
      .join("\n")
      .slice(0, 6000);

    const messages = [
      {
        role: "system",
        content: `
You are helping Exerbud condense the user's recent conversation into a short summary
for a weekly workout planner. Extract only the key facts:

- Training experience and background.
- Main goals and constraints.
- Weekly availability (days, session length) if mentioned.
- Equipment access.
- Any injuries, limitations, or strong preferences.

Return 4–8 bullet points, nothing else.
      `.trim(),
      },
      {
        role: "user",
        content: convoText + "\n\nUser's latest request:\n" + (userMessage || ""),
      },
    ];

    const completion = await client.chat.completions.create({
      model: DEFAULT_MODEL,
      messages,
      temperature: 0,
      max_tokens: 220,
    });

    const summary = completion.choices?.[0]?.message?.content?.trim();
    return summary || null;
  } catch (err) {
    console.error("Planner summarization error:", err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main handler – SSE streaming
// ---------------------------------------------------------------------------
module.exports = async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(200, corsHeaders());
    res.end();
    return;
  }

  if (req.method !== "POST") {
    res.writeHead(405, {
      ...corsHeaders(),
      "Content-Type": "application/json",
    });
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  try {
    const body = await new Promise((resolve, reject) => {
      let data = "";
      req.on("data", (chunk) => (data += chunk));
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
      enableSearch,
      coachProfile,
      plannerMode,
    } = body || {};

    const userMessage = typeof message === "string" ? message.trim() : "";

    if (!userMessage && (!attachments || !attachments.length)) {
      res.writeHead(400, {
        ...corsHeaders(),
        "Content-Type": "application/json",
      });
      res.end(JSON.stringify({ error: "Empty message" }));
      return;
    }

    const sanitizedHistory = sanitizeHistory(history);

    // Build extra context: web search + attachment note
    const [searchContext] = await Promise.all([
      maybeRunSearch(userMessage, enableSearch),
    ]);
    const attachmentNote = buildAttachmentNote(attachments);
    const extraPieces = [searchContext, attachmentNote].filter(Boolean);
    const extraContext = extraPieces.length ? extraPieces.join("\n\n") : null;

    const client = await getOpenAIClient();

    // Optional: if this looks like a weekly planner request, add a compressed summary
    let plannerSummary = null;
    if (plannerMode) {
      plannerSummary = await summarizeRecentConversationForPlanner(
        client,
        sanitizedHistory,
        userMessage
      );
    }

    const systemPrompt = buildExerbudSystemPrompt(
      [extraContext, plannerSummary].filter(Boolean).join("\n\n"),
      coachProfile
    );

    const imageInputs = extractImageInputs(attachments);

    const messages = [];

    messages.push({
      role: "system",
      content: systemPrompt,
    });

    sanitizedHistory.forEach((m) => {
      messages.push({
        role: m.role,
        content: m.content,
      });
    });

    // Build the user content: text + optional vision parts
    if (imageInputs.length) {
      messages.push({
        role: "user",
        content: [
          {
            type: "text",
            text: userMessage || "The user attached images and would like your help.",
          },
          ...imageInputs,
        ],
      });
    } else {
      messages.push({
        role: "user",
        content: userMessage || "The user attached files and wants your help with them.",
      });
    }

    // Start SSE response
    res.writeHead(200, {
      ...corsHeaders(),
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });

    const stream = await client.chat.completions.create({
      model: DEFAULT_MODEL,
      messages,
      temperature: 0.6,
      max_tokens: 1400,
      stream: true,
    });

    let fullText = "";

    for await (const chunk of stream) {
      const choice = chunk.choices?.[0];
      const delta = choice?.delta?.content || "";

      if (!delta) continue;

      fullText += delta;
      // NOTE: we send the raw delta (including spaces) and let the frontend decide formatting.
      res.write(`data: ${delta}\n\n`);
    }

    res.write("data: [DONE]\n\n");
    res.end();
  } catch (err) {
    console.error("Exerbud streaming error:", err);
    if (!res.headersSent) {
      res.writeHead(500, {
        ...corsHeaders(),
        "Content-Type": "application/json",
      });
      res.end(JSON.stringify({ error: "Internal server error" }));
    } else {
      try {
        res.write(`data: [ERROR] Something went wrong on the server.\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      } catch (e) {
        // ignore
      }
    }
  }
};
