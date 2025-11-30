// ======================================================================
// EXERBUD AI — NON-STREAMING BACKEND (WITH PRISMA DB + PROGRESS EVENTS)
// - Google Search (optional)
// - PDF Export (with centered logo, no visible title text)
// - Vision support via attachments (image_url)
// - Persists Users / Conversations / Messages / Uploads / ProgressEvents
// ======================================================================

// We can use the built-in fetch on Vercel/Node 18+
const { randomUUID } = require("crypto");

// Prisma Client (lazy init so module load can't crash)
const { PrismaClient } = require("@prisma/client");

let prisma = null;
function getPrisma() {
  if (!prisma) {
    prisma = new PrismaClient();
  }
  return prisma;
}

// Logo URL for PDF header
const EXERBUD_LOGO_URL =
  "https://cdn.shopify.com/s/files/1/0731/9882/9803/files/exerbudfulllogotransparentcircle.png?v=1734438468";

// Tags used to hide machine-only JSON in the model reply
const PROGRESS_JSON_TAG_START = "[[PROGRESS_EVENT_JSON]]";
const PROGRESS_JSON_TAG_END = "[[/PROGRESS_EVENT_JSON]]";

// ----------------------------------------------
// Helpers for identity + DB
// ----------------------------------------------

/**
 * Resolve or create a User based on externalId / email.
 */
async function getOrCreateUser({ externalId, email }) {
  if (!externalId) return null;

  const db = getPrisma();

  const dataToUpdate = { lastSeenAt: new Date() };
  if (email) dataToUpdate.email = email;

  const user = await db.user.upsert({
    where: { externalId },
    create: {
      externalId,
      email: email || null,
    },
    update: dataToUpdate,
  });

  return user;
}

/**
 * Resolve or create a Conversation for this user.
 */
async function getOrCreateConversation({
  user,
  conversationId,
  coachProfile,
  workflow,
}) {
  if (!user) return null;

  const db = getPrisma();

  if (conversationId) {
    try {
      const existing = await db.conversation.findUnique({
        where: { id: conversationId },
      });
      if (existing) return existing;
    } catch (err) {
      console.warn("[Exerbud] Failed to reuse conversation:", err?.message);
    }
  }

  const convo = await db.conversation.create({
    data: {
      userId: user.id,
      coachProfile: coachProfile || null,
      workflow: workflow || null,
      source: "shopify_widget",
    },
  });

  return convo;
}

/**
 * Store a single message row in the DB.
 */
async function saveMessage({ conversation, user, role, content }) {
  if (!conversation || !role || !content) return null;

  const db = getPrisma();

  return db.message.create({
    data: {
      conversationId: conversation.id,
      userId: user ? user.id : null,
      role,
      content,
    },
  });
}

/**
 * Store basic metadata for uploads (we do NOT store the base64 data).
 */
async function saveUploads({ conversation, user, attachments, workflow }) {
  if (!conversation || !user || !attachments?.length) return;

  const db = getPrisma();

  const rows = attachments.map((a) => ({
    userId: user.id,
    conversationId: conversation.id,
    url: "inline",
    type: a.type || "unknown",
    workflow: workflow || null,
  }));

  await db.upload.createMany({ data: rows });
}

/**
 * Store a ProgressEvent row for dashboard analytics.
 */
async function saveProgressEvent({ user, conversation, message, type, payload }) {
  if (!user || !type || !payload) return;

  const db = getPrisma();

  try {
    await db.progressEvent.create({
      data: {
        userId: user.id,
        conversationId: conversation ? conversation.id : null,
        messageId: message ? message.id : null,
        type, // "meal_log" | "body_scan" | "workout_plan"
        payload,
      },
    });
  } catch (e) {
    console.warn("[Exerbud] Failed to save ProgressEvent:", e?.message);
  }
}

/**
 * Extract ProgressEvent JSON from the assistant reply.
 */
