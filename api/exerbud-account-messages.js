// ======================================================================
// EXERBUD ACCOUNT MESSAGE API (SOFT DELETE)
// - Handles per-message actions from the account dashboard
// - "delete" = hide message from the dashboard (does NOT remove from DB)
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

    // ------------------ Parse body ------------------
    let action, messageId, externalId, email;

    try {
      ({ action, messageId, externalId, email } = req.body || {});
    } catch (e) {
      console.error(
        "[Exerbud] exerbud-account-message: failed to parse body:",
        e && e.message ? e.message : e
      );
      return res.status(400).json({ ok: false, error: "Invalid JSON body" });
    }

    if (!action || !messageId) {
      return res.status(400).json({
        ok: false,
        error: "Missing action or messageId",
      });
    }

    if (!externalId && !email) {
      console.log(
        "[Exerbud] exerbud-account-message: missing identity (no externalId or email)"
      );
      return res.status(200).json({
        ok: false,
        reason: "missing_identity",
      });
    }

    // ------------------ Resolve user ------------------
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
        reason: "db_error_user",
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

    // ------------------ Actions ------------------
    if (action === "delete") {
      try {
        // Ensure the message belongs to this user
        const msg = await prisma.message.findFirst({
          where: {
            id: messageId,
            conversation: {
              userId: user.id,
            },
          },
          select: { id: true },
        });

        if (!msg) {
          console.log(
            "[Exerbud] exerbud-account-message: message not found or not owned by user",
            messageId
          );
          return res.status(200).json({
            ok: false,
            reason: "message_not_found",
          });
        }

        // SOFT DELETE: mark hidden for this user
        await prisma.hiddenMessage.upsert({
          where: {
            userId_messageId: {
              userId: user.id,
              messageId: msg.id,
            },
          },
          create: {
            userId: user.id,
            messageId: msg.id,
          },
          update: {}, // nothing to update
        });

        console.log(
          "[Exerbud] exerbud-account-message: soft-deleted message",
          msg.id,
          "for user",
          user.id
        );

        return res.status(200).json({ ok: true });
      } catch (err) {
        console.error(
          "[Exerbud] exerbud-account-message: DB error soft-deleting message:",
          err && err.message ? err.message : err
        );
        return res.status(200).json({
          ok: false,
          reason: "db_error_delete",
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
