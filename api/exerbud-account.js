// ======================================================================
// EXERBUD ACCOUNT SUMMARY API
// - Read-only endpoint used by /account dashboard
// - Returns recent Exerbud AI activity for a logged-in Shopify customer
// ======================================================================

// ----------------------------------------------------------------------
// Optional Prisma client
// ----------------------------------------------------------------------
let prisma = null;
try {
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
  // Basic CORS for the Shopify storefront
  res.setHeader("Access-Control-Allow-Origin", "*");
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

    // --------------------------------------------------------------
    // If Prisma isn't available, bail out gracefully
    // --------------------------------------------------------------
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
      return res.status(200).json({
        hasData: false,
        reason: "db_error_user",
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
    // Load messages for that user
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
        "[Exerbud] exerbud-account: DB error loading messages:",
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
        reason: "no_messages",
        totalMessages: 0,
        recentMessages: [],
      });
    }

    const last = recentMessages[0];
    const lastMessageAtIso = last?.createdAt
      ? last.createdAt.toISOString()
      : null;

    let lastMessageAtHuman = lastMessageAtIso;
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
        // keep ISO
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
      return res.status(200).json({
        hasData: false,
        reason: "unexpected_error",
        details: error?.message || "Unknown error",
      });
    }
  }
};
