// ======================================================================
// EXERBUD AI — BACKEND WITH OPTIONAL PRISMA MEMORY
// - CORS + GET healthcheck
// - PDF Export (centered logo)
// - Vision support via attachments (image_url)
// - Optional Prisma persistence for Users / Conversations / Messages
//   + Uploads + ProgressEvent for dashboard stats
// ======================================================================

const { randomUUID } = require("crypto");

// Logo URL for PDF header (optional)
const EXERBUD_LOGO_URL =
  "https://cdn.shopify.com/s/files/1/0731/9882/9803/files/exerbudfulllogotransparentcircle.png?v=1734438468";

// ----------------------------------------------------------------------
// Prisma client (optional)
// ----------------------------------------------------------------------
let prisma = null;
try {
  const { PrismaClient } = require("@prisma/client");
  prisma = new PrismaClient();
  console.log("[Exerbud] Prisma client loaded in /api/exerbud-ai");
} catch (err) {
  console.error(
    "[Exerbud] Failed to load PrismaClient in /api/exerbud-ai:",
    err && err.message ? err.message : err
  );
  prisma = null;
}

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

    let conversationId = body.conversationId || null;
    let userExternalId = body.userExternalId || null;
    const userEmail = body.userEmail || null;

    if (!message && !attachments.length) {
      return res.status(400).json({ error: "Missing message" });
    }

    // Ensure we always have some external ID, even if frontend forgot
    if (!userExternalId) {
      userExternalId = `guest:${randomUUID()}`;
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

    // ------------------------------------------------------------------
    // OPTIONAL: Persist to Postgres via Prisma
    // ------------------------------------------------------------------
    const finalConversationId = conversationId || randomUUID();
    const finalUserExternalId = userExternalId || `guest:${randomUUID()}`;

    // will be used in the response so frontend can jump to this reply
    let lastUserMessageId = null;
    let lastAssistantMessageId = null;

    if (!prisma) {
      console.log(
        "[Exerbud] Skipping DB save: prisma is null in /api/exerbud-ai"
      );
    } else if (!process.env.DATABASE_URL) {
      console.log(
        "[Exerbud] Skipping DB save: DATABASE_URL is missing in environment"
      );
    } else {
      try {
        // 1) Upsert user
        const user = await prisma.user.upsert({
          where: { externalId: finalUserExternalId },
          update: {
            email: userEmail || undefined,
          },
          create: {
            externalId: finalUserExternalId,
            email: userEmail || null,
          },
        });

        // 2) Upsert conversation
        await prisma.conversation.upsert({
          where: { id: finalConversationId },
          update: {
            userId: user.id,
            coachProfile: coachProfile || null,
            workflow: workflow || null,
          },
          create: {
            id: finalConversationId,
            userId: user.id,
            source: "shopify_widget",
            coachProfile: coachProfile || null,
            workflow: workflow || null,
          },
        });

        // 3) Insert messages (user + assistant) and capture IDs
        if (message || attachments.length) {
          const userContentForDb =
            message ||
            (attachments.length ? "[attachments]" : "[empty message]");

          const userMsg = await prisma.message.create({
            data: {
              conversationId: finalConversationId,
              userId: user.id,
              role: "user",
              content: userContentForDb,
            },
          });

          lastUserMessageId = userMsg.id;
        }

        const assistantMsg = await prisma.message.create({
          data: {
            conversationId: finalConversationId,
            userId: null,
            role: "assistant",
            content: reply,
          },
        });

        lastAssistantMessageId = assistantMsg.id;

        // 4) NEW: Save uploads for dashboard grid
        if (attachments.length) {
          const uploadData = attachments.map((file) => {
            const mime = file.type || "application/octet-stream";
            // store as data URL so the dashboard can display it directly
            const url =
              file.data && typeof file.data === "string"
                ? `data:${mime};base64,${file.data}`
                : file.url || "";

            return {
              userId: user.id,
              conversationId: finalConversationId,
              url,
              type: mime,
              workflow: workflow || null,
            };
          });

          // createMany ignores extra fields like id/createdAt, Prisma fills them
          await prisma.upload.createMany({ data: uploadData });

          console.log(
            "[Exerbud] Saved",
            uploadData.length,
            "uploads for user",
            user.id
          );
        }

        // 5) NEW: Progress events for weekly stats
        const progressTypeMap = {
          food_scan: "meal_log",
          body_scan: "body_scan",
          fitness_plan: "workout_plan",
        };

        const progressType = progressTypeMap[workflow];

        if (progressType) {
          await prisma.progressEvent.create({
            data: {
              userId: user.id,
              conversationId: finalConversationId,
              messageId: assistantMsg.id,
              type: progressType,
              // For now we just store metadata; stats code will still count events,
              // and calories will default to 0 until we add structured parsing.
              payload: {
                workflow,
                source: "exerbud-ai",
                attachmentsCount: attachments.length,
              },
            },
          });

          console.log(
            "[Exerbud] Created progress event",
            progressType,
            "for user",
            user.id
          );
        }

        console.log(
          "[Exerbud] Saved messages to DB for conversation",
          finalConversationId,
          "assistant message id:",
          lastAssistantMessageId
        );
      } catch (err) {
        console.error(
          "[Exerbud] Failed to persist chat / uploads / progress to DB:",
          err && err.message ? err.message : err
        );
      }
    }

    // ------------------------------------------------------------------
    // Normal HTTP response
    // ------------------------------------------------------------------
    return res.status(200).json({
      reply,
      conversationId: finalConversationId,
      userExternalId: finalUserExternalId,
      // new fields for frontend deep-linking
      messageId: lastAssistantMessageId,
      userMessageId: lastUserMessageId,
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
