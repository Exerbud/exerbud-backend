// lib/exerbudPersistence.js
// Minimal Prisma persistence layer for Exerbud AI

const { PrismaClient } = require("@prisma/client");

// Avoid creating too many clients in serverless environments
let prisma;
if (!global._exerbudPrisma) {
  global._exerbudPrisma = new PrismaClient();
}
prisma = global._exerbudPrisma;

/**
 * Ensure we have a User + Conversation row for this request.
 * - externalId: "shopify:123" or "guest:uuid"
 * - email: optional
 * - conversationId: optional existing conversation id
 * - coachProfile: optional enum
 * - workflow: optional enum
 */
async function ensureUserAndConversation({
  externalId,
  email,
  conversationId,
  coachProfile,
  workflow,
}) {
  if (!externalId) {
    throw new Error("externalId is required for ensureUserAndConversation");
  }

  // Upsert user by externalId
  const user = await prisma.user.upsert({
    where: { externalId },
    update: {
      // keep latest email if we get one
      ...(email ? { email } : {}),
    },
    create: {
      externalId,
      email: email || null,
    },
  });

  let conversation = null;

  // If the frontend sent a conversationId, try to reuse it
  if (conversationId) {
    conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
    });
  }

  // If none found, create a new conversation
  if (!conversation) {
    conversation = await prisma.conversation.create({
      data: {
        userId: user.id,
        source: "shopify_widget",
        coachProfile: coachProfile || null,
        workflow: workflow || null,
      },
    });
  }

  return { user, conversation };
}

/**
 * Save a user + assistant message pair for a conversation.
 */
async function saveMessagePair({
  conversationId,
  userId,
  userMessage,
  assistantMessage,
}) {
  if (!conversationId || !userId) {
    throw new Error(
      "conversationId and userId are required for saveMessagePair"
    );
  }

  const userContent = userMessage || "";
  const assistantContent = assistantMessage || "";

  // create both messages; transaction is nice but optional
  const [userMsg, assistantMsg] = await prisma.$transaction([
    prisma.message.create({
      data: {
        conversationId,
        userId,
        role: "user",
        content: userContent,
      },
    }),
    prisma.message.create({
      data: {
        conversationId,
        userId,
        role: "assistant",
        content: assistantContent,
      },
    }),
  ]);

  return { userMsg, assistantMsg };
}

module.exports = {
  ensureUserAndConversation,
  saveMessagePair,
};
