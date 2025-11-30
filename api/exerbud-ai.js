// ======================================================================
// EXERBUD AI — BACKEND WITH OPTIONAL PRISMA MEMORY
// - CORS + GET healthcheck
// - PDF Export (centered logo)
// - Vision support via attachments (image_url)
// - Optional Prisma/Postgres logging (Users, Conversations, Messages)
//   -> If Prisma or DB fails, we log a warning and continue without DB.
// ======================================================================

const { randomUUID } = require("crypto");

// Logo URL for PDF header (optional)
const EXERBUD_LOGO_URL =
  "https://cdn.shopify.com/s/files/1/0731/9882/9803/files/exerbudfulllogotransparentcircle.png?v=1734438468";

// ------------------------------------------------------------------
// Optional Prisma wiring (SAFE)
// ------------------------------------------------------------------
let prisma = null;
let prismaInitTried = false;

function getPrismaSafe() {
  if (prismaInitTried) return prisma;
  prismaInitTried = true;
  try {
    // Require inside try so a bad install/env doesn't crash
    const { PrismaClient } = require("@prisma/client");
    prisma = new PrismaClient();
    console.log("[Exerbud] Prisma client initialized");
  } catch (err) {
    console.warn(
      "[Exerbud] Prisma unavailable, running WITHOUT DB memory:",
      err?.message || err
    );
    prisma = null;
  }
  return prisma;
}

// Get or create user
async function getOrCreateUserSafe({ externalId, email }) {
  const db = getPrismaSafe();
  if (!db || !externalId) return null;

  try {
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
  } catch (err) {
    console.warn("[Exerbud] getOrCreateUserSafe failed:", err?.message || err);
    return null;
  }
}

