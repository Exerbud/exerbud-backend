// api/exerbud-ai.js

const { webSearch } = require("./utils/web-search");
const PDFDocument = require("pdfkit");
const https = require("https");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const DEFAULT_MODEL = process.env.EXERBUD_MODEL || "gpt-4.1-mini";
const MAX_HISTORY_MESSAGES = 20;
const MAX_SEARCH_CONTEXT_CHARS = 8000;
const MAX_ATTACHMENTS = 8;

// Coach profiles
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
// Lazy OpenAI client (works with ESM-only openai@4 in CJS)
// ---------------------------------------------------------------------------
async function getOpenAIClient() {
  const OpenAI = (await import("openai")).default;
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

// ---------------------------------------------------------------------------
// System prompt
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
// Trigger search for certain queries
// ---------------------------------------------------------------------------
function shouldUseSearch(message) {
  if (!message) return false;
  const lower = message.toLowerCase();

  return (
    lower.includes("near me") ||
    lower.includes("find a gym") ||
    lower.includes("find gym") ||
    lower.includes("yoga studio") ||
    lower.includes("class near me") ||
    lower.includes("personal trainer") ||
    lower.includes("trainer near me") ||
    lower.includes("search") ||
    lower.startsWith("find ")
  );
}

// ---------------------------------------------------------------------------
// PDF helpers
// ---------------------------------------------------------------------------
const EXERBUD_LOGO_URL =
  "https://cdn.shopify.com/s/files/1/0731/9882/9803/files/exerbud_favicon_6093c857-65ce-4c64-8292-0597a6c6cf17.png?v=1763185899";

function fetchImageBuffer(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        const chunks = [];
        res
          .on("data", (d) => chunks.push(d))
          .on("end", () => resolve(Buffer.concat(chunks)))
          .on("error", reject);
      })
      .on("error", reject);
  });
}

/**
 * Lightly normalize markdown-ish workout text for PDF:
 * - Remove leading # / ## / ### etc.
 * - Turn "- something" into "• something".
 * - Drop '---' separators.
 * - Collapse big blank blocks.
 */