function extractProgressEventFromReply(text) {
  if (!text || typeof text !== "string") {
    return { cleanedText: text, event: null };
  }

  const start = text.indexOf(PROGRESS_JSON_TAG_START);
  const end = text.indexOf(PROGRESS_JSON_TAG_END);

  if (start === -1 || end === -1 || end <= start) {
    return { cleanedText: text, event: null };
  }

  const jsonRaw = text
    .substring(start + PROGRESS_JSON_TAG_START.length, end)
    .trim();

  let payload = null;
  try {
    if (jsonRaw) {
      payload = JSON.parse(jsonRaw);
    }
  } catch (e) {
    console.warn("[Exerbud] Failed to parse progress JSON:", e?.message);
  }

  const cleanedText = (
    text.slice(0, start) + text.slice(end + PROGRESS_JSON_TAG_END.length)
  ).trim();

  return { cleanedText: cleanedText || text, event: payload };
}

// ----------------------------------------------
// Main handler (WITH CORS)
// ----------------------------------------------
module.exports = async function handler(req, res) {
  // --- GLOBAL CORS HEADERS (REQUIRED FOR SHOPIFY) ---
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  try {
    // Preflight
    if (req.method === "OPTIONS") {
      return res.status(200).end();
    }

    // Simple GET healthcheck so hitting the URL in a browser doesn't explode
    if (req.method === "GET") {
      return res.status(200).json({
        ok: true,
        message: "Exerbud AI backend is alive",
      });
    }

    // Only POST allowed for real work
    if (req.method !== "POST") {
      res.setHeader("Allow", "GET, POST, OPTIONS");
      return res.status(405).json({ error: "Method not allowed" });
    }

    // Make sure Prisma can initialize inside the try/catch
    getPrisma();

    const body = req.body || {};

    // ==========================================================
    //  PDF EXPORT MODE (LOGO CENTERED)
    // ==========================================================
    if (body.pdfExport) {
      const planText = body.planText || "";

      const PDFDocument = require("pdfkit");
      const doc = new PDFDocument({ margin: 40 });

      const filename = "exerbud-plan.pdf";

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${filename}"`
      );

      doc.pipe(res);

      // -------- CENTERED LOGO HEADER ----------
      try {
        const logoRes = await fetch(EXERBUD_LOGO_URL);
        if (logoRes.ok) {
          const logoBuffer = await logoRes.arrayBuffer();
          const logoBufNode = Buffer.from(logoBuffer);

          const pageWidth = doc.page.width;
          const renderWidth = 90;
          const image = doc.openImage(logoBufNode);

          const scale = renderWidth / image.width;
          const renderHeight = image.height * scale;

          const x = (pageWidth - renderWidth) / 2;
          const y = 30;

          doc.image(logoBufNode, x, y, {
            width: renderWidth,
            height: renderHeight,
          });

          doc.moveDown(4);
        }
      } catch (err) {
        console.error("Error embedding PDF logo:", err);
        doc.moveDown(1);
      }

      // -------- PDF BODY TEXT ----------
      doc.fontSize(12);

      const paragraphs = String(planText).split(/\n{2,}/);

      paragraphs.forEach((para, index) => {
        const clean = para.trim();
        if (!clean) return;
        doc.text(clean);
        if (index < paragraphs.length - 1) doc.moveDown();
      });

      doc.end();
      return;
    }

    // ==========================================================
    //  NORMAL CHAT REQUEST
    // ==========================================================
    const message = (body.message || "").toString().trim();
    const history = Array.isArray(body.history) ? body.history : [];
    const attachments = Array.isArray(body.attachments)
      ? body.attachments
      : [];
    const enableSearch = Boolean(body.enableSearch);
    const coachProfile = body.coachProfile || null;
    const workflow = body.workflow || null; // food_scan | body_scan | fitness_plan | null

    // --- Identity hints coming from the frontend ---
    const rawExternalId =
      body.userExternalId || body.externalId || null;
    const email = body.userEmail || body.email || null;
    const conversationId = body.conversationId || null;

    const externalId =
      rawExternalId ||
      `guest:${body.clientId || body.sessionId || randomUUID().slice(0, 12)}`;

    if (!message && !attachments.length) {
      return res.status(400).json({ error: "Missing message" });
    }

    // ----------------------------------------------------------
    // Prepare formatted history for the model
    // ----------------------------------------------------------
    const formattedHistory = history.map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: (m.content || "").toString().slice(0, 4000),
    }));

    const messages = [...formattedHistory];

    // ----------------------------------------------------------
    // SYSTEM PROMPT (WITH WEB SEARCH BEHAVIOR + PROGRESS JSON)
    // ----------------------------------------------------------
    let systemPrompt = `
You are Exerbud AI — an expert fitness, strength, hypertrophy, mobility, and nutrition coach embedded on the Exerbud website.

You:
- Give clear, practical, sustainable advice.
- Prefer short paragraphs and bullet points.
- Avoid markdown headings like "#" in your responses.

You may sometimes receive extra context that includes live web search results, clearly labeled in the user message (for example with tags like [WEB SEARCH RESULTS]).
Treat this as information retrieved from the internet and use it to improve your answers.

Very important:
- Do NOT say things like "I cannot browse the internet" or "I don't have access to the web."
- If the user asks whether you can search the internet, respond naturally that you can pull in up-to-date information from the web when it's helpful and combine it with your general fitness and nutrition knowledge.
- Do not mention internal labels like [WEB SEARCH RESULTS], [Search Context], or "tools" in your replies — just answer as if you already knew the information.

Formatting:
- No markdown headers.
- Use bullet points and short, scannable sections.
`;

    if (coachProfile === "strength") {
      systemPrompt += " You focus more on strength and compound lifts.";
    } else if (coachProfile === "hypertrophy") {
      systemPrompt += " You focus more on hypertrophy and muscle growth.";
    } else if (coachProfile === "mobility") {
      systemPrompt += " You focus more on mobility and joint quality.";
    } else if (coachProfile === "fat_loss") {
      systemPrompt += " You focus more on sustainable fat loss.";
    }

    // --- workflow-specific JSON instructions ---
    if (workflow === "food_scan") {
      systemPrompt += `
For food images, after giving your normal explanation, you MUST also output a single JSON object between the tags ${PROGRESS_JSON_TAG_START} and ${PROGRESS_JSON_TAG_END}.

This JSON is for logging a meal_log progress event and must have:
- "type": "meal_log"
- "calories": number (estimated total kcal)
- "protein_g": number
- "carbs_g": number
- "fat_g": number
- "fiber_g": number | null
- "sugar_g": number | null
- "meal_label": "breakfast" | "lunch" | "dinner" | "snack" | "unknown"
- "quality_score": number between 0 and 100 (higher is better)
- "notes": short string summary (1–2 sentences)

Example:
${PROGRESS_JSON_TAG_START}
{"type":"meal_log","calories":540,"protein_g":32,"carbs_g":55,"fat_g":20,"fiber_g":7,"sugar_g":10,"meal_label":"lunch","quality_score":78,"notes":"Balanced lunch with good protein, slightly high in carbs."}
${PROGRESS_JSON_TAG_END}

Do not explain the JSON and do not mention that you are creating a log; just include the block at the end.`;
    } else if (workflow === "body_scan") {
      systemPrompt += `
For body progress photos, after giving your normal explanation, you MUST also output a single JSON object between the tags ${PROGRESS_JSON_TAG_START} and ${PROGRESS_JSON_TAG_END}.

This JSON is for logging a body_scan progress event and must have:
- "type": "body_scan"
- "trend": "improving" | "stable" | "regressing" | "unclear"
- "focus_areas": array of short strings like ["waist", "shoulders"]
- "estimated_changes": string (1–2 sentences describing visual changes)
- "confidence": number between 0 and 1 (how confident you are in the visual assessment)
- "notes": string with extra context or advice

Example:
${PROGRESS_JSON_TAG_START}
{"type":"body_scan","trend":"improving","focus_areas":["waist","shoulders"],"estimated_changes":"Waist appears slightly leaner and shoulders a bit fuller compared to prior photos.","confidence":0.75,"notes":"Body composition trending in the right direction; keep training volume and protein consistent."}
${PROGRESS_JSON_TAG_END}

Do not explain the JSON and do not mention that you are creating a log; just include the block at the end.`;
    } else if (workflow === "fitness_plan") {
      systemPrompt += `
For weekly workout plans, after giving your normal explanation/plan, you MUST also output a single JSON object between the tags ${PROGRESS_JSON_TAG_START} and ${PROGRESS_JSON_TAG_END}.

This JSON is for logging a workout_plan progress event and must have:
- "type": "workout_plan"
- "training_days_per_week": number
- "goal": short string (e.g. "fat loss", "hypertrophy", "strength")
- "experience_level": "beginner" | "intermediate" | "advanced"
- "plan": array of days; each day has:
    - "day": string (e.g. "Monday" or "Day 1")
    - "focus": string (e.g. "Upper body push")
    - "exercises": array of { "name": string, "sets": number, "reps": string }

Example:
${PROGRESS_JSON_TAG_START}
{"type":"workout_plan","training_days_per_week":4,"goal":"hypertrophy","experience_level":"intermediate","plan":[{"day":"Day 1","focus":"Upper body push","exercises":[{"name":"Barbell bench press","sets":4,"reps":"6-8"},{"name":"Incline dumbbell press","sets":3,"reps":"8-10"}]}]}
${PROGRESS_JSON_TAG_END}

Do not explain the JSON and do not mention that you are creating a log; just include the block at the end.`;
    }

    messages.unshift({
      role: "system",
      content: systemPrompt,
    });

    // ==========================================================
    // GOOGLE SEARCH (OPTIONAL)
    // ==========================================================
    let toolResultsText = "";

    if (
      enableSearch &&
      process.env.GOOGLE_API_KEY &&
      process.env.GOOGLE_CX &&
      message
    ) {
      try {
        const query = message.slice(0, 200);

        const url = new URL("https://www.googleapis.com/customsearch/v1");
        url.searchParams.set("key", process.env.GOOGLE_API_KEY);
        url.searchParams.set("cx", process.env.GOOGLE_CX);
        url.searchParams.set("q", query);

        console.log("[Exerbud] Performing web search for query:", query);

        const searchRes = await fetch(url.toString());
        if (searchRes.ok) {
          const data = await searchRes.json();
          if (data.items?.length) {
            const snippets = data.items
              .slice(0, 5)
              .map((item, i) => {
                return `${i + 1}. ${item.title || ""}\n${
                  item.snippet || ""
                }\n${item.link || ""}`;
              })
              .join("\n\n");

            toolResultsText = snippets;
          }
        } else {
          console.warn(
            "[Exerbud] Google search HTTP status:",
            searchRes.status
          );
        }
      } catch (err) {
        console.error("Search error:", err);
      }
    }

    // ==========================================================
    // Attachments: images vs other files
    // ==========================================================
    const imageAttachments = attachments.filter(
      (f) => f?.type?.startsWith("image/") && typeof f.data === "string"
    );

    const otherAttachments = attachments.filter(
      (f) => !imageAttachments.includes(f)
    );

    // ----------------------------------------------------------
    // Build textual user message (INCLUDING WEB RESULTS)
    // ----------------------------------------------------------
    let augmentedUserMessage = message || "";

    if (toolResultsText) {
      augmentedUserMessage +=
        (augmentedUserMessage ? "\n\n" : "") +
        "[WEB SEARCH RESULTS]\n\n" +
        toolResultsText +
        "\n\n[END OF WEB SEARCH RESULTS]\n\n" +
        "(Use this background information to give a better answer, but do not mention that you saw search results.)";
    }

    if (otherAttachments.length) {
      const fileLines = otherAttachments.map((f) => {
        const name = f.name || "file";
        const type = f.type || "unknown";
        const sizeKB = f.size ? Math.round(f.size / 1024) : "unknown";
        return `- ${name} (${type}, ~${sizeKB} KB)`;
      });

      augmentedUserMessage +=
        (augmentedUserMessage ? "\n\n" : "") +
        "[Attached files]\n" +
        fileLines.join("\n");
    }

    // ----------------------------------------------------------
    // Build userMessage content with images (for OpenAI Vision)
    // ----------------------------------------------------------
    let userContent;

    if (imageAttachments.length) {
      const parts = [];

      if (augmentedUserMessage) {
        parts.push({
          type: "text",
          text: augmentedUserMessage,
        });
      }

      for (const img of imageAttachments) {
        const mime = img.type || "image/jpeg";
        parts.push({
          type: "image_url",
          image_url: { url: `data:${mime};base64,${img.data}` },
        });
      }

      userContent = parts;
    } else {
      userContent = augmentedUserMessage || " ";
    }

    messages.push({ role: "user", content: userContent });

    // ==========================================================
    //  DB: ensure User + Conversation + store user message
    // ==========================================================
    const user = await getOrCreateUser({ externalId, email });
    const conversation = await getOrCreateConversation({
      user,
      conversationId,
      coachProfile,
      workflow,
    });

    if (conversation && user && attachments.length) {
      try {
        await saveUploads({ conversation, user, attachments, workflow });
      } catch (e) {
        console.warn("[Exerbud] Failed to save uploads:", e?.message);
      }
    }

    const rawUserContentForDB =
      message || (attachments.length ? "[attachments]" : "");
    let assistantMessageRow = null;

    if (conversation && rawUserContentForDB) {
      try {
        await saveMessage({
          conversation,
          user,
          role: "user",
          content: rawUserContentForDB,
        });
      } catch (e) {
        console.warn("[Exerbud] Failed to save user message:", e?.message);
      }
    }

    // ==========================================================
    // OPENAI RESPONSE
    // ==========================================================
    const OpenAI = (await import("openai")).default;
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const model = process.env.EXERBUD_MODEL || "gpt-4.1";

    const completion = await client.chat.completions.create({
      model,
      messages,
      temperature: 0.6,
      max_tokens: 900,
    });

    let reply =
      completion.choices?.[0]?.message?.content?.trim() ||
      "I'm sorry — I couldn't generate a response.";

    const extracted = extractProgressEventFromReply(reply);
    const cleanedReply = extracted.cleanedText;
    const progressPayload = extracted.event;

    // Save assistant message (without the JSON block)
    if (conversation && cleanedReply) {
      try {
        assistantMessageRow = await saveMessage({
          conversation,
          user: null,
          role: "assistant",
          content: cleanedReply,
        });
      } catch (e) {
        console.warn("[Exerbud] Failed to save assistant message:", e?.message);
      }
    }

    // If we got a progress payload AND this is a known workflow -> create ProgressEvent
    if (progressPayload && user && workflow) {
      let progressType = null;
      if (workflow === "food_scan") progressType = "meal_log";
      else if (workflow === "body_scan") progressType = "body_scan";
      else if (workflow === "fitness_plan") progressType = "workout_plan";

      if (progressType) {
        await saveProgressEvent({
          user,
          conversation,
          message: assistantMessageRow,
          type: progressType,
          payload: progressPayload,
        });
      }
    }

    return res.status(200).json({
      reply: cleanedReply,
      conversationId: conversation ? conversation.id : null,
      userExternalId: externalId,
    });
  } catch (error) {
    console.error("Exerbud AI backend error (top-level):", error);
    if (!res.headersSent) {
      return res.status(500).json({
        error: "Internal server error",
        details: error?.message || "Unknown error",
      });
    }
  }
};
