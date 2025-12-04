// api/exerbud-conversation-new.js

import prisma from "../lib/prisma";
import { findOrCreateUser } from "../lib/exerbudPersistence";
import logger from "../utils/logger";

// Basic CORS for Shopify → Vercel
function setCors(res) {
  // You can tighten this later to your exact shop domain
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

export default async function handler(req, res) {
  setCors(res);

  // Handle the Shopify preflight OPTIONS request
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { userExternalId, email, initialTitle } = req.body || {};

    if (!userExternalId && !email) {
      return res
        .status(400)
        .json({ error: "userExternalId or email is required" });
    }

    // Make sure we have a user record
    const user = await findOrCreateUser({
      externalId: userExternalId || null,
      email: email || null,
    });

    if (!user || !user.id) {
      return res
        .status(500)
        .json({ error: "Could not resolve or create user record" });
    }

    // Create a new conversation row
    const conversation = await prisma.conversation.create({
      data: {
        userId: user.id, // adjust this if your Conversation model uses a different field
        title: initialTitle || "Exerbud AI coach",
      },
    });

    return res.status(200).json({
      ok: true,
      conversationId: conversation.id,
      userExternalId: user.externalId || userExternalId || null,
    });
  } catch (err) {
    try {
      logger.error("[exerbud-conversation-new] Failed to create conversation", {
        error: err?.message || String(err),
        stack: err?.stack,
      });
    } catch (e) {
      console.error("[exerbud-conversation-new] Logging failed:", e, err);
    }

    return res
      .status(500)
      .json({ error: "Failed to create conversation on backend" });
  }
}
