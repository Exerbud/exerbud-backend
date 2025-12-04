// api/exerbud-conversations.js

import prisma from "../lib/prisma";
import logger from "../utils/logger";

// Basic CORS for Shopify → Vercel
function setCors(res) {
  // You can tighten this later to your exact shop domain
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  if (req.method !== "GET") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  try {
    const { externalId, email } = req.query;

    if (!externalId && !email) {
      res
        .status(400)
        .json({ ok: false, error: "Missing externalId or email" });
      return;
    }

    const filters = [];
    if (externalId) {
      filters.push({ userExternalId: String(externalId) });
    }
    if (email) {
      filters.push({ userEmail: String(email).toLowerCase() });
    }

    const conversations = await prisma.conversation.findMany({
      where: {
        OR: filters
      },
      orderBy: {
        updatedAt: "desc"
      },
      take: 10
    });

    res.status(200).json({
      ok: true,
      conversations: conversations.map((c) => ({
        id: c.id,
        title: c.initialTitle || c.title || null,
        createdAt: c.createdAt,
        lastMessageAt: c.updatedAt
      }))
    });
  } catch (err) {
    try {
      logger.error("[exerbud-conversations] Failed to list conversations", err);
    } catch (e) {
      console.error("[exerbud-conversations] Failed to list conversations", err);
    }
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
}
