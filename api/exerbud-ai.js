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

  let attachmentNote = "";
  const imageMessages = [];
  const limitedAttachments = attachments.slice(0, MAX_ATTACHMENTS);

  if (limitedAttachments.length > 0) {
    const lines = limitedAttachments.map((att, idx) => {
      const name = att?.name || `file-${idx + 1}`;
      const type = att?.type || "unknown";
      const sizeKb = att?.size ? Math.round(att.size / 1024) : null;
      return `- ${name} (${type}${sizeKb ? `, ~${sizeKb} KB` : ""})`;
    });

    attachmentNote =
      "The user also uploaded these files; use them as extra context. For images, you can visually inspect them:\n" +
      lines.join("\n");

    for (const att of limitedAttachments) {
      if (!att || !att.data || !att.type) continue;
      const mime = att.type || "application/octet-stream";

      if (!mime.startsWith("image/")) continue;

      const imageUrl = `data:${mime};base64,${att.data}`;

      imageMessages.push({
        role: "user",
        content: [
          {
            type: "text",
            text:
              `User uploaded an image (${att.name || "image"}). ` +
              `Visually inspect it and use it as context for your reply.`,
          },
          {
            type: "image_url",
            image_url: { url: imageUrl },
          },
        ],
      });
    }
  }

  const systemPrompt = buildExerbudSystemPrompt(
    extraSearchContext || undefined,
    coachProfile
  );

  const messages = [{ role: "system", content: systemPrompt }, ...historyMessages];

  if (attachmentNote) {
    messages.push({ role: "system", content: attachmentNote });
  }

  if (imageMessages.length > 0) {
    messages.push(...imageMessages);
  }

  const lastUserContent =
    userMessage ||
    "The user sent one or more attachments without any typed message. Use them as context for your reply.";

  messages.push({ role: "user", content: lastUserContent });

  try {
    const client = await getOpenAIClient();

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