// Get or create conversation
async function getOrCreateConversationSafe({
  user,
  conversationId,
  coachProfile,
  workflow,
}) {
  const db = getPrismaSafe();
  if (!db || !user) return null;

  try {
    if (conversationId) {
      const existing = await db.conversation.findUnique({
        where: { id: conversationId },
      });
      if (existing) return existing;
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
  } catch (err) {
    console.warn(
      "[Exerbud] getOrCreateConversationSafe failed:",
      err?.message || err
    );
    return null;
  }
}

// Save a message row
async function saveMessageSafe({ conversation, user, role, content }) {
  const db = getPrismaSafe();
  if (!db || !conversation || !role || !content) return null;

  try {
    const msg = await db.message.create({
      data: {
        conversationId: conversation.id,
        userId: user ? user.id : null,
        role,
        content,
      },
    });
    return msg;
  } catch (err) {
    console.warn("[Exerbud] saveMessageSafe failed:", err?.message || err);
    return null;
  }
}

// ======================================================================
// Main handler
// ======================================================================
module.exports = async function handler(req, res) {
  // --- CORS (for Shopify widget) ---
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  try {
    // Preflight
    if (req.method === "OPTIONS") {
      return res.status(200).end();
    }

    // Simple GET healthcheck so hitting the URL in a browser works
    if (req.method === "GET") {
      return res.status(200).json({
        ok: true,
        message: "Exerbud AI backend is alive",
      });
    }

    if (req.method !== "POST") {
      res.setHeader("Allow", "GET, POST, OPTIONS");
      return res.status(405).json({ error: "Method not allowed" });
    }

    // ------------------------------------------------------------------
    // Body parsing (Vercel may give a string)
    // ------------------------------------------------------------------
    let body = req.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        body = {};
      }
    }
    body = body || {};

    // ------------------------------------------------------------------
    // PDF EXPORT MODE
    // ------------------------------------------------------------------
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

      // ---- Centered logo header (best-effort) ----
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

      // ---- Simple text body ----
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

    // ------------------------------------------------------------------
    // NORMAL CHAT REQUEST
    // ------------------------------------------------------------------
    const message = (body.message || "").toString().trim();
    const history = Array.isArray(body.history) ? body.history : [];
    const attachments = Array.isArray(body.attachments)
      ? body.attachments
      : [];

    const coachProfile = body.coachProfile || null;
    const workflow = body.workflow || null; // food_scan | body_scan | fitness_plan | null

    // Identity hints
    const incomingConversationId = body.conversationId || null;
    const incomingExternalId = body.userExternalId || body.externalId || null;
    const email = body.userEmail || body.email || null;

    // Always have *some* external ID, even if guest
    const externalId =
      incomingExternalId || `guest:${randomUUID().slice(0, 12)}`;

    if (!message && !attachments.length) {
      return res.status(400).json({ error: "Missing message" });
    }

    // ------------------------------------------------------------------
    // Format history for OpenAI (strip timestamps etc.)
    // ------------------------------------------------------------------
    const formattedHistory = history.map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: (m.content || "").toString(),
    }));

    // ------------------------------------------------------------------
    // System prompt (light coach style hints)
    // ------------------------------------------------------------------
    let systemPrompt = `
You are Exerbud AI, an expert fitness, strength, hypertrophy, mobility, and nutrition coach embedded on the Exerbud website.

General behavior:
- Give clear, practical, sustainable advice.
- Prefer short paragraphs and bullet points.
- Keep tone friendly and encouraging.
- Avoid markdown headings like "#", just use plain text and bullets.
    `.trim();

    if (coachProfile === "strength") {
      systemPrompt += " You focus more on strength training and compound lifts.";
    } else if (coachProfile === "hypertrophy") {
      systemPrompt += " You focus more on hypertrophy and muscle growth.";
    } else if (coachProfile === "mobility") {
      systemPrompt += " You focus more on mobility and joint quality.";
    } else if (coachProfile === "fat_loss") {
      systemPrompt += " You focus more on sustainable fat loss.";
    }

    const messages = [
      { role: "system", content: systemPrompt },
      ...formattedHistory,
    ];

    // ------------------------------------------------------------------
    // Attachments → Vision-compatible content
    // ------------------------------------------------------------------
    const imageAttachments = attachments.filter(
      (f) => f?.type?.startsWith("image/") && typeof f.data === "string"
    );
    const otherAttachments = attachments.filter(
      (f) => !imageAttachments.includes(f)
    );

    let augmentedUserMessage = message || "";

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

    let userContent;

    if (imageAttachments.length) {
      const parts = [];

      if (augmentedUserMessage) {
        parts.push({ type: "text", text: augmentedUserMessage });
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

    // ------------------------------------------------------------------
    // OPTIONAL DB: user + conversation + store user message
    // ------------------------------------------------------------------
    const user = await getOrCreateUserSafe({ externalId, email });
    const conversation = await getOrCreateConversationSafe({
      user,
      conversationId: incomingConversationId,
      coachProfile,
      workflow,
    });

    const rawUserContentForDB =
      message || (attachments.length ? "[attachments]" : "");

    if (conversation && rawUserContentForDB) {
      await saveMessageSafe({
        conversation,
        user,
        role: "user",
        content: rawUserContentForDB,
      });
    }

    // ------------------------------------------------------------------
    // OpenAI call
    // ------------------------------------------------------------------
    const OpenAI = (await import("openai")).default;
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const model = process.env.EXERBUD_MODEL || "gpt-4.1";

    const completion = await client.chat.completions.create({
      model,
      messages,
      temperature: 0.6,
      max_tokens: 900,
    });

    const reply =
      completion.choices?.[0]?.message?.content?.trim() ||
      "I'm sorry — I couldn't generate a response.";

    // Save assistant message (if DB available)
    if (conversation && reply) {
      await saveMessageSafe({
        conversation,
        user: null,
        role: "assistant",
        content: reply,
      });
    }

    return res.status(200).json({
      reply,
      conversationId: conversation
        ? conversation.id
        : incomingConversationId || randomUUID(),
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
