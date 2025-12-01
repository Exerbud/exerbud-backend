// ======================================================================
// EXERBUD ACCOUNT SUMMARY API
// - Read-only endpoint used by /account dashboard
// - Returns recent Exerbud AI activity for a logged-in Shopify customer
// ======================================================================

const { URL } = require("url");

// ----------------------------------------------------------------------
// Prisma client (optional, same pattern as exerbud-ai.js)
// ----------------------------------------------------------------------
let prisma = null;
try {
  // This will throw if @prisma/client is not installed / generated
  const { PrismaClient } = require("@prisma/client");
  prisma = new PrismaClient();
  console.log("[Exerbud] Prisma client loaded in /api/exerbud-account");
} catch (err) {
  console.error(
    "[Exerbud] Failed to load PrismaClient in /api/exerbud-account:",
    err && err.message ? err.message : err
  );
  prisma = null;
}

module.exports = async function handler(req, res) {
  // --- CORS (for Shopify storefront) ---
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  try {
    // Preflight
    if (req.method === "OPTIONS") {
      return res.status(200).end();
    }

    if (req.method !== "GET") {
      res.setHeader("Allow", "GET, OPTIONS");
      return res.status(405).json({ error: "Method not allowed" });
    }

    // ------------------------------------------------------------------
    // Parse query params: externalId & email
    // ------------------------------------------------------------------
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
      console.warn(
        "[Exerbud] Failed to parse URL in exerbud-account:",
        e?.message || e
      );
    }

    if (!externalId && !email) {
      // No identity info; nothing to show (but still 200)
      return res.status(200).json({
        hasData: false,
        reason: "missing_identity",
      });
    }

    // ------------------------------------------------------------------
    // If Prisma isn't available, just return empty summary
    // ------------------------------------------------------------------
    if (!prisma || !process.env.DATABASE_URL) {
      console.log(
        "[Exerbud] Skipping DB lookup in /api/exerbud-account (no prisma or DATABASE_URL)"
      );
      return res.status(200).json({
        hasData: false,
        reason: "persistence_disabled",
      });
    }

    // ------------------------------------------------------------------
    // Prisma queries wrapped in their own try/catch
    // ------------------------------------------------------------------
    let user;
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
        "[Exerbud] DB error when looking up user in exerbud-account:",
        err && err.message ? err.message : err
      );
      return res.status(200).json({
        hasData: false,
        reason: "db_error_user",
      });
    }

    if (!user) {
      return res.status(200).json({
        hasData: false,
        reason: "user_not_found",
      });
    }

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
          take: 10,
          select: {
            role: true,
            content: true,
            createdAt: true,
          },
        });
      }
    } catch (err) {
      console.error(
        "[Exerbud] DB error when loading messages in exerbud-account:",
        err && err.message ? err.message : err
      );
      return res.status(200).json({
        hasData: false,
        reason: "db_error_messages",
      });
    }

    if (!totalMessages || recentMessages.length === 0) {
      return res.status(200).json({
        hasData: false,
        totalMessages: 0,
        recentMessages: [],
      });
    }

    const last = recentMessages[0];
    const lastMessageAtIso = last?.createdAt
      ? last.createdAt.toISOString()
      : null;

    let lastMessageAtHuman = null;
    if (last?.createdAt) {
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

    return res.status(200).json({
      hasData: true,
      totalMessages,
      lastMessageAtIso,
      lastMessageAtHuman,
      recentMessages: recentMessages.map((m) => ({
        role: m.role,
        content: m.content,
        createdAt: m.createdAt.toISOString(),
      })),
    });
  } catch (error) {
    console.error("Exerbud account API error (top-level):", error);
    if (!res.headersSent) {
      // Even here: respond 200 with a soft error so the frontend
      // doesn’t blow up with a network error.
      return res.status(200).json({
        hasData: false,
        reason: "unexpected_error",
        details: error?.message || "Unknown error",
      });
    }
  }
};
