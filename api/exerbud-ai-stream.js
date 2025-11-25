// api/exerbud-ai-stream.js
//
// Exerbud AI – SSE Streaming Endpoint (Vision 2.0 + Weekly Planner + Coach Profiles)
//
// Frontend sends POST JSON:
// {
//   message: "<user_text>",
//   history: [...],
//   attachments: [...],
//   enableSearch: true/false,
//   coachProfile: "strength" | "hypertrophy" | "mobility" | "fat_loss" | null
// }
//
// This endpoint returns Server-Sent Events (SSE) with tokens:
//   data: <token>\n\n
// and finishes with:
//   data: [DONE]\n\n
//

const { webSearch } = require("./utils/web-search");

// ---------------------------------------------------------------------------
// Disable default body parsing so we can read raw body (required for SSE)
// ---------------------------------------------------------------------------
module.exports.config = {
  api: {
    bodyParser: false,
  },
};

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
`.trim(),
  },
  hypertrophy: {
    name: "Hypertrophy Coach",
    style: `
You specialize in muscle growth and aesthetics.
- Emphasize adequate weekly volume per muscle group, controlled tempo, and mind–muscle connection.
- Use techniques like straight sets, supersets, and moderate-to-high rep ranges where appropriate.
- Care about symmetry and balanced development, not just chasing max weight.
`.trim(),
  },
  mobility: {
    name: "Mobility Specialist",
    style: `
You specialize in mobility, flexibility, and joint health.
- Focus on controlled range of motion, breathing, and posture.
- Include warm-up, cooldown, and simple daily movement habits.
- Prioritize pain-free movement and regressions over forcing range of motion.
`.trim(),
  },
  fat_loss: {
    name: "Fat Loss Coach",
    style: `
You specialize in safe, sustainable fat loss.
- Focus on energy expenditure, consistency, and building habits that are actually doable.
- Use circuits, step targets, and time-efficient sessions when needed.
- Emphasize mindset, adherence, and realistic timeframes rather than crash approaches.
`.trim(),
  },
};

// ---------------------------------------------------------------------------
// Lazy-load OpenAI client (ESM package)
// ---------------------------------------------------------------------------
async function getOpenAIClient() {
  const OpenAI = (await import("openai")).default;
  return new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });
}

// ---------------------------------------------------------------------------
// Raw body reader for Vercel
// ---------------------------------------------------------------------------
function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => resolve(data));
    req.on("error", (err) => reject(err));
  });
}

// ---------------------------------------------------------------------------
// System prompt builder
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
- IMPORTANT: Do NOT say you are unable to create or send files or PDFs. The Exerbud app can handle exporting and downloading plans for the user.
- EQUALLY IMPORTANT: Do NOT claim that you are *currently* exporting, sending, or downloading a PDF file (for example, avoid phrases like "I’m sending the PDF now" or "you can download it right away"). Instead, clearly tell the user that IF they ask to export the plan as a PDF, the Exerbud app will handle the download on their side.

Output style:
- Start with 1–2 sentences reflecting what you understood.
- Then give structured guidance with headings and bullet points.
- End with 2–4 clear "Next steps" so the user knows exactly what to do.
- Whenever you provide a full, structured workout plan (multi-day program or detailed template), end with a short line such as:
  "If you’d like, I can also turn this into a downloadable PDF — just say something like “export this as a PDF.”"
`.trim();

  if (coach) {
    base += `

You are currently operating as a ${coach.name}.
Adopt this coaching style:
${coach.style}
`;
  } else {
    base += `

If the user hasn't explicitly chosen a coach profile, use a balanced generalist style that blends strength, hypertrophy, and overall health.
`;
  }

  if (!extraContext) return base;

  return (
    base +
    "\n\n" +
    "Additional live context from a recent web search (treat as external info, not absolute truth):\n" +
    extraContext +
    "\n\nWhen you reference specific places or facts from this block, make it clear you are basing it on recent web search results, not your own memory. " +
    "Because this block exists, do NOT say you can't browse the internet—instead, say you looked this up via recent web results."
  );
}

// ---------------------------------------------------------------------------
// Heuristics: search & weekly planner
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

function isWeeklyPlannerRequest(message) {
  if (!message) return false;
  const lower = message.toLowerCase();

  if (
    lower.includes("weekly routine") ||
    lower.includes("weekly plan") ||
    lower.includes("weekly program") ||
    lower.includes("weekly planner") ||
    lower.includes("week by week") ||
    lower.includes("week-by-week")
  ) {
    return true;
  }

  const weekPattern = /\b([2-9]|10|12)\s*[- ]?\s*week(s)?\b/;
  if (weekPattern.test(lower)) return true;

  return false;
}

