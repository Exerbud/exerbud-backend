// ======================================================================
// EXERBUD ACCOUNT MESSAGE API
// - Handles per-user soft delete (hide from dashboard)
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
    // CORS preflight
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
        "[Exerbud] exerbud-account-message: prisma/DATABASE_URL missing"
      );
      return res.status(200).json({
        ok: false,
        reason: "persistence_disabled",
      });
    }

    // --------------------------------------------------------------
    // Parse body
    // --------------------------------------------------------------
    let body = null;
    try {
      body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    } catch (e) {
      console.error(
        "[Exerbud] exerbud-account-message: invalid JSON body",
        e && e.message ? e.message : e
      );
      return res.status(400).json({ ok: false, error: "invalid_json" });
    }

    const action     = body?.action;
    const messageId  = body?.messageId;
    const externalId = body?.externalId || null;
    const email      = body?.email || null;

    if (!action || action !== "delete") {
      return res.status(400).json({ ok: false, error: "unsupported_action" });
    }

    if (!messageId) {
      return res.status(400).json({ ok: false, error: "missing_message_id" });
    }

    if (!externalId && !email) {
      return res.status(400).json({ ok: false, error: "missing_identity" });
    }

    // --------------------------------------------------------------
    // Find the user (same logic as exerbud-account.js)
    // --------------------------------------------------------------
    let user = null;
    try {
      const whereClauses = [];
      if (externalId) whereClauses.push({ externalId });
      if (email)      whereClauses.push({ email });

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
        reason: "user_lookup_error",
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

    // --------------------------------------------------------------
    // Ensure the message belongs to one of this user's conversations
    // --------------------------------------------------------------
    const message = await prisma.message.findFirst({
      where: {
        id: messageId,
        conversation: {
          userId: user.id,
        },
      },
      select: { id: true },
    });

    if (!message) {
      console.log(
        "[Exerbud] exerbud-account-message: message not found or not owned by user",
        messageId
      );
      return res.status(200).json({
        ok: false,
        reason: "message_not_found",
      });
    }

    // --------------------------------------------------------------
    // Soft delete: create (or confirm) HiddenMessage record
    // --------------------------------------------------------------
    try {
      // Using upsert to avoid unique constraint errors if it already exists
      await prisma.hiddenMessage.upsert({
        where: {
          userId_messageId: {
            userId: user.id,
            messageId: message.id,
          },
        },
        update: {},
        create: {
          userId: user.id,
          messageId: message.id,
        },
      });

      console.log(
        "[Exerbud] exerbud-account-message: hidden message",
        message.id,
        "for user",
        user.id
      );
    } catch (err) {
      console.error(
        "[Exerbud] exerbud-account-message: error creating HiddenMessage:",
        err && err.message ? err.message : err
      );
      return res.status(200).json({
        ok: false,
        reason: "hidden_message_error",
      });
    }

    return res.status(200).json({
      ok: true,
      softDeleted: true,
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
