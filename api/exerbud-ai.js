// ======================================================================
// EXERBUD AI — NON-STREAMING BACKEND WITH GOOGLE SEARCH + PDF EXPORT
// ======================================================================

const fetch = require("node-fetch");

// ----------------------------------------------
// Main handler (WITH CORS FIXED)
// ----------------------------------------------
module.exports = async function handler(req, res) {
  //
  // --- GLOBAL CORS HEADERS (REQUIRED FOR SHOPIFY) ---
  //
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  // Preflight request
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  // Only POST allowed for real operations
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const body = req.body || {};

    // ==========================================================
    //  PDF EXPORT MODE
    // ==========================================================
    if (body.pdfExport) {
      const planText = body.planText || "Your workout plan";
      const title = body.planTitle || "Exerbud workout plan";

      const PDFDocument = require("pdfkit");
      const doc = new PDFDocument({ margin: 40 });

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${title.replace(/[^a-z0-9_\-]/gi, "_")}.pdf"`
      );

      doc.pipe(res);

      doc.fontSize(20).text(title, { align: "left" });
      doc.moveDown();

      doc.fontSize(12);
      const paragraphs = planText.split(/\n{2,}/);

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
    const message = body.message || "";
    const history = Array.isArray(body.history) ? body.history : [];
    const attachments = Array.isArray(body.attachments) ? body.attachments : [];
    const enableSearch = Boolean(body.enableSearch);
    const coachProfile = body.coachProfile || null;

    if (!message) {
      return res.status(400).json({ error: "Missing message" });
    }

    // Prepare conversation history
    const formattedHistory = history.map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.content || "",
    }));

    const messages = [...formattedHistory];

    // SYSTEM PROMPT
    let systemPrompt =
      "You are Exerbud, a helpful fitness and strength training coach. " +
      "Give clear, practical, sustainable advice. Avoid markdown headings (#). " +
      "Bullet points are okay. Keep formatting clean and readable.";

    if (coachProfile === "strength") {
      systemPrompt += " You focus on strength training and compound lifts.";
    } else if (coachProfile === "hypertrophy") {
      systemPrompt += " You focus on hypertrophy and muscle-building programming.";
    } else if (coachProfile === "mobility") {
      systemPrompt += " You focus on mobility, joint health, pain-free movement.";
    } else if (coachProfile === "fat_loss") {
      systemPrompt += " You focus on sustainable fat loss while preserving muscle.";
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
      process.env.GOOGLE_CX
    ) {
      try {
        const query = message.slice(0, 200);

        const url = new URL("https://www.googleapis.com/customsearch/v1");
        url.searchParams.set("key", process.env.GOOGLE_API_KEY);
        url.searchParams.set("cx", process.env.GOOGLE_CX);
        url.searchParams.set("q", query);

        const searchRes = await fetch(url.toString());
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
      } catch (err) {
        console.error("Google Search Error:", err);
      }
    }

    let augmentedUserMessage = message;
    if (toolResultsText) {
      augmentedUserMessage =
        message +
        "\n\n[Search Context]\n\n" +
        toolResultsText +
        "\n\n(Do not mention this bracketed text explicitly.)";
    }

    messages.push({
      role: "user",
      content: augmentedUserMessage,
    });

    // ==========================================================
    // OPENAI COMPLETION
    // ==========================================================
    const OpenAI = (await import("openai")).default;

    const client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });

    const completion = await client.chat.completions.create({
      model: "gpt-4.1-mini",
      messages,
      temperature: 0.6,
      max_tokens: 900,
    });

    const reply =
      completion.choices?.[0]?.message?.content ||
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
