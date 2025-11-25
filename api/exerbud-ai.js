// /api/exerbud-ai.js
// Non-streaming Exerbud backend with bare-image support

import OpenAI from "openai";
import PDFDocument from "pdfkit";
import { PassThrough } from "stream";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || "";
const GOOGLE_CX      = process.env.GOOGLE_CX || "";

function applyCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

// --------- Helpers ----------

function sanitizeHistory(rawHistory) {
  if (!Array.isArray(rawHistory)) return [];
  const allowedRoles = new Set(["user", "assistant", "system"]);

  return rawHistory
    .map((m) => {
      const role = allowedRoles.has(m.role) ? m.role : "user";
      const content =
        typeof m.content === "string" && m.content.trim()
          ? m.content
          : "";
      return { role, content };
    })
    .filter((m) => m.content)
    .slice(-20);
}

function buildSystemPrompt(coachProfile) {
  let coachFlavor = "";

  switch (coachProfile) {
    case "strength":
      coachFlavor =
        "You are a strength-focused coach. Prioritize compound lifts, progressive overload, and clear structure. ";
      break;
    case "hypertrophy":
      coachFlavor =
        "You are a hypertrophy-focused coach. Emphasize training volume, mind-muscle connection, and muscle growth. ";
      break;
    case "mobility":
      coachFlavor =
        "You are a mobility-focused coach. Emphasize range of motion, control, warm-ups, and never push through sharp pain. ";
      break;
    case "fat_loss":
      coachFlavor =
        "You are a fat-loss-focused coach. Emphasize sustainable activity, simple nutrition guidance, and habit building. Avoid extreme dieting. ";
      break;
    default:
      coachFlavor =
        "You are a balanced strength-and-general-fitness coach. ";
  }

  return `
You are Exerbud, a friendly, expert fitness coach embedded in a website chat widget.

${coachFlavor}

Your job:
- Ask a few focused follow-up questions when needed.
- Give specific, realistic, actionable workout guidance.
- Stay within your lane: do NOT diagnose injuries or medical conditions. For serious pain, dizziness, heart issues, eating disorders, or other health risks, clearly recommend they see a qualified medical professional.

Formatting rules (IMPORTANT):
- Use real newline characters to separate sentences and items; never put everything on one single line.
- When you list questions, put each question on its own line.
- For numbered lists, each item must start on its own line, e.g.:
  1. First item
  2. Second item
- For bullet lists, use "-" and put each bullet on its own line.
- Keep paragraphs short (1–3 sentences) with blank lines between paragraphs.
- Do NOT use markdown headings like "#", "##", etc. Plain text is fine.
`.trim();
}

function summarizeAttachments(attachments) {
  if (!Array.isArray(attachments) || attachments.length === 0) return "";

  const lines = attachments.map((file, idx) => {
    const name = file.name || `file-${idx + 1}`;
    const type = file.type || "unknown";
    const size = typeof file.size === "number"
      ? `${Math.round(file.size / 1024)}KB`
      : "unknown size";
    return `- ${name} (${type}, ${size})`;
  });

  return [
    "The user also attached the following files:",
    ...lines,
    "You do NOT see the actual bytes. Reason based only on these descriptions."
  ].join("\n");
}

// Very light search heuristic
function shouldSearch(query = "") {
  const q = query.toLowerCase();
  if (!q) return false;

  if (q.includes("near me") || q.includes("nearby")) return true;
  if (q.includes("find a gym") || q.includes("find gyms")) return true;
  if (q.includes("find personal trainer") || q.includes("find personal trainers")) return true;

  return false;
}

