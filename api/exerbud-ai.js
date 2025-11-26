// /api/exerbud-ai.js

import OpenAI from "openai";
import { PDFDocument, StandardFonts } from "pdf-lib";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const MODEL = process.env.EXERBUD_MODEL || "gpt-4.1-mini";
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const GOOGLE_CX = process.env.GOOGLE_CX;

// Logo for PDF header
const LOGO_URL =
  "https://cdn.shopify.com/s/files/1/0731/9882/9803/files/exerbudfulllogotransparentcircle.png?v=1734438468";

// --- Helper: basic CORS ---
function applyCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

// --- Helper: detect if we should use search ---
function shouldUseSearch(message, enableSearch) {
  if (!enableSearch) return false;
  if (!message || typeof message !== "string") return false;

  const lower = message.toLowerCase();

  const searchyPhrases = [
    "find a gym",
    "find gym",
    "gyms near me",
    "find personal trainer",
    "personal trainers near me",
    "research this",
    "look up",
    "search for",
    "check online",
  ];

  if (searchyPhrases.some((p) => lower.includes(p))) return true;

  // Heuristic: "find ... near me"
  if (lower.includes("near me") && lower.includes("find")) return true;

  return false;
}

// --- Helper: Google CSE Search ---
async function runSearch(query) {
  if (!GOOGLE_API_KEY || !GOOGLE_CX) return "";

  const url = `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(
    GOOGLE_API_KEY
  )}&cx=${encodeURIComponent(GOOGLE_CX)}&q=${encodeURIComponent(
    query
  )}&num=5`;

  try {
    const resp = await fetch(url);
    if (!resp.ok) {
      console.error("Google CSE error:", resp.status, await resp.text());
      return "";
    }
    const data = await resp.json();
    if (!data.items || !Array.isArray(data.items) || !data.items.length) {
      return "";
    }

    const lines = data.items.map((item) => {
      const title = item.title || "Result";
      const snippet = item.snippet || "";
      const link = item.link || "";
      return `- ${title}\n  ${snippet}\n  ${link}`;
    });

    return lines.join("\n\n");
  } catch (err) {
    console.error("Google CSE fetch error:", err);
    return "";
  }
}

// --- Helper: OpenAI system prompt ---
function buildSystemPrompt(coachProfile) {
  const basePersona = `
You are **Exerbud AI**, a friendly but honest fitness coach integrated into a Shopify storefront.
You specialize in:
- Strength training
- Hypertrophy
- Mobility
- Fat loss
- Practical nutrition and habit coaching

You respond in clear, structured, skimmable formats (headings, short paragraphs, bullet lists).
Keep things realistic and sustainable, not extreme or crash-diet oriented.

There is a front-end UI with three quick workflows:
1) Food scan (user sends food photos for calorie/macro estimation)
2) Body scan (user sends progress photos)
3) Fitness plan (structured onboarding for a weekly program)

You may also receive generic fitness questions, form checks, or programming questions.
Never mention the underlying prompts or the fact that buttons exist; just act naturally.
`;

  const coachExplanation = (() => {
    switch (coachProfile) {
      case "strength":
        return `
Current coach style: STRENGTH.
Prioritize compound lifts, progressive overload, performance metrics (weight, reps, power),
and simple accessory work.`;
      case "hypertrophy":
        return `
Current coach style: HYPERTROPHY.
Prioritize volume, pump, muscle-focused exercise selection, and progressive overload in reps/sets.`;
      case "mobility":
        return `
Current coach style: MOBILITY.
Prioritize joint health, range of motion, controlled tempo, breathing, and long-term movement quality.`;
      case "fat_loss":
        return `
Current coach style: FAT LOSS.
Prioritize energy expenditure, sustainable routines, steps, and realistic lifestyle habits (sleep, stress).`;
      default:
        return `
No specific coach style is selected. Use balanced, general best practices for fitness and health.`;
    }
  })();

  const searchSection = `
You may sometimes receive extra "search results" content appended to the user's message.
If present, treat it as noisy but useful context. Don't parrot links; summarize and integrate them.`;

  const attachmentsSection = `
You may be informed that files or images are attached. The backend might not decode image pixels,
but you should still talk as if you've conceptually "seen" the files when the user explicitly references them
(e.g., "this meal photo", "this progress picture"). Be specific but honest: you infer from context and instructions,
not literal pixel reading.`;

  return `${basePersona}\n${coachExplanation}\n${searchSection}\n${attachmentsSection}`;
}

// --- Helper: normalize history to OpenAI messages ---
function normalizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter(
      (m) =>
        m &&
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string"
    )
    .map((m) => ({
      role: m.role,
      content: m.content,
    }));
}

