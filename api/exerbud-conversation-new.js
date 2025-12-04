// api/exerbud-conversation-new.js

// Minimal stub (no prisma, no other imports) so it cannot crash on import.

function setCors(res) {
  // You can tighten this later to just "https://exerbud.com"
  res.setHeader("Access-Control-Allow-Origin", "https://exerbud.com");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

export default async function handler(req, res) {
  setCors(res);

  // Handle preflight
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { userExternalId, email, initialTitle } = req.body || {};

    // Just generate a fake conversation id for now
    const conversationId =
      "conv_" +
      Date.now().toString(36) +
      "_" +
      Math.random().toString(16).slice(2, 8);

    console.log("[exerbud-conversation-new] new conversation", {
      conversationId,
      userExternalId,
      email,
      initialTitle,
    });

    return res.status(200).json({
      ok: true,
      conversationId,
      userExternalId: userExternalId || null,
    });
  } catch (err) {
    console.error("[exerbud-conversation-new] error:", err);
    return res.status(500).json({
      error: "Failed to create conversation",
      details: String(err),
    });
  }
}
