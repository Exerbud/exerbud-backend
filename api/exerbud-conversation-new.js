// /api/exerbud-conversation-new.js
import prisma from "../lib/prisma";
import { findOrCreateUser } from "../lib/exerbudPersistence";
import logger from "../utils/logger";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { userExternalId, email, initialTitle } = req.body || {};

    if (!userExternalId && !email) {
      return res
        .status(400)
        .json({ error: "userExternalId or email required" });
    }

    // Get or create the user record
    const user = await findOrCreateUser(userExternalId, email);

    // Create the conversation
    const conversation = await prisma.conversation.create({
      data: {
        userId: user.id,
        title: initialTitle || "New conversation",
        lastMessageAt: new Date(), // initialize it so sorting works immediately
      },
    });

    logger.info("conversation.new", {
      userId: user.id,
      conversationId: conversation.id,
    });

    return res.status(200).json({
      conversationId: conversation.id,
      title: conversation.title,
      createdAt: conversation.startedAt,
    });
  } catch (error) {
    logger.error("conversation.new.error", {
      error: String(error),
    });

    return res.status(500).json({ error: "Internal server error" });
  }
}
