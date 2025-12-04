// api/exerbud-conversation-new.js

import prisma from "../lib/prisma";
import { findOrCreateUser } from "../lib/exerbudPersistence";
import logger from "../utils/logger";

// Very simple CORS helper (you can tighten origins later if you want)
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

export default async function handler(req, res) {
  setCors(res);

  // Handle preflight
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { userExternalId, email, coachProfile, workflow } = req.body || {};

    if (!userExternalId && !email) {
      return res.status(400).json({
        error: "userExternalId or email is required",
      });
    }

    // Get or create the user
    const user = await findOrCreateUser(userExternalId || null, email || null);

    // Create a new conversation row
    const conversation = await prisma.conversation.create({
      data: {
        userId: user.id,
        source: "shopify_widget",
        coachProfile: coachProfile || null,
        workflow: workflow || null,
        startedAt: new Date(),
      },
    });

    return res.status(200).json({
      ok: true,
      conversationId: conversation.id,
      userExternalId: user.externalId,
    });
  } catch (err) {
    logger.error("[Exerbud] /api/exerbud-conversation-new error", {
      error: err?.message,
      stack: err?.stack,
    });

    return res.status(500).json({
      error: "Internal server error",
    });
  }
}