function normalizePlanTextForPdf(raw) {
  if (!raw) return "";

  const lines = raw.split(/\r?\n/);
  const out = [];
  let lastBlank = false;

  for (let line of lines) {
    let trimmed = line.trim();

    // Blank / horizontal rule
    if (!trimmed || /^-{3,}$/.test(trimmed)) {
      if (!lastBlank) {
        out.push("");
        lastBlank = true;
      }
      continue;
    }

    // Markdown headings: #, ##, ###...
    const headingMatch = trimmed.match(/^#{1,6}\s*(.+)$/);
    if (headingMatch) {
      const heading = headingMatch[1].trim();
      if (!lastBlank && out.length) out.push("");
      out.push(heading);
      out.push("");
      lastBlank = true;
      continue;
    }

    // Bullet lines: "- text"
    if (/^-+\s+/.test(trimmed)) {
      trimmed = "• " + trimmed.replace(/^-\s+/, "");
    }

    out.push(trimmed);
    lastBlank = false;
  }

  const joined = out.join("\n");
  return joined.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Generate a nicely formatted PDF for the workout plan.
 */
async function generatePlanPdf(planText, planTitle) {
  const doc = new PDFDocument({
    size: "LETTER",
    margins: { top: 64, bottom: 64, left: 64, right: 64 },
  });

  const buffers = [];
  doc.on("data", (chunk) => buffers.push(chunk));
  const pdfPromise = new Promise((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(buffers)));
    doc.on("error", reject);
  });

  // Header: logo + title
  let currentY = doc.y;

  try {
    const logoBuffer = await fetchImageBuffer(EXERBUD_LOGO_URL);
    const logoSize = 32;
    doc.image(
      logoBuffer,
      doc.page.margins.left,
      currentY,
      { width: logoSize, height: logoSize }
    );
  } catch (err) {
    console.error("Failed to fetch Exerbud logo for PDF:", err);
  }

  const cleanedTitle = (planTitle || "").trim() || "Workout Plan";

  doc
    .font("Helvetica-Bold")
    .fontSize(18)
    .text(
      cleanedTitle,
      doc.page.margins.left + 80,
      currentY + 10
    );

  doc.moveDown(1);

  const normalizedText = normalizePlanTextForPdf(planText || "");
  doc.font("Helvetica").fontSize(11);

  const availableWidth =
    doc.page.width - doc.page.margins.left - doc.page.margins.right;

  const paragraphs = (normalizedText || "")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  paragraphs.forEach((para, idx) => {
    doc.text(para, {
      width: availableWidth,
      align: "left",
      lineGap: 3,
    });

    if (idx !== paragraphs.length - 1) {
      doc.moveDown(0.7);
    }
  });

  doc.end();
  return pdfPromise;
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
      .slice(0, 8000); // safety cap

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
    console.error("User profile summary error:", err);
    return null;
  }
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

  // Parse body
  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch (err) {
      return res.status(400).json({ error: "Invalid JSON in request body" });
    }
  }

  if (!body || typeof body !== "object") {
    return res
      .status(400)
      .json({ error: "Request body must be a JSON object" });
  }

  // ---------- Dedicated PDF export mode ----------
  if (body.pdfExport) {
    const planText = body.planText || "";
    const planTitle = body.planTitle || "Exerbud workout plan";

    try {
      const pdfBuffer = await generatePlanPdf(planText, planTitle);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        'attachment; filename="exerbud-workout-plan.pdf"'
      );
      return res.status(200).send(pdfBuffer);
    } catch (err) {
      console.error("PDF generation error:", err);
      return res.status(500).json({
        error: "Failed to generate PDF.",
        details:
          process.env.NODE_ENV === "development"
            ? err.message || String(err)
            : undefined,
      });
    }
  }

  // ---------- Normal chat flow ----------
  const userMessage = (body.message || "").trim();
  const history = Array.isArray(body.history) ? body.history : [];
  const attachments = Array.isArray(body.attachments) ? body.attachments : [];

  if (!userMessage && attachments.length === 0) {
    return res.status(400).json({ error: "Missing 'message' in body" });
  }

  const coachProfile =
    typeof body.coachProfile === "string" ? body.coachProfile : null;

  // Optional web search
  const searchEnabled = body.enableSearch !== false;
  let extraSearchContext = "";

  if (body.extraSearchContext) {
    try {
      extraSearchContext = String(body.extraSearchContext);
    } catch {
      extraSearchContext = "";
    }
  }

  if (searchEnabled && shouldUseSearch(userMessage)) {
    try {
      const searchResults = await webSearch(userMessage);

      if (Array.isArray(searchResults) && searchResults.length > 0) {
        const trimmed = searchResults.slice(0, 5);
        const serialized = JSON.stringify(trimmed, null, 2);

        extraSearchContext = extraSearchContext
          ? extraSearchContext + "\n\n" + serialized
          : serialized;
      }
    } catch (err) {
      console.error("Web search failed:", err);
    }
  }

  if (extraSearchContext && extraSearchContext.length > MAX_SEARCH_CONTEXT_CHARS) {
    extraSearchContext =
      extraSearchContext.slice(0, MAX_SEARCH_CONTEXT_CHARS) +
      "\n\n[Search context truncated for length]";
  }

  const historyMessages = history
    .filter((h) => h && typeof h.content === "string")
    .slice(-MAX_HISTORY_MESSAGES)
    .map((h) => ({
      role: h.role === "assistant" ? "assistant" : "user",
      content: h.content,
    }));

  const client = await getOpenAIClient();

  // ---------- Automatic User Profile Summary ----------
  const userProfileSummary = await buildUserProfileSummary(client, historyMessages);

  // ---------- Attachments: Vision 2.0 + non-image notes ----------
  let attachmentNote = "";
  const visionImages = [];
  const nonImageAttachmentLines = [];

  const limitedAttachments = attachments.slice(0, MAX_ATTACHMENTS);

  if (limitedAttachments.length > 0) {
    limitedAttachments.forEach((att, idx) => {
      if (!att) return;
      const name = att.name || `file-${idx + 1}`;
      const type = att.type || "unknown";
      const sizeKb = att.size ? Math.round(att.size / 1024) : null;

      if (type.startsWith("image/") && att.data) {
        const imageUrl = `data:${type};base64,${att.data}`;
        visionImages.push({ name, imageUrl });
      } else {
        nonImageAttachmentLines.push(
          `- ${name} (${type}${sizeKb ? `, ~${sizeKb} KB` : ""})`
        );
      }
    });
  }

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
            `3) Suggest 2–4 concrete cues the user can try next time (e.g. "brace before you descend", "slow down the eccentric") for each relevant image.\n` +
            `4) If there are multiple images, compare them: mention improvements, regressions, changes in depth, knee travel, torso angle, bar path, or equipment/room differences.\n\n` +
            `Guardrails:\n` +
            `- Do NOT diagnose injuries or medical conditions.\n` +
            `- Do NOT estimate body fat percentage or make aesthetic judgements.\n` +
            `- Stay focused on performance, movement quality, and safety.\n` +
            `- Use encouraging, non-shaming language.\n` +
            `You can refer to them as "image 1", "image 2", etc. in the order they were provided.`,
        },
        ...visionImages.map((img, idx) => ({
          type: "image_url",
          image_url: {
            url: img.imageUrl
          }
        })),
      ],
    };
  }

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
    "The user sent one or more attachments without any typed message. Use them as context for your reply.";

  messages.push({ role: "user", content: lastUserContent });

  try {
    const completion = await client.chat.completions.create({
      model: DEFAULT_MODEL,
      messages,
      temperature: 0.7,
      max_tokens: 900,
    });

    const reply =
      completion.choices?.[0]?.message?.content?.trim() ||
      "I’m not sure what to say yet — try again with more detail.";

    return res.status(200).json({ reply });
  } catch (err) {
    console.error("Exerbud AI backend error:", err);
    return res.status(500).json({
      error: "Exerbud backend failed.",
      details:
        process.env.NODE_ENV === "development"
          ? err.message || String(err)
          : undefined,
    });
  }
};
