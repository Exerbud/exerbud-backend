// ======================================================================
// EXERBUD ACCOUNT SUMMARY API (SIMPLIFIED, STABLE VERSION)
// - Used by /account dashboard
// - Returns recent Exerbud AI activity + basic stats
// - No ProgressEvent / Upload dependencies (avoids extra DB errors)
// ======================================================================

let prismaInstance = null;

function getPrisma() {
  if (prismaInstance) return prismaInstance;
  try {
    const { PrismaClient } = require("@prisma/client");
    prismaInstance = new PrismaClient();
    console.log("[Exerbud] Prisma client loaded in /api/exerbud-account");
  } catch (err) {
    console.error(
      "[Exerbud] Failed to load PrismaClient in /api/exerbud-account:",
      err && err.message ? err.message : err
    );
    prismaInstance = null;
  }
  return prismaInstance;
}

module.exports = async function handler(req, res) {
  const allowedOrigin = "https://exerbud.com";

  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");

  try {
    // Preflight
    if (req.method === "OPTIONS") {
      return res.status(200).end();
    }

    if (req.method !== "GET") {
      res.setHeader("Allow", "GET, OPTIONS");
      return res.status(405).json({ error: "Method not allowed" });
    }

    // --------------------------------------------------------------
    // Parse query params safely from req.url
    // --------------------------------------------------------------
    let externalId = null;
    let email = null;

    try {
      const urlObj = new URL(
        req.url,
        `http://${req.headers.host || "localhost"}`
      );
      externalId = urlObj.searchParams.get("externalId");
      email = urlObj.searchParams.get("email");
    } catch (e) {
      console.error(
        "[Exerbud] Failed to parse URL in exerbud-account:",
        e && e.message ? e.message : e
      );
    }

    if (!externalId && !email) {
      console.log(
        "[Exerbud] exerbud-account: missing identity (no externalId or email)"
      );
      return res.status(200).json({
        hasData: false,
        reason: "missing_identity",
      });
    }

    const prisma = getPrisma();

    if (!prisma || !process.env.DATABASE_URL) {
      console.log(
        "[Exerbud] exerbud-account: prisma/DATABASE_URL missing, persistence disabled"
      );
      return res.status(200).json({
        hasData: false,
        reason: "persistence_disabled",
      });
    }

    // --------------------------------------------------------------
    // Look up the user
    // --------------------------------------------------------------
    let user = null;
    try {
      const whereClauses = [];
      if (externalId) whereClauses.push({ externalId });
      if (email) whereClauses.push({ email });

      user = await prisma.user.findFirst({
        where: { OR: whereClauses },
        select: { id: true },
      });
    } catch (err) {
      console.error(
        "[Exerbud] exerbud-account: DB error looking up user:",
        err && err.message ? err.message : err
      );
      // Treat as "no activity yet" instead of hard error
      return res.status(200).json({
        hasData: false,
        reason: "user_not_found",
      });
    }

    if (!user) {
      console.log(
        "[Exerbud] exerbud-account: user not found for",
        externalId || email
      );
      return res.status(200).json({
        hasData: false,
        reason: "user_not_found",
      });
    }

    // --------------------------------------------------------------
    // Load messages for that user (up to 250 for pagination)
    // --------------------------------------------------------------
    let totalMessages = 0;
    let recentMessages = [];

    try {
      totalMessages = await prisma.message.count({
        where: {
          conversation: {
            userId: user.id,
          },
        },
      });

      if (totalMessages > 0) {
        recentMessages = await prisma.message.findMany({
          where: {
            conversation: {
              userId: user.id,
            },
          },
          orderBy: { createdAt: "desc" },
          take: 250, // frontend paginates 5 at a time
          select: {
            id: true,
            role: true,
            content: true,
            createdAt: true,
          },
        });
      }
    } catch (err) {
      console.error(
        "[Exerbud] exerbud-account: DB error loading messages:",
        err && err.message ? err.message : err
      );
      // Fall back to "no messages" instead of db_error
      totalMessages = 0;
      recentMessages = [];
    }

    // --------------------------------------------------------------
    // Derive last message timestamps (may be null if no messages)
    // --------------------------------------------------------------
    let lastMessageAtIso = null;
    let lastMessageAtHuman = null;

    if (recentMessages.length > 0) {
      const last = recentMessages[0];
      if (last && last.createdAt) {
        try {
          lastMessageAtIso = last.createdAt.toISOString();
        } catch {
          lastMessageAtIso = null;
        }
        try {
          lastMessageAtHuman = last.createdAt.toLocaleString("en-US", {
            month: "short",
            day: "2-digit",
            year: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          });
        } catch {
          lastMessageAtHuman = lastMessageAtIso;
        }
      }
    }

    // --------------------------------------------------------------
    // Basic summary (zeros for now – frontend handles this)
    // --------------------------------------------------------------
    const summary = {
      mealsThisWeek: 0,
      bodyScansThisWeek: 0,
      workoutsThisWeek: 0,
      avgCaloriesPerDay: 0,
    };

    // --------------------------------------------------------------
    // Final response
    // --------------------------------------------------------------
    return res.status(200).json({
      hasData: true,
      totalMessages,
      lastMessageAtIso,
      lastMessageAtHuman,
      recentMessages: recentMessages.map((m) => ({
        id: m.id,
        messageId: m.id, // used by dashboard + jumpToMessage
        role: m.role,
        content: m.content,
        createdAt: m.createdAt.toISOString(),
      })),
      summary,
      uploadsPreview: [], // not used yet by the dashboard JS
    });
  } catch (error) {
    console.error("Exerbud account API error (top-level):", error);
    if (!res.headersSent) {
      return res.status(200).json({
        hasData: false,
        reason: "unexpected_error",
        details: error?.message || "Unknown error",
      });
    }
  }
};
