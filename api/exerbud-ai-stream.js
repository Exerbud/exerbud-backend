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
You specialize in strength and performance.
- Focus on progressive overload, compound lifts, and sound technique.
- Prefer clear, direct programming with sets, reps, RPE/effort guidance, and rest times.
- Emphasize tracking progress over time and realistic expectations for load increases.
`,
  },
  hypertrophy: {
    name: "Hypertrophy Coach",
    style: `
You specialize in muscle growth (hypertrophy).
- Focus on adequate volume, controlled tempo, and good mind-muscle connection.
- Use a mix of compound and isolation lifts, with thoughtful exercise order.
- Emphasize training close to failure but sustainably—no ego lifting.
`,
  },
  mobility: {
    name: "Mobility Coach",
    style: `
You specialize in mobility, joint resilience, and movement quality.
- Focus on controlled range of motion, positional strength, and breathing.
- Prioritize warm-ups, activation drills, and post-session mobility work.
- Emphasize long-term joint health, especially for people who sit a lot or feel stiff.
`,
  },
  fat_loss: {
    name: "Fat Loss Coach",
    style: `
You specialize in sustainable fat loss and metabolic health.
- Emphasize realistic training volume, daily movement, and manageable intensity.
- Avoid "shred in 2 weeks" nonsense—focus on adherence and longevity.
- Encourage strength training as the base, with smart conditioning layered in.
`,
  },
};

// ---------------------------------------------------------------------------
// Lazy-load OpenAI client
// ---------------------------------------------------------------------------
async function getOpenAIClient() {
  const OpenAI = (await import("openai")).default;
  return new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });
}

// ---------------------------------------------------------------------------
// Build System Prompt
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
- IMPORTANT: Do NOT say you are unable to create or send files or PDFs.
  Instead, say that the Exerbud app can handle exporting and downloading plans for the user.

Output style:
- Start with 1–2 sentences reflecting what you understood.
- Then give structured guidance with headings and bullet points.
- End with 2–4 clear "Next steps" so the user knows exactly what to do.
- Whenever you provide a full, structured workout plan (multi-day program or detailed template), end with a short line such as:
  "If you’d like to export this as a PDF, you can use the export options in your Exerbud interface."

User interaction:
- Ask clarifying questions if crucial details are missing (e.g., equipment, injuries, days per week).
- But if the user wants to get going quickly, make reasonable assumptions and clearly state them.
- You are not here to impress them with complexity; you're here to make their training easier to understand and follow.
`;

  if (coach) {
    base += `
You are currently acting in this specific coaching persona:

"${coach.name}" style:
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
// Automatic User Profile Summary
//  - Summarizes key factors from recent history
// ---------------------------------------------------------------------------
async function buildUserProfileSummary(client, historyMessages) {
  if (!historyMessages || historyMessages.length === 0) return null;

  const prompt = `
You are helping Exerbud summarize the user's training profile based on messages.
From the conversation so far, summarize:

- Current training level (beginner / intermediate / advanced).
- Main goal(s) (strength, hypertrophy, fat loss, performance, etc.).
- Any injuries, pain, or limitations they mentioned.
- Available equipment and typical training environment (gym, home, travel, etc.).
- Weekly time availability (sessions per week, session length, scheduling constraints).
- Notable preferences (e.g., hates running, likes machines, prefers shorter sessions).
- Any major lifestyle or stress factors that impact training (long commutes, shift work, kids, etc.).

Keep it short (3–7 bullet points), factual, and do NOT invent details.

Conversation (most recent messages last):

${historyMessages
  .map(
    (m) =>
      `${m.role === "assistant" ? "Coach" : "User"}: ${m.content || ""}`
  )
  .join("\n")}
`.trim();

  try {
    const resp = await client.chat.completions.create({
      model: DEFAULT_MODEL,
      messages: [
        { role: "system", content: "You summarize fitness conversations." },
        { role: "user", content: prompt },
      ],
      temperature: 0.2,
      max_tokens: 300,
    });

    const summary = resp.choices?.[0]?.message?.content?.trim();
    return summary || null;
  } catch (err) {
    console.error("Error building user profile summary:", err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Detect weekly planner style requests
// ---------------------------------------------------------------------------
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
// Main handler – SSE streaming
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
      return res.status(400).json({ error: "Invalid JSON in request body" });
    }
  }

  const userMessage =
    typeof body.message === "string" ? body.message.trim() : "";
  const history = Array.isArray(body.history) ? body.history : [];
  const attachments = Array.isArray(body.attachments)
    ? body.attachments
    : [];
  const coachProfile =
    typeof body.coachProfile === "string" ? body.coachProfile : null;

  if (!userMessage && attachments.length === 0) {
    return res.status(400).json({ error: "Missing 'message'." });
  }

  const weeklyPlannerRequested = isWeeklyPlannerRequest(userMessage);

  // -------------------------------------------------------------------------
  // Web Search
  // -------------------------------------------------------------------------
  let extraSearchContext = "";
  const enableSearch =
    typeof body.enableSearch === "boolean" ? body.enableSearch : false;

  if (enableSearch && shouldUseSearch(userMessage)) {
    try {
      const searchResults = await webSearch(userMessage);
      if (searchResults && searchResults.length > 0) {
        const lines = searchResults.map((r, idx) => {
          const linkLine =
            r.link && r.link.startsWith("http")
              ? `URL: ${r.link}`
              : "";
          return `Result ${idx + 1}: ${r.title || "Untitled"}\n${r.snippet || ""}\n${linkLine}`;
        });
        const combined = lines.join("\n\n");
        extraSearchContext = combined.slice(0, MAX_SEARCH_CONTEXT_CHARS);
      }
    } catch (err) {
      console.error("Search error (stream):", err);
    }
  }

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

  const client = await getOpenAIClient();

  // ---------- Automatic User Profile Summary ----------
  const userProfileSummary = await buildUserProfileSummary(
    client,
    historyMessages
  );

  // ---------- Attachments: Vision 2.0 + notes ----------
  const visionImages = [];
  const nonImageAttachmentLines = [];
  const limited = attachments.slice(0, MAX_ATTACHMENTS);

  for (let i = 0; i < limited.length; i++) {
    const att = limited[i];
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
      "The user also uploaded these non-image files. You CANNOT read their exact contents directly, but you may infer from the rest of the conversation when helpful:\n" +
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
            `3) Suggest 2–4 concrete cues the user can try next session (e.g., "push the floor away", "brace before you descend", "control the eccentric", "keep ribs stacked over pelvis").\n` +
            `4) If there are multiple images, compare them: mention differences in joint angles, depth, head/neck position, barbell or dumbbell path, or equipment/room differences.\n\n` +
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
