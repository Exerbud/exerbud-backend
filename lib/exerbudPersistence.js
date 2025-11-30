// lib/exerbudPersistence.js
// Small helper layer around Prisma for Exerbud memory.

const prisma = require("./prisma");

/**
 * Ensure we have a User + Conversation in the DB.
 * - externalId is your stable ID from frontend ("shopify:123", "guest:uuid", etc.)
 * - email is optional
 * - conversationId is optional; if it doesn't exist, we create a new conversation
 */
async function ensureUserAndConversation({
  externalId,
  email,
  conversationId,
  coachProfile,
  workflow,
}) {
  if (!externalId) {
    throw new Error("externalId is required for persistence");
  }

  // Upsert User by externalId
  const user = await prisma.user.upsert({
    where: { externalId },
    update: {
      // only update email if we have one
      ...(email ? { email } : {}),
    },
    create: {
      externalId,
      email: email ?? null,
    },
  });

  let conversation = null;

  if (conversationId) {
    conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
    });
  }

  if (!conversation) {
    // New conversation
    conversation = await prisma.conversation.create({
      data: {
        userId: user.id,
        coachProfile: coachProfile ?? null,
        workflow: workflow ?? null,
      },
    });
  } else {
    // Update metadata if we learned something new
    conversation = await prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        coachProfile: coachProfile ?? conversation.coachProfile,
        workflow: workflow ?? conversation.workflow,
      },
    });
  }

  return { user, conversation };
}

/**
 * Save one user message + one assistant reply as Message rows.
 * (We keep this separate so we can call it even if OpenAI fails later.)
 */
async function saveMessagePair({
  conversationId,
  userId,
  userMessage,
  assistantMessage,
}) {
  if (!conversationId || !userId) return;

  const tx = [];

  if (userMessage) {
    tx.push(
      prisma.message.create({
        data: {
          conversationId,
          userId,
          role: "user",
          content: userMessage.slice(0, 8000), // safety clamp
        },
      })
    );
  }

  if (assistantMessage) {
    tx.push(
      prisma.message.create({
        data: {
          conversationId,
          role: "assistant",
          content: assistantMessage.slice(0, 8000),
        },
      })
    );
  }

  if (tx.length) {
    await prisma.$transaction(tx);
  }
}

module.exports = {
  ensureUserAndConversation,
  saveMessagePair,
};
