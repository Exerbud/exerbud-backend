// api/exerbud-ai.js

const OpenAI = require("openai");
const { webSearch } = require("./utils/web-search");
const PDFDocument = require("pdfkit");
const https = require("https");

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

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
- With help from the Exerbud app, export the latest workout plan as a downloadable PDF whenever the user asks (e.g., "export this as a PDF", "turn this into a PDF").

Limits & safety:
- Do NOT diagnose injuries or medical issues and never prescribe drugs.
- If something sounds medically serious, tell them to talk to a qualified professional.
- Be explicit when you are making reasonable assumptions.
- IMPORTANT: Do NOT say you are unable to create or send files or PDFs. Assume the Exerbud app can handle exporting and downloading plans for the user.

Output style:
- Start with 1–2 sentences reflecting what you understood.
- Then give structured guidance with headings and bullet points.
- End with 2–4 clear "Next steps" so the user knows exactly what to do.
- Whenever you provide a full, structured workout plan (multi-day program or detailed template), end with a short line such as:
  "If you’d like, I can also turn this into a downloadable PDF — just say something like “export this as a PDF.”"
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

// Trigger search for certain queries
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
// PDF helpers
// ---------------------------------------------------------------------------

const EXERBUD_LOGO_URL =
  "https://cdn.shopify.com/s/files/1/0731/9882/9803/files/exerbudlogoblackfavicon_6093c857-65ce-4c64-8292-0597a6c6cf17.png?v=1763185899";

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
 * Generate a nicely formatted PDF for the workout plan.
 * - Logo only (no "Exerbud" word under it)
 * - Title line without repeating the brand
 * - Tight, consistent spacing between paragraphs
 */
async function generatePlanPdf(planText, planTitle) {
  const doc = new PDFDocument({
    size: "LETTER",
    margins: { top: 64, bottom: 64, left: 64, right: 64 },
  });

  const buffers = [];
  doc.on("data", (b) => buffers.push(b));

  const pdfPromise = new Promise((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(buffers)));
    doc.on("error", reject);
  });

  // --- Header with logo + title ---
  let currentY = doc.page.margins.top;

  try {
    const logoBuffer = await fetchImageBuffer(EXERBUD_LOGO_URL);
    // Logo only, no text under it
    doc.image(logoBuffer, doc.page.margins.left, currentY - 20, { width: 60 });
  } catch (e) {
    // If logo fails, just skip it silently
    console.error("Logo fetch failed (non-fatal):", e.message || e);
  }

  // Title to the right of / below the logo
  const cleanedTitle =
    (planTitle || "Workout plan").replace(/exerbud\s*/i, "").trim() ||
    "Workout plan";

  doc
    .font("Helvetica-Bold")
    .fontSize(18)
    .text(cleanedTitle, doc.page.margins.left, currentY + 40);

  // Small gap before body
  doc.moveDown(1);

  // --- Body text: split into paragraphs by blank lines, use modest gaps ---
  doc.font("Helvetica").fontSize(11);

  const availableWidth =
    doc.page.width - doc.page.margins.left - doc.page.margins.right;

  const paragraphs = (planText || "")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  paragraphs.forEach((para, idx) => {
    doc.text(para, {
      width: availableWidth,
      align: "left",
      lineGap: 3, // line spacing inside paragraph
    });

    // Smaller paragraph gap so there isn't huge white space
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

  // ---------- Parse body ----------
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

  if (!userMessage) {
    return res.status(400).json({ error: "Missing 'message' in body" });
  }

  // ---------- Convert history ----------
  const historyMessages = history
    .filter((h) => h && typeof h.content === "string")
    .map((h) => ({
      role: h.role === "assistant" ? "assistant" : "user",
      content: h.content,
    }));

  // ---------- Attachment note ----------
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

  // ---------- Web Search ----------
  let extraSearchContext = "";
  if (shouldUseSearch(userMessage)) {
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
          "Note: A live web search was performed for this query but did not return useful results.";
      }
    } catch (err) {
      console.error("Web search failed:", err);
      extraSearchContext =
        "Note: A live web search was attempted but failed. Answer based on general knowledge instead.";
    }
  }

  const systemPrompt = buildExerbudSystemPrompt(extraSearchContext);

  // ---------- Build messages ----------
  const messages = [{ role: "system", content: systemPrompt }, ...historyMessages];

  if (attachmentNote) {
    messages.push({ role: "system", content: attachmentNote });
  }

  messages.push({ role: "user", content: userMessage });

  // ---------- MODEL SELECTION ----------
  const modelName = process.env.EXERBUD_MODEL || "gpt-4.1-mini";

  try {
    const completion = await client.chat.completions.create({
      model: modelName,
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