// ---------------------------------------------------------------------------
// Lightweight “user profile” summary from history
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
`.trim(),
      },
      {
        role: "user",
        content: convoText,
      },
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
// SSE helpers
// ---------------------------------------------------------------------------
function writeSSEChunk(res, token) {
  res.write(`data: ${token}\n\n`);
}

function endSSE(res) {
  res.write(`data: [DONE]\n\n`);
  res.end();
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

  // ------------------- Parse JSON body safely -------------------
  let raw;
  try {
    raw = await getRawBody(req);
  } catch (err) {
    console.error("Error reading raw body:", err);
    return res.status(400).json({ error: "Could not read request body" });
  }

  let body;
  try {
    body = JSON.parse(raw || "{}");
  } catch (err) {
    console.error("JSON parse error (stream):", err);
    return res.status(400).json({ error: "Invalid JSON" });
  }

  const userMessage = (body.message || "").trim();
  const history = Array.isArray(body.history) ? body.history : [];
  const attachments = Array.isArray(body.attachments) ? body.attachments : [];
  const coachProfile =
    typeof body.coachProfile === "string" ? body.coachProfile : null;

  if (!userMessage && attachments.length === 0) {
    return res.status(400).json({ error: "Missing 'message'." });
  }

  const weeklyPlannerRequested = isWeeklyPlannerRequest(userMessage);

  // ------------------- Optional web search -------------------
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

  // ------------------- History prep -------------------
  const historyMessages = history
    .filter((h) => h && h.content)
    .slice(-MAX_HISTORY_MESSAGES)
    .map((h) => ({
      role: h.role === "assistant" ? "assistant" : "user",
      content: h.content,
    }));

  // ------------------- Attachment processing -------------------
  const visionImages = [];
  const nonImageAttachmentLines = [];
  const limitedAttachments = attachments.slice(0, MAX_ATTACHMENTS);

  for (let i = 0; i < limitedAttachments.length; i++) {
    const att = limitedAttachments[i];
    if (!att) continue;

    const name = att.name || `file-${i + 1}`;
    const mime = att.type || "unknown";
    const sizeKb = att.size ? Math.round(att.size / 1024) : null;

    if (mime.startsWith("image/") && att.data) {
      const dataUrl = `data:${mime};base64,${att.data}`;
      visionImages.push({ name, imageUrl: dataUrl });
    } else {
      nonImageAttachmentLines.push(
        `- ${name} (${mime}${sizeKb ? `, ~${sizeKb} KB` : ""})`
      );
    }
  }

  let attachmentNote = "";
  if (nonImageAttachmentLines.length > 0) {
    attachmentNote =
      "The user also uploaded these non-image files. You CANNOT see their content directly, but you may infer from the rest of the conversation when helpful:\n" +
      nonImageAttachmentLines.join("\n");
  }

  let visionMessage = null;
  if (visionImages.length > 0) {
    visionMessage = {
      role: "user",
      content: [
        {
          type: "text",
          text:
            `The user has uploaded ${visionImages.length} fitness-related image(s). ` +
            `Treat them as photos or still frames of exercises, body positions, or gym/home environments. ` +
            `Your job is to:\n` +
            `1) Describe what you see in each image (exercise, angle, stance, posture, visible equipment, environment).\n` +
            `2) Provide detailed but supportive coaching feedback on form, setup, and positioning.\n` +
            `3) Suggest 2–4 concrete cues the user can try next time (for example: "brace before you descend", "slow the eccentric", "keep ribs stacked over pelvis").\n` +
            `4) If there are multiple images, compare them: mention improvements, regressions, changes in depth, knee travel, torso angle, bar path, or equipment/room differences.\n\n` +
            `Guardrails:\n` +
            `- Do NOT diagnose injuries or medical conditions.\n` +
            `- Do NOT estimate body fat percentage or make aesthetic judgements.\n` +
            `- Stay focused on performance, movement quality, and safety.\n` +
            `- Use encouraging, non-shaming language.\n` +
            `You can refer to them as "image 1", "image 2", etc. in the order they were provided.`,
        },
        ...visionImages.map((img) => ({
          type: "image_url",
          image_url: { url: img.imageUrl },
        })),
      ],
    };
  }

  const lastUserContent =
    userMessage ||
    "The user sent attachments without text. Use them for your reply.";

  // ------------------- Start SSE response -------------------
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });

  // ------------------- OpenAI streaming inside try/catch -------------------
  try {
    const client = await getOpenAIClient();

    const userProfileSummary = await buildUserProfileSummary(
      client,
      historyMessages
    );

    const systemPrompt = buildExerbudSystemPrompt(
      extraSearchContext || undefined,
      coachProfile
    );

    const messages = [{ role: "system", content: systemPrompt }];

    if (userProfileSummary) {
      messages.push({
        role: "system",
        content:
          "User profile summary based on the conversation so far (use this to keep recommendations consistent, and do NOT invent missing details):\n" +
          userProfileSummary,
      });
    }

    if (weeklyPlannerRequested) {
      messages.push({
        role: "system",
        content: `
The user is explicitly asking for a structured weekly training plan or multi-week calendar.
When this is true, you MUST:

- Build a clear plan organized by week and day.
- Use headings like "Week 1", "Week 2", etc.
- Inside each week, list training days in order with labels like "Mon", "Tue", "Wed" OR "Day 1", "Day 2" depending on what makes most sense.
- Keep the total number of weekly sessions consistent with what the user can realistically do (from their profile and messages).
- Include brief notes on progression across weeks (load, reps, difficulty, or volume) and when to deload.
- Keep formatting clean and simple so it can be exported to a PDF or typed into a calendar.
`.trim(),
      });
    }

    if (historyMessages.length > 0) {
      messages.push(...historyMessages);
    }

    if (attachmentNote) {
      messages.push({ role: "system", content: attachmentNote });
    }

    if (visionMessage) {
      messages.push(visionMessage);
    }

    messages.push({ role: "user", content: lastUserContent });

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
      if (token) {
        writeSSEChunk(res, token);
      }
    }

    endSSE(res);
  } catch (err) {
    console.error("Streaming error:", err);
    writeSSEChunk(
      res,
      "⚠️ Something went wrong while generating this reply. Please try again in a moment."
    );
    endSSE(res);
  }
};

