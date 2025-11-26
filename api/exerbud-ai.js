// ======================================================================
// EXERBUD AI — NON-STREAMING BACKEND
// - Google Search (optional)
// - PDF Export (with logo, no visible title text)
// - Vision support via attachments (image_url)
// ======================================================================

const fetch = require("node-fetch");

// Logo URL for PDF header
const EXERBUD_LOGO_URL =
  "https://cdn.shopify.com/s/files/1/0731/9882/9803/files/exerbudfulllogotransparentcircle.png?v=1734438468";

// ----------------------------------------------
// Main handler (WITH CORS)
// ----------------------------------------------
module.exports = async function handler(req, res) {
  //
  // --- GLOBAL CORS HEADERS (REQUIRED FOR SHOPIFY) ---
  //
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  // Preflight
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // Only POST allowed for real operations
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const body = req.body || {};

    // ==========================================================
    //  PDF EXPORT MODE (UPDATED: LOGO + NO VISIBLE TITLE TEXT)
    // ==========================================================
    if (body.pdfExport) {
      const planText = body.planText || "Your workout plan";
      // We ignore body.planTitle for PDF content, and we don't show
      // "Exerbud workout plan" anywhere inside the PDF.

      const PDFDocument = require("pdfkit");
      const doc = new PDFDocument({ margin: 40 });

      // Fixed filename so "Exerbud workout plan" doesn't appear there either
      const filename = "exerbud-plan.pdf";

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${filename}"`
      );

      // Pipe PDF stream to response
      doc.pipe(res);

      // Try to fetch and draw the logo at the top (centered)
      try {
        const logoRes = await fetch(EXERBUD_LOGO_URL);
        if (logoRes.ok) {
          const logoBuffer = await logoRes.buffer();

          // Draw logo at the top, centered, with a reasonable size
          doc.image(logoBuffer, {
            fit: [80, 80],
            align: "center",
            valign: "top",
          });

          // Add some vertical space after the logo
          doc.moveDown(2);
        }
      } catch (logoErr) {
        console.error("PDF logo fetch/embedding error:", logoErr);
        // If logo fails, just continue with text — no title text either.
        doc.moveDown(1);
      }

      // Now write the plan text only (no big title)
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

    // Allow bare-image messages (no text) as long as we have attachments
    if (!message && !attachments.length) {
      return res.status(400).json({ error: "Missing message" });
    }

    // ----------------------------------------------------------
    // Prepare conversation history
    // ----------------------------------------------------------
    const formattedHistory = history.map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: (m.content || "").toString().slice(0, 4000),
    }));

    const messages = [...formattedHistory];

    // ----------------------------------------------------------
    // SYSTEM PROMPT (with coach profile)
    // ----------------------------------------------------------
    let systemPrompt =
      "You are Exerbud, a helpful fitness and strength training coach. " +
      "Give clear, practical, sustainable advice. Avoid markdown headings (#). " +
      "Bullet points are okay. Keep formatting clean and readable.";

    if (coachProfile === "strength") {
      systemPrompt += " You focus on strength training and compound lifts.";
    } else if (coachProfile === "hypertrophy") {
      systemPrompt +=
        " You focus on hypertrophy and muscle-building programming.";
    } else if (coachProfile === "mobility") {
      systemPrompt +=
        " You focus on mobility, joint health, and pain-free movement.";
    } else if (coachProfile === "fat_loss") {
      systemPrompt +=
        " You focus on sustainable fat loss while preserving muscle.";
    }

    messages.unshift({
      role: "system",
      content:
        systemPrompt +
        " If you produce workout schedules, format them cleanly using plain text and bullet points. No markdown headers.",
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

        const searchRes = await fetch(url.toString());
        if (searchRes.ok) {
          const searchData = await searchRes.json();
          if (searchData.items?.length) {
            const snippets = searchData.items
              .slice(0, 5)
              .map((item, i) => {
                const title = item.title || "";
                const snippet = item.snippet || "";
                const link = item.link || "";
                return `${i + 1}. ${title}\n${snippet}\n${link}`;
              })
              .join("\n\n");

            toolResultsText =
              "Search results:\n\n" +
              snippets +
              "\n\nUse this as context, but write your answer naturally. Do not explicitly mention these results.";
          }
        }
      } catch (err) {
        console.error("Google Search Error:", err);
      }
    }

    // ==========================================================
    // Attachments: split image vs other
    // ==========================================================
    const imageAttachments = attachments.filter(
      (f) =>
        f &&
        typeof f === "object" &&
        f.data &&
        typeof f.data === "string" &&
        f.type &&
        typeof f.type === "string" &&
        f.type.startsWith("image/")
    );

    const otherAttachments = attachments.filter(
      (f) => !imageAttachments.includes(f)
    );

    // ----------------------------------------------------------
    // Build augmented user message (text)
    // ----------------------------------------------------------
    let augmentedUserMessage = message || "";

    if (toolResultsText) {
      augmentedUserMessage +=
        (augmentedUserMessage ? "\n\n" : "") +
        "[Search Context]\n\n" +
        toolResultsText +
        "\n\n(Do not mention this bracketed text explicitly.)";
    }

    if (otherAttachments.length) {
      const fileLines = otherAttachments.map((f) => {
        const name = (f && f.name) || "file";
        const type = (f && f.type) || "unknown";
        const sizeKB =
          f && typeof f.size === "number"
            ? Math.round(f.size / 1024)
            : "unknown";
        return `- ${name} (${type}, ~${sizeKB} KB)`;
      });

      augmentedUserMessage +=
        (augmentedUserMessage ? "\n\n" : "") +
        "[Attached files]\n" +
        fileLines.join("\n");
    }

    // ----------------------------------------------------------
    // Build user content (text + optional images)
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
        const base64 = img.data;
        parts.push({
          type: "image_url",
          image_url: {
            url: `data:${mime};base64,${base64}`,
          },
        });
      }

      userContent = parts;
    } else {
      // No images → plain text message
      userContent = augmentedUserMessage || " ";
    }

    messages.push({
      role: "user",
      content: userContent,
    });

    // ==========================================================
    // OPENAI COMPLETION (VISION-CAPABLE MODEL)
    // ==========================================================
    const OpenAI = (await import("openai")).default;

    const client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });

    const model = process.env.EXERBUD_MODEL || "gpt-4.1";

    const completion = await client.chat.completions.create({
      model,
      messages,
      temperature: 0.6,
      max_tokens: 900,
    });

    const reply =
      completion.choices?.[0]?.message?.content?.trim() ||
      "I’m sorry — I wasn’t able to generate a response.";

    return res.status(200).json({ reply });
  } catch (error) {
    console.error("Exerbud AI backend error:", error);
    return res.status(500).json({
      error: "Internal server error",
      details: error?.message || "Unknown error",
    });
  }
};
