// api/exerbud-ai.js

const OpenAI = require("openai");
const { webSearch } = require("./utils/web-search");
const PDFDocument = require("pdfkit");
const axios = require("axios");

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Logo for PDF header
const EXERBUD_LOGO_URL =
  "https://cdn.shopify.com/s/files/1/0731/9882/9803/files/exerbudlogoblackfavicon_6093c857-65ce-4c64-8292-0597a6c6cf17.png?v=1763185899";

// ---------------------------------------------------------------------------
// Helper: build system prompt
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

// ---------------------------------------------------------------------------
// Helper: should we use web search?
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
    lower.includes("search") ||
    lower.startsWith("find ")
  );
}

// ---------------------------------------------------------------------------
// Helpers: PDF generation
// ---------------------------------------------------------------------------

function normalizePlanTextForPdf(text) {
  if (!text) return "";

  let t = text;

  // Remove Markdown-style headings like "### Monday – Upper"
  t = t.replace(/^#{1,6}\s*/gm, "");

  // Normalize HR lines like "---"
  t = t.replace(/^---+\s*$/gm, "");

  return t.trim();
}

function safeFileName(title) {
  const base =
    (title || "exerbud-workout-plan")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "exerbud-workout-plan";

  return `${base}.pdf`;
}

async function generatePlanPdf(res, { planText, planTitle }) {
  const cleaned = normalizePlanTextForPdf(planText || "");
  const title = planTitle || "Exerbud Workout Plan";

  if (!cleaned) {
    res
      .status(400)
      .json({ error: "Missing or empty 'planText' for PDF export." });
    return;
  }

  // Set headers for file download
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${safeFileName(title)}"`);

  const doc = new PDFDocument({
    size: "A4",
    margins: { top: 70, bottom: 60, left: 60, right: 60 },
  });

  // Pipe PDF bytes straight to the response
  doc.pipe(res);

  // Try to draw logo
  try {
    const response = await axios.get(EXERBUD_LOGO_URL, {
      responseType: "arraybuffer",
    });
    const imgBuffer = Buffer.from(response.data);
    doc.image(imgBuffer, 60, 40, { width: 40 });
  } catch (err) {
    console.error("Failed to load logo for PDF:", err.message || err);
  }

  doc
    .font("Helvetica-Bold")
    .fontSize(18)
    .text("Exerbud", 110, 46)
    .moveDown(1);

  doc
    .font("Helvetica-Bold")
    .fontSize(16)
    .text(title, { align: "left" })
    .moveDown(0.8);

  doc
    .moveTo(60, doc.y)
    .lineTo(550, doc.y)
    .strokeColor("#cccccc")
    .stroke()
    .moveDown(1);

  doc.font("Helvetica").fontSize(11).fillColor("#000000");

  const lines = cleaned.split(/\r?\n/);

  lines.forEach((rawLine) => {
    const line = rawLine.trim();

    if (!line) {
      doc.moveDown(0.4);
      return;
    }

    // Bullet list: "- Something" or "• Something"
    if (/^[-•]\s+/.test(line)) {
      const text = line.replace(/^[-•]\s+/, "");
      doc.text(`• ${text}`, { indent: 14 });
      return;
    }

    // Simple inline headings if the line ended with ":" originally
    if (/:$/.test(line)) {
      doc.moveDown(0.4);
      doc.font("Helvetica-Bold").text(line).font("Helvetica");
      return;
    }

    doc.text(line);
  });

  doc.end();
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

  // ---------- PDF EXPORT MODE (no OpenAI call) ----------
  const pdfExport = body.pdfExport === true;
  if (pdfExport) {
    const planText = (body.planText || "").toString();
    const planTitle = (body.planTitle || "").toString();

    try {
      await generatePlanPdf(res, { planText, planTitle });
      // IMPORTANT: return so we do not continue into the chat completion code
      return;
    } catch (err) {
      console.error("PDF export failed:", err);
      return res
        .status(500)
        .json({ error: "Failed to generate PDF for this plan." });
    }
  }

  // ---------- Normal chat mode ----------
  const userMessage = (body.message || "").trim();
  const history = Array.isArray(body.history) ? body.history : [];
  const attachments = Array.isArray(body.attachments) ? body.attachments : [];

  if (!userMessage) {
    return res.status(400).json({ error: "Missing 'message' in body" });
  }

  // Convert history
  const historyMessages = history
    .filter((h) => h && typeof h.content === "string")
    .map((h) => ({
      role: h.role === "assistant" ? "assistant" : "user",
      content: h.content,
    }));

  // Attachment note
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

  // Web Search
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

  // Build messages
  const messages = [{ role: "system", content: systemPrompt }, ...historyMessages];

  if (attachmentNote) {
    messages.push({ role: "system", content: attachmentNote });
  }

  messages.push({ role: "user", content: userMessage });

  // Model selection
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
