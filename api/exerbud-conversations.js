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

    // --- 2) Fetch recent conversations for this user ---
    const conversations = await prisma.conversation.findMany({
      where: {
        userId: user.id,

        // Only show conversations that actually have messages
        // (hides blank auto-created threads)
        messages: {
          some: {}, // at least one related message
        },
      },
      orderBy: [
        // Primary sort: lastMessageAt (most recent first)
        { lastMessageAt: "desc" },
        // Fallback if lastMessageAt is null
        { startedAt: "desc" },
      ],
      // Only show the most recent 4 in the pill bar
      take: 4,
    });

    // --- 3) Shape the payload so it matches the frontend’s expectations ---
    const payload = conversations.map((conv) => ({
      id: conv.id,
      title: conv.title,
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
