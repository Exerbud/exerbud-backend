// ======================================================================
// EXERBUD AI — NON-STREAMING BACKEND WITH DB "MEMORY"
// - CORS + GET healthcheck
// - PDF Export (centered logo)
// - Vision support via attachments (image_url)
// - Prisma persistence: Users / Conversations / Messages / Uploads
// - Lightweight memory: last messages per user injected into prompt
// - NO Google search
// ======================================================================

const { randomUUID } = require("crypto");
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

// ----------------------------------------------
// DB helpers
// ----------------------------------------------

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

async function getOrCreateConversation({ user, conversationId, coachProfile, workflow }) {
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
 * Load lightweight "memory" for this user:
 * last ~20 messages across conversations, turned into short text lines.
 */
async function loadUserMemory(user) {
  if (!user) return "";

  try {
    const db = getPrisma();

    const msgs = await db.message.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      take: 20,
    });

    if (!msgs.length) return "";

    const lines = msgs
      .reverse() // oldest first
      .map((m) => {
        const who = m.role === "assistant" ? "Coach" : "User";
        const text = (m.content || "").replace(/\s+/g, " ").slice(0, 200);
        return `${who}: ${text}`;
      });

    return lines.join("\n");
  } catch (err) {
    console.warn("[Exerbud] Failed to load user memory:", err?.message);
    return "";
  }
}

// ----------------------------------------------
// Main handler
// ----------------------------------------------

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

    // Simple GET healthcheck
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

    // Ensure Prisma can init inside try/catch
    getPrisma();

    // ------------------------------------------------------------------
    // Body parsing (Vercel may give string)
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

    const conversationIdFromClient = body.conversationId || null;
    const rawExternalId =
      body.userExternalId || body.externalId || null;
    const email = body.userEmail || body.email || null;

    // stable externalId used for DB User row
    const externalId =
      rawExternalId ||
      `guest:${body.clientId || body.sessionId || randomUUID().toString().slice(0, 12)}`;

    if (!message && !attachments.length) {
      return res.status(400).json({ error: "Missing message" });
    }

    // ------------------------------------------------------------------
    // DB: User + Conversation + attachments
    // ------------------------------------------------------------------
    const user = await getOrCreateUser({ externalId, email });
    const conversation = await getOrCreateConversation({
      user,
      conversationId: conversationIdFromClient,
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

    // ------------------------------------------------------------------
    // Format history for OpenAI
    // ------------------------------------------------------------------
    const formattedHistory = history.map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: (m.content || "").toString(),
    }));

    // ------------------------------------------------------------------
    // Load DB "memory" and build system prompt
    // ------------------------------------------------------------------
    const memoryContext = await loadUserMemory(user);

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

    if (memoryContext) {
      systemPrompt += `

Here is prior history for this user from previous sessions (messages from both you and the user). Use it to maintain continuity, remember preferences, and reference earlier advice — but do NOT mention databases, storage, or that this was loaded from "memory":

${memoryContext}
`;
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
    // Save user message (for memory) before calling OpenAI
    // ------------------------------------------------------------------
    const rawUserContentForDB =
      message || (attachments.length ? "[attachments]" : "");

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

    const replyText =
      completion.choices?.[0]?.message?.content?.trim() ||
      "I'm sorry — I couldn't generate a response.";

    // Save assistant reply (without any extra processing)
    if (conversation && replyText) {
      try {
        await saveMessage({
          conversation,
          user: null,
          role: "assistant",
          content: replyText,
        });
      } catch (e) {
        console.warn("[Exerbud] Failed to save assistant message:", e?.message);
      }
    }

    return res.status(200).json({
      reply: replyText,
      conversationId: conversation ? conversation.id : conversationIdFromClient || randomUUID(),
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