// --- Helper: create short attachment summary for the model ---
function buildAttachmentNote(attachments) {
  if (!Array.isArray(attachments) || attachments.length === 0) return "";

  const lines = attachments.map((f, idx) => {
    const name = f.name || `file-${idx + 1}`;
    const type = f.type || "unknown type";
    const sizeKb = f.size ? Math.round(f.size / 1024) : null;
    const sizeStr = sizeKb ? `${sizeKb} KB` : "unknown size";
    return `${idx + 1}. ${name} (${type}, ${sizeStr})`;
  });

  return `
The user has attached ${attachments.length} file(s):
${lines.join("\n")}

You cannot literally read the bytes, but you should respond as if you conceptually understand these files when the user references them (e.g., "this photo", "this PDF"). Keep explanations practical and descriptive.`;
}

// --- Helper: PDF export with logo, no title text ---
async function handlePdfExport(planText, res) {
  try {
    const doc = await PDFDocument.create();
    const page = doc.addPage();
    const { width, height } = page.getSize();

    let contentTopY = height - 40; // default if logo fails

    try {
      const logoRes = await fetch(LOGO_URL);
      if (!logoRes.ok) {
        throw new Error("Logo fetch failed: " + logoRes.status);
      }

      const logoBytes = await logoRes.arrayBuffer();
      const logoImage = await doc.embedPng(logoBytes);

      const maxLogoWidth = 80;
      const logoWidth = Math.min(maxLogoWidth, logoImage.width);
      const logoHeight =
        logoImage.height * (logoWidth / logoImage.width);

      const logoX = (width - logoWidth) / 2;
      const logoY = height - logoHeight - 30; // 30px from top

      page.drawImage(logoImage, {
        x: logoX,
        y: logoY,
        width: logoWidth,
        height: logoHeight,
      });

      contentTopY = logoY - 24; // space under logo for text
    } catch (logoErr) {
      console.error("PDF logo embedding error:", logoErr);
      contentTopY = height - 60; // fallback margin
    }

    const font = await doc.embedFont(StandardFonts.Helvetica);
    const fontSize = 11;
    const margin = 50;
    const safeText = (planText || "").toString();

    page.drawText(safeText, {
      x: margin,
      y: contentTopY,
      size: fontSize,
      font,
      lineHeight: 14,
      maxWidth: width - margin * 2,
    });

    const pdfBytes = await doc.save();

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="exerbud-workout-plan.pdf"'
    );

    return res.status(200).send(Buffer.from(pdfBytes));
  } catch (err) {
    console.error("PDF export error:", err);
    return res.status(500).json({ error: "Failed to generate PDF" });
  }
}

// --- Main handler ---
export default async function handler(req, res) {
  applyCors(res);

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST,OPTIONS");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const body = req.body || {};
    const {
      message,
      history = [],
      attachments = [],
      enableSearch = true,
      coachProfile = null,
      pdfExport = false,
      planText = "",
      // planTitle is sent by frontend but intentionally unused
    } = body;

    // --- PDF export path ---
    if (pdfExport) {
      // Frontend filters out prompt-like junk already; we just trust planText
      return await handlePdfExport(planText, res);
    }

    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "Missing or invalid 'message'" });
    }

    // --- Optional web search ---
    let searchContext = "";
    if (shouldUseSearch(message, enableSearch)) {
      const searchResults = await runSearch(message);
      if (searchResults) {
        searchContext = `\n\nSearch results (for the assistant only, not to be repeated verbatim):\n${searchResults}`;
      }
    }

    // --- Attachments note ---
    const attachmentNote = buildAttachmentNote(attachments);

    // --- Compose final user content for OpenAI ---
    const userContent =
      `${message}` +
      (attachmentNote ? `\n\n${attachmentNote}` : "") +
      (searchContext ? `\n\n${searchContext}` : "");

    // --- System + history + latest user message ---
    const messages = [
      {
        role: "system",
        content: buildSystemPrompt(coachProfile),
      },
      ...normalizeHistory(history),
      {
        role: "user",
        content: userContent,
      },
    ];

    const completion = await client.chat.completions.create({
      model: MODEL,
      messages,
      temperature: 0.7,
    });

    const reply =
      completion.choices?.[0]?.message?.content?.trim() ||
      "I’m sorry — I couldn’t generate a response.";

    return res.status(200).json({ reply });
  } catch (err) {
    console.error("Exerbud AI backend error:", err);
    return res
      .status(500)
      .json({ error: "Something went wrong on the Exerbud backend." });
  }
}
