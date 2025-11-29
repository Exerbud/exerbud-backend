// ======================================================================
// EXERBUD AI — NON-STREAMING BACKEND
// - Google Search (optional)
// - PDF Export (with centered logo, no visible title text)
// - Vision support via attachments (image_url)
// - User Identity (Shopify → Backend)
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

      // --- Centered Logo ---
      try {
        const logoRes = await fetch(EXERBUD_LOGO_URL);
        if (logoRes.ok) {
          const buf = await logoRes.buffer();
          const pageWidth = doc.page.width;
          const desiredWidth = 90;
          const img = doc.openImage(buf);
          const scale = desiredWidth / img.width;
          const renderedHeight = img.height * scale;
          const x = (pageWidth - desiredWidth) / 2;
          const y = 30;

          doc.image(buf, x, y, { width: desiredWidth, height: renderedHeight });
          doc.moveDown(4);
        }
      } catch (err) {
        console.error("Error embedding PDF logo:", err);
        doc.moveDown(1);
      }

      // --- Body text ---
      doc.fontSize(12);
      const paragraphs = String(planText).split(/\n{2,}/);

      paragraphs.forEach((p, i) => {
        const clean = p.trim();
        if (!clean) return;
        doc.text(clean);
        if (i < paragraphs.length - 1) doc.moveDown();
      });

      doc.end();
      return;
    }

    // ==========================================================
    //  NORMAL CHAT REQUEST
    // ==========================================================
    const message = (body.message || "").trim();
    const history = Array.isArray(body.history) ? body.history : [];
    const attachments = Array.isArray(body.attachments) ? body.attachments : [];
    const enableSearch = Boolean(body.enableSearch);
    const coachProfile = body.coachProfile || null;

    // 👉 NEW: User identity forwarded from frontend
    const userId = body.userId || null;
    const userEmail = body.userEmail || null;

    console.log("[Exerbud] Request from:", { userId, userEmail });

    if (!message && !attachments.length) {
      return res.status(400).json({ error: "Missing message" });
    }

    // ----------------------------------------------------------
    // Prepare formatted history for OpenAI
    // ----------------------------------------------------------
    const formattedHistory = history.map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: String(m.content || "").slice(0, 4000),
    }));

    const messages = [...formattedHistory];

    // ----------------------------------------------------------
    // SYSTEM PROMPT (improved)
    // ----------------------------------------------------------
    let systemPrompt = `
You are Exerbud AI — an expert fitness, strength, hypertrophy, mobility, and nutrition coach.

RULES:
- You always respond in clear, practical, friendly language.
- Use short paragraphs and bullet points.
- No markdown headers (“# Title”).
- You *can* incorporate information from web search results.
- You *never* say “I cannot browse the internet.”
- You *never* mention [WEB SEARCH RESULTS] or internal formatting.
- You behave consistently across sessions, especially for known users.
`;

    if (coachProfile === "strength") systemPrompt += " Coaching mode: Strength focus.";
    else if (coachProfile === "hypertrophy") systemPrompt += " Coaching mode: Muscle growth focus.";
    else if (coachProfile === "mobility") systemPrompt += " Coaching mode: Mobility & movement quality.";
    else if (coachProfile === "fat_loss") systemPrompt += " Coaching mode: Sustainable fat loss.";

    // 👉 NEW: User identity awareness
    if (userId) {
      systemPrompt += ` You are speaking to the same returning user: ${userId}. Maintain consistency and support long-term tracking.`;
    } else {
      systemPrompt += " This may be a guest user with no persistent identity.";
    }

    messages.unshift({ role: "system", content: systemPrompt });

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

        console.log("[Exerbud] Searching:", query);

        const searchRes = await fetch(url.toString());

        if (searchRes.ok) {
          const data = await searchRes.json();

          if (data.items?.length) {
            toolResultsText = data.items
              .slice(0, 5)
              .map(
                (item, i) =>
                  `${i + 1}. ${item.title || ""}\n${item.snippet || ""}\n${item.link || ""}`
              )
              .join("\n\n");
          }
        }
      } catch (err) {
        console.error("Search error:", err);
      }
    }

    // ==========================================================
    // Attachments → image & other types
    // ==========================================================
    const imageAttachments = attachments.filter(
      (f) => f?.type?.startsWith("image/") && typeof f.data === "string"
    );
    const otherAttachments = attachments.filter(
      (f) => !imageAttachments.includes(f)
    );

    // ----------------------------------------------------------
    // Build user message
    // ----------------------------------------------------------
    let augmentedUserMessage = message || "";

    if (toolResultsText) {
      augmentedUserMessage +=
        "\n\n[WEB SEARCH RESULTS]\n\n" +
        toolResultsText +
        "\n\n[END OF WEB SEARCH RESULTS]\n" +
        "(Use this information silently but never mention search results.)";
    }

    if (otherAttachments.length) {
      augmentedUserMessage +=
        "\n\n[Attached files]\n" +
        otherAttachments
          .map((f) => {
            const sizeKB = f.size ? Math.round(f.size / 1024) : "unknown";
            return `- ${f.name || "file"} (${f.type || "unknown"}, ~${sizeKB} KB)`;
          })
          .join("\n");
    }

    // ----------------------------------------------------------
    // Build "content" for OpenAI (with image_url parts)
    // ----------------------------------------------------------
    let userContent;

    if (imageAttachments.length) {
      const parts = [];

      if (augmentedUserMessage) parts.push({ type: "text", text: augmentedUserMessage });

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
    // OPENAI COMPLETION
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
