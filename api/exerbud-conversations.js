// /pages/api/exerbud-conversations.js

import { PrismaClient } from "@prisma/client";

let prisma;

// Reuse Prisma client in dev to avoid too many connections
if (!global._exerbudPrisma) {
  global._exerbudPrisma = new PrismaClient();
}
prisma = global._exerbudPrisma;

// You can change this or make it an env var if you have staging domains
const ALLOWED_ORIGIN =
  process.env.EXERBUD_ALLOWED_ORIGIN || "https://exerbud.com";

// Helper: format a short date label like "Dec 4"
function formatLabelDate(date) {
  if (!date) return "";
  try {
    return new Date(date).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
  } catch {
    return "";
  }
}

// Helper: build a nice human title for the pill
function buildConversationTitle(conv) {
  const dateLabel =
    formatLabelDate(conv.lastMessageAt || conv.startedAt) || "";

  // If we already have a non-empty title in DB, prefer that
  if (conv.title && conv.title.trim().length > 0) {
    return conv.title.trim();
  }

  // Otherwise, infer from workflow first
  if (conv.workflow === "food_scan") {
    return dateLabel ? `Meal scan · ${dateLabel}` : "Meal scan";
  }
  if (conv.workflow === "body_scan") {
    return dateLabel ? `Body scan · ${dateLabel}` : "Body scan";
  }
  if (conv.workflow === "fitness_plan") {
    return dateLabel ? `Workout plan · ${dateLabel}` : "Workout plan";
  }

  // Then from coach profile
  if (conv.coachProfile === "strength") {
    return dateLabel ? `Strength coaching · ${dateLabel}` : "Strength coaching";
  }
  if (conv.coachProfile === "hypertrophy") {
    return dateLabel
      ? `Hypertrophy coaching · ${dateLabel}`
      : "Hypertrophy coaching";
  }
  if (conv.coachProfile === "mobility") {
    return dateLabel ? `Mobility coaching · ${dateLabel}` : "Mobility coaching";
  }
  if (conv.coachProfile === "fat_loss") {
    return dateLabel
      ? `Fat loss coaching · ${dateLabel}`
      : "Fat loss coaching";
  }

  // Generic fallback
  return dateLabel ? `Chat · ${dateLabel}` : "Chat";
}

export default async function handler(req, res) {
  // ---- CORS HEADERS (for all requests) ----
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  // ---- Handle preflight ----
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  // ---- Only allow GET for actual work ----
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET", "OPTIONS"]);
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const { externalId, email } = req.query;

    // Require at least one way to identify the user
    if (!externalId && !email) {
      return res.status(200).json({
        ok: true,
        conversations: [],
      });
    }

    // --- 1) Look up user by externalId or email ---
    let user = null;

    if (externalId) {
      user = await prisma.user.findUnique({
        where: { externalId: String(externalId) },
      });
    }

    // If not found via externalId, try email (if provided)
    if (!user && email) {
      user = await prisma.user.findUnique({
        where: { email: String(email) },
      });
    }

    // No user → nothing to return (frontend will just hide the bar)
    if (!user) {
      return res.status(200).json({
        ok: true,
        conversations: [],
      });
    }

    // --- 2) Fetch a bigger pool of recent conversations for this user ---
    const rawConversations = await prisma.conversation.findMany({
      where: {
        userId: user.id,
      },
      orderBy: [
        // Primary sort: lastMessageAt (most recent first)
        { lastMessageAt: "desc" },
        // Fallback if lastMessageAt is null
        { startedAt: "desc" },
      ],
      take: 40, // grab a bit more, then trim to 20 below
    });

    // --- 3) Filter out totally empty threads, then cap at 20 ---
    const MAX_CONVERSATIONS = 20;

    const usableConversations = rawConversations
      .filter((conv) => Boolean(conv.lastMessageAt || conv.startedAt))
      .slice(0, MAX_CONVERSATIONS);

    // --- 4) Shape the payload so it matches the frontend’s expectations ---
    const payload = usableConversations.map((conv) => ({
      id: conv.id,
      title: buildConversationTitle(conv),
      startedAt: conv.startedAt,
      lastMessageAt: conv.lastMessageAt,
      coachProfile: conv.coachProfile,
      workflow: conv.workflow,
    }));

    return res.status(200).json({
      ok: true,
      conversations: payload,
    });
  } catch (err) {
    console.error("[Exerbud] /api/exerbud-conversations error:", err);
    return res.status(500).json({
      ok: false,
      error: "Internal server error",
    });
  }
}
