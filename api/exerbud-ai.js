// api/exerbud-ai.js

// ----------------------------------------------
// Imports & config
// ----------------------------------------------
const PDFDocument = require("pdfkit");

// Lazy-load OpenAI so Vercel cold starts are nicer
let cachedOpenAI = null;
async function getOpenAIClient() {
  if (!cachedOpenAI) {
    const OpenAI = (await import("openai")).default;
    cachedOpenAI = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
  }
  return cachedOpenAI;
}

const MODEL = process.env.EXERBUD_MODEL || "gpt-4.1-mini";
const MAX_HISTORY_MESSAGES = 20;
const MAX_ATTACHMENTS = 4;
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024; // 8 MB per file

// ----------------------------------------------
// Helper: simple Google CSE web search
// ----------------------------------------------
async function runWebSearch(query) {
  try {
    const apiKey = process.env.GOOGLE_API_KEY;
    const cx = process.env.GOOGLE_CX;

    if (!apiKey || !cx || !query) return null;

    const url =
      "https://www.googleapis.com/customsearch/v1" +
      `?key=${encodeURIComponent(apiKey)}` +
      `&cx=${encodeURIComponent(cx)}` +
      `&q=${encodeURIComponent(query)}`;

    const res = await fetch(url);
    if (!res.ok) {
      console.error("Google CSE error status:", res.status);
      return null;
    }

    const data = await res.json();
    if (!data.items || !Array.isArray(data.items)) return null;

    const top = data.items.slice(0, 5);
    const lines = top.map((item, idx) => {
      const title = item.title || "";
      const snippet = item.snippet || "";
      const link = item.link || "";
      return `${idx + 1}. ${title}\n${snippet}\n${link}`;
    });

    return lines.join("\n\n");
  } catch (err) {
    console.error("runWebSearch error:", err);
    return null;
  }
}

// ----------------------------------------------
// Helper: coach profiles
// ----------------------------------------------
function getCoachProfileText(coachProfile) {
  switch (coachProfile) {
    case "strength":
      return `
You are acting as a Strength Coach.

- Prioritize progressive overload, compound lifts, and clear weekly structure.
- Use clear set/rep schemes (e.g., 3x5, 4x6–8) with effort guidance (RPE or "2 reps in reserve").
- Emphasize technique quality and long-term joint health.
- Plans should feel realistic and not crazy high volume.
`.trim();

    case "hypertrophy":
      return `
You are acting as a Hypertrophy Coach.

- Focus on muscle growth and aesthetics.
- Use moderate to higher rep ranges (e.g., 6–15) and adequate weekly volume per muscle.
- Emphasize controlled tempo, mind–muscle connection, and symmetrical development.
- Use a mix of compounds and isolation work, structured logically by muscle group.
`.trim();

    case "mobility":
      return `
You are acting as a Mobility Specialist.

- Focus on joint health, active range of motion, and long-term resilience.
- Use dynamic mobility, loaded stretching, and controlled articular rotations where appropriate.
- Include clear instructions for tempo, time under stretch, and breathing.
- Emphasize pain-free ranges and gradual progress.
`.trim();

    case "fat_loss":
      return `
You are acting as a Fat Loss Coach.

- Prioritize sustainable, realistic training to support fat loss.
- Use a mix of resistance training and conditioning, avoiding excessive volume that hurts recovery.
- Emphasize habits: steps, sleep, adherence, and realistic expectations.
- Make workouts feel achievable for busy people.
`.trim();

    default:
      return `
You are Exerbud, a friendly but no-nonsense fitness coach.

- Give clear, structured training guidance.
- Use realistic volumes and rest periods.
- Explain your choices briefly, but keep the plan readable.
`.trim();
  }
}

// ----------------------------------------------
// Helper: main system prompt
// ----------------------------------------------
function buildSystemPrompt(coachProfile) {
  const baseCoachText = getCoachProfileText(coachProfile);

  return `
You are Exerbud AI, an expert fitness coach that helps people design training plans, routines, and schedules.

${baseCoachText}

GENERAL BEHAVIOR:
- Always be specific and actionable.
- Prefer numbered or bulleted lists for exercises, sets, reps, and notes.
- When giving workout plans, group them clearly by days (e.g., "Day 1 – Upper", "Day 2 – Lower").
- Keep wording concise and friendly.
- You can explain your reasoning briefly, but keep the workout itself easy to read.

IMAGES:
- If images are provided (gym photos, screenshots of routines, progress pics), describe what you see and then give practical recommendations.
- Do NOT comment on appearance in a judgmental way. Be supportive and neutral.

WEB SEARCH:
- You may be given a block of "WEB SEARCH RESULTS" containing gym listings, trainers, or product links.
- Use those results to make more concrete suggestions (e.g., "Gym A looks like it has good equipment for strength training because…").
- If search results look sparse or generic, say so.

WEEKLY / MULTI-WEEK PLANS:
- When the user asks for a weekly or multi-week plan, format it clearly.
- Use headings like "Week 1", "Week 2" when appropriate.
- Within each week, break things down by day: "Day 1 – Upper", "Day 2 – Lower", etc.
- Under each day, list exercises as bullet points with sets, reps, and rest times.

FORMATTING:
- Use line breaks to separate sections.
- Use simple bullets with "-" for lists.
- For numbered steps, use "1.", "2.", etc.
- Avoid markdown tables; they are harder to read in plain text.
`.trim();
}

