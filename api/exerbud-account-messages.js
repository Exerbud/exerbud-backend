// ======================================================================
// EXERBUD ACCOUNT MESSAGE API
// - Soft delete / "hide from dashboard" support
// - Called by the account dashboard when user clicks "Delete from list"
// ======================================================================

let prismaInstance = null;

function getPrisma() {
  if (prismaInstance) return prismaInstance;
  try {
    const { PrismaClient } = require("@prisma/client");
    prismaInstance = new PrismaClient();
    console.log("[Exerbud] Prisma client loaded in /api/exerbud-account-message");
  } catch (err) {
    console.error(
      "[Exerbud] Failed to load PrismaClient in /api/exerbud-account-message:",
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
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");

  try {
    // Preflight
    if (req.method === "OPTIONS") {
      return res.status(200).end();
    }

    if (req.method !== "POST") {
      res.setHeader("Allow", "POST, OPTIONS");
      return res.status(405).json({ error: "Method not allowed" });
    }

    const prisma = getPrisma();
    if (!prisma || !process.env.DATABASE_URL) {
      console.log(
        "[Exerbud] exerbud-account-message: prisma/DATABASE_URL missing, persistence disabled"
      );
      return res.status(200).json({
        ok: false,
        reason: "persistence_disabled",
      });
    }

    // ------------------------------------------------------------------
    // Parse JSON body
    // ------------------------------------------------------------------
    let body = {};
    try {
      body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    } catch (e) {
      console.error(
        "[Exerbud] exerbud-account-message: invalid JSON body",
        e && e.message ? e.message : e
      );
      return res.status(400).json({ ok: false, error: "Invalid JSON body" });
    }

    const { action, messageId, externalId, email } = body || {};

    if (!messageId) {
      return res.status(400).json({ ok: false, error: "Missing messageId" });
    }
    if (!externalId && !email) {
      return res.status(400).json({ ok: false, error: "Missing identity" });
    }

    // ------------------------------------------------------------------
    // Look up user
    // ------------------------------------------------------------------
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
        "[Exerbud] exerbud-account-message: DB error looking up user:",
        err && err.message ? err.message : err
      );
      return res.status(200).json({
        ok: false,
        reason: "user_lookup_failed",
      });
    }

    if (!user) {
      console.log(
        "[Exerbud] exerbud-account-message: user not found for",
        externalId || email
      );
      return res.status(200).json({
        ok: false,
        reason: "user_not_found",
      });
    }

    // ------------------------------------------------------------------
    // Actions
    // ------------------------------------------------------------------
    const normalizedAction = (action || "").toLowerCase();

    // Treat both "delete" and "hide" as "hide from dashboard"
    if (normalizedAction === "delete" || normalizedAction === "hide") {
      try {
        await prisma.hiddenMessage.upsert({
          where: {
            userId_messageId: {
              userId: user.id,
              messageId,
            },
          },
          create: {
            userId: user.id,
            messageId,
          },
          update: {}, // nothing to update, just ensure row exists
        });

        return res.status(200).json({ ok: true, action: "hidden" });
      } catch (err) {
        console.error(
          "[Exerbud] exerbud-account-message: error hiding message:",
          err && err.message ? err.message : err
        );
        return res.status(200).json({
          ok: false,
          reason: "db_error_hide",
        });
      }
    }

    // Optional: support "unhide" in future if you want it
    if (normalizedAction === "unhide") {
      try {
        await prisma.hiddenMessage.deleteMany({
          where: {
            userId: user.id,
            messageId,
          },
        });
        return res.status(200).json({ ok: true, action: "unhidden" });
      } catch (err) {
        console.error(
          "[Exerbud] exerbud-account-message: error unhiding message:",
          err && err.message ? err.message : err
        );
        return res.status(200).json({
          ok: false,
          reason: "db_error_unhide",
        });
      }
    }

    // Unknown action
    return res.status(400).json({
      ok: false,
      error: "Unknown action",
    });
  } catch (error) {
    console.error("Exerbud account-message API error (top-level):", error);
    if (!res.headersSent) {
      return res.status(200).json({
        ok: false,
        reason: "unexpected_error",
        details: error?.message || "Unknown error",
      });
    }
  }
};
