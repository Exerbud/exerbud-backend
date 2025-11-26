// ======================================================================
// EXERBUD AI — NON-STREAMING BACKEND
// - Google Search (optional)
// - PDF Export (with centered logo, no visible title text)
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

  // Only POST allowed
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
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
          const logoBuffer = await logoRes.buffer();

          // Measure the page
          const pageWidth = doc.page.width;

          // Desired rendered width
          const renderWidth = 90; // adjust if needed (80–120 recommended)
          const image = doc.openImage(logoBuffer);

          const scale = renderWidth / image.width;
          const renderHeight = image.height * scale;

          const x = (pageWidth - renderWidth) / 2; // <-- CENTERED
          const y = 30; // top margin

          doc.image(logoBuffer, x, y, {
            width: renderWidth,
            height: renderHeight,
          });

          // Add space below logo
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

    if (!message && !attachments.length) {
      return res.status(400).json({ error: "Missing message" });
    }

    // ----------------------------------------------------------
    // Prepare formatted history
    // ----------------------------------------------------------
    const formattedHistory = history.map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: (m.content || "").toString().slice(0, 4000),
    }));

    const messages = [...formattedHistory];

    // ----------------------------------------------------------
    // SYSTEM PROMPT
    // ----------------------------------------------------------
    let systemPrompt =
      "You are Exerbud, a helpful fitness and strength training coach. " +
      "Give clear, practical, sustainable advice. Avoid markdown headings (#). " +
      "Bullet points and short paragraphs only.";

    if (coachProfile === "strength") {
      systemPrompt += " You focus on strength and compound lifts.";
    } else if (coachProfile === "hypertrophy") {
      systemPrompt += " You focus on hypertrophy and muscle growth.";
    } else if (coachProfile === "mobility") {
      systemPrompt += " You focus on mobility and joint quality.";
    } else if (coachProfile === "fat_loss") {
      systemPrompt += " You focus on sustainable fat loss.";
    }

    messages.unshift({
      role: "system",
      content:
        systemPrompt +
        " Keep formatting clean and readable. No markdown headers.",
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

            toolResultsText =
              "Search results:\n\n" +
              snippets +
              "\n\nUse this only as context for better answers. Do not mention them directly.";
          }
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
    // Build textual user message
    // ----------------------------------------------------------
    let augmentedUserMessage = message || "";

    if (toolResultsText) {
      augmentedUserMessage +=
        (augmentedUserMessage ? "\n\n" : "") +
        "[Search Context]\n\n" +
        toolResultsText +
        "\n\n(Do not mention this context explicitly.)";
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
    // Build userMessage content with images
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

    const reply =
      completion.choices?.[0]?.message?.content?.trim() ||
      "I'm sorry — I couldn't generate a response.";

    return res.status(200).json({ reply });
  } catch (error) {
    console.error("Exerbud AI backend error:", error);
    return res.status(500).json({
      error: "Internal server error",
      details: error?.message || "Unknown error",
    });
  }
};