// ----------------------------------------------
// Helper: build OpenAI messages with history & attachments
// ----------------------------------------------
function buildMessages({ systemPrompt, message, history, searchContext, attachmentNote }) {
  const messages = [
    {
      role: "system",
      content: systemPrompt,
    },
  ];

  if (Array.isArray(history)) {
    history
      .slice(-MAX_HISTORY_MESSAGES)
      .forEach((m) => {
        if (!m || !m.content) return;
        const role = m.role === "assistant" ? "assistant" : "user";
        messages.push({ role, content: m.content });
      });
  }

  if (searchContext) {
    messages.push({
      role: "system",
      content:
        "WEB SEARCH RESULTS:\n\n" +
        searchContext +
        "\n\nUse these results if they are relevant to the user's request.",
    });
  }

  if (attachmentNote) {
    messages.push({
      role: "user",
      content: attachmentNote,
    });
  }

  // The final user message goes last; we'll merge text + images there
  // (for chat.completions with vision-compatible models)
  // We return just the text here; image parts will be attached in handler.
  messages.push({
    role: "user",
    content: message || "",
  });

  return messages;
}

// ----------------------------------------------
// Helper: build image content parts for vision
// ----------------------------------------------
function buildImagePartsFromAttachments(attachments) {
  if (!Array.isArray(attachments) || !attachments.length) return [];

  const images = attachments.filter(
    (file) =>
      file &&
      typeof file.data === "string" &&
      file.type &&
      file.type.startsWith("image/") &&
      file.size <= MAX_ATTACHMENT_BYTES
  );

  if (!images.length) return [];

  return images.map((file) => ({
    type: "image_url",
    image_url: {
      url: `data:${file.type};base64,${file.data}`,
    },
  }));
}

// ----------------------------------------------
// Helper: quick attachment summary for non-image files
// ----------------------------------------------
function buildAttachmentNote(attachments) {
  if (!Array.isArray(attachments) || !attachments.length) return "";

  const nonImages = attachments.filter(
    (file) => !file.type || !file.type.startsWith("image/")
  );

  if (!nonImages.length) return "";

  const lines = nonImages.map((file) => {
    const name = file.name || "file";
    const sizeKb = file.size ? Math.round(file.size / 1024) : "?";
    return `- ${name} (${sizeKb} KB, type: ${file.type || "unknown"})`;
  });

  return `
The user also attached these non-image files (you do NOT see their contents, only the metadata):

${lines.join("\n")}

You cannot read these files directly, but you can ask the user to paste text or describe them if needed.
`.trim();
}

// ----------------------------------------------
// Helper: generate a simple PDF from text
// ----------------------------------------------
function generatePdfFromText(res, { title, text }) {
  const doc = new PDFDocument({ margin: 50 });

  // Basic headers
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${(title || "exerbud-workout-plan")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "exerbud-workout-plan"}.pdf"`
  );

  doc.pipe(res);

  doc.fontSize(18).text(title || "Exerbud workout plan", {
    align: "left",
  });

  doc.moveDown();

  const cleaned = (text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  doc.fontSize(11).text(cleaned || "No plan content provided.", {
    align: "left",
  });

  doc.end();
}

// ----------------------------------------------
// Main handler
// ----------------------------------------------
module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const body = req.body || {};

    // 1) PDF export short-circuit
    if (body.pdfExport) {
      const planText = body.planText || "";
      const planTitle = body.planTitle || "Exerbud workout plan";
      return generatePdfFromText(res, { title: planTitle, text: planText });
    }

    // 2) Normal chat flow
    const message = typeof body.message === "string" ? body.message.trim() : "";
    const history = Array.isArray(body.history) ? body.history : [];
    const attachments = Array.isArray(body.attachments) ? body.attachments : [];
    const enableSearch = !!body.enableSearch;
    const coachProfile = body.coachProfile || null;

    if (!message && !attachments.length) {
      return res.status(400).json({
        error: "Missing 'message' or 'attachments' in request body.",
      });
    }

    // Trim attachments count
    const limitedAttachments = attachments.slice(0, MAX_ATTACHMENTS);

    // Possibly run web search
    let searchContext = null;
    if (enableSearch && message) {
      // Simple heuristic: search when user mentions "find", "near me", or "best"
      const lower = message.toLowerCase();
      const shouldSearch =
        /near me|find|search|best gym|personal trainer|coach|equipment/.test(lower);

      if (shouldSearch) {
        searchContext = await runWebSearch(message);
      }
    }

    // Build system prompt
    const systemPrompt = buildSystemPrompt(coachProfile);

    // Attachment notes for non-images
    const attachmentNote = buildAttachmentNote(limitedAttachments);

    // Build messages
    const baseMessages = buildMessages({
      systemPrompt,
      message,
      history,
      searchContext,
      attachmentNote,
    });

    // Build vision-aware final user message
    const imageParts = buildImagePartsFromAttachments(limitedAttachments);

    let messages;

    if (imageParts.length > 0) {
      // Replace final user message with content array including text + images
      messages = baseMessages.slice(0, -1);
      const lastUser = baseMessages[baseMessages.length - 1];
      messages.push({
        role: "user",
        content: [
          { type: "text", text: lastUser.content || message || "" },
          ...imageParts,
        ],
      });
    } else {
      messages = baseMessages;
    }

    // Call OpenAI
    const client = await getOpenAIClient();
    const completion = await client.chat.completions.create({
      model: MODEL,
      messages,
      temperature: 0.6,
    });

    const choice = completion.choices && completion.choices[0];
    const reply =
      (choice && choice.message && choice.message.content) ||
      "I’m not sure what to say yet — try asking in a different way or giving more detail.";

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