async function runSearch(query) {
  if (!GOOGLE_API_KEY || !GOOGLE_CX) return "";

  try {
    const params = new URLSearchParams({
      key: GOOGLE_API_KEY,
      cx: GOOGLE_CX,
      q: query,
    });

    const resp = await fetch(
      `https://www.googleapis.com/customsearch/v1?${params.toString()}`
    );

    if (!resp.ok) return "";

    const data = await resp.json();
    const items = Array.isArray(data.items) ? data.items.slice(0, 5) : [];

    if (!items.length) return "";

    const lines = items.map((item, idx) => {
      const title = item.title || "Result";
      const snippet = item.snippet || "";
      const link = item.link || "";
      return `${idx + 1}. ${title}\n${snippet}\n${link}`;
    });

    return `Here is some recent information from the web that may help:\n\n${lines.join(
      "\n\n"
    )}`;
  } catch (err) {
    console.error("Google search error:", err);
    return "";
  }
}

// PDF generator used by pdfExport=true
function pipePlanPdfToResponse(planTitle, planText, res) {
  const doc = new PDFDocument({ margin: 50 });
  const stream = new PassThrough();

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    'attachment; filename="exerbud-workout-plan.pdf"'
  );

  doc.pipe(stream);
  stream.pipe(res);

  doc.fontSize(20).text(planTitle || "Exerbud workout plan", {
    align: "center",
  });
  doc.moveDown();

  doc.fontSize(11).text(planText || "", {
    align: "left",
  });

  doc.end();
}

// --------- Main handler ----------

export default async function handler(req, res) {
  applyCors(res);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: "Missing OPENAI_API_KEY" });
  }

  let body;
  try {
    body =
      typeof req.body === "string"
        ? JSON.parse(req.body)
        : req.body || {};
  } catch (err) {
    return res.status(400).json({ error: "Invalid JSON body" });
  }

  // --------- PDF export branch ----------
  if (body.pdfExport) {
    const planText = (body.planText || "").toString();
    const planTitle = (body.planTitle || "Exerbud workout plan").toString();

    if (!planText.trim()) {
      return res.status(400).json({ error: "Missing planText for PDF export" });
    }

    try {
      pipePlanPdfToResponse(planTitle, planText, res);
      return;
    } catch (err) {
      console.error("PDF export error:", err);
      return res
        .status(500)
        .json({ error: "Failed to generate PDF", details: String(err?.message || err) });
    }
  }

  // --------- Chat branch ----------

  // Allow either a text message, or attachments, or both
  let message =
    typeof body.message === "string" ? body.message.trim() : "";

  const history      = sanitizeHistory(body.history || []);
  const attachments  = Array.isArray(body.attachments) ? body.attachments : [];
  const enableSearch = Boolean(body.enableSearch);
  const coachProfile = body.coachProfile || null;

  // If there is literally nothing (no text, no files), reject
  if (!message && attachments.length === 0) {
    return res.status(400).json({ error: "Missing message" });
  }

  // If user only attached files but wrote nothing,
  // give the model a hint so it can ask a clarifying question.
  if (!message && attachments.length > 0) {
    message =
      "The user has uploaded one or more files/images but did not type a message. " +
      "Ask a brief follow-up question about what they would like help with regarding these attachments.";
  }

  const attachmentSummary = summarizeAttachments(attachments);

  let searchContext = "";
  if (enableSearch && shouldSearch(message)) {
    searchContext = await runSearch(message);
  }

  const systemPrompt = buildSystemPrompt(coachProfile);

  const messages = [
    { role: "system", content: systemPrompt },
    ...history,
    {
      role: "user",
      content:
        message +
        (attachmentSummary ? "\n\n" + attachmentSummary : "") +
        (searchContext ? "\n\n" + searchContext : ""),
    },
  ];

  try {
    const completion = await client.chat.completions.create({
      model: process.env.EXERBUD_MODEL || "gpt-4.1-mini",
      messages,
      temperature: 0.6,
      max_tokens: 900,
    });

    const reply =
      completion.choices?.[0]?.message?.content?.trim() ||
      "I’m sorry — I couldn’t generate a response.";

    return res.status(200).json({ reply });
  } catch (err) {
    console.error("Exerbud AI error:", err);
    return res.status(500).json({
      error: "OpenAI request failed",
      details: String(err?.message || err),
    });
  }
}
