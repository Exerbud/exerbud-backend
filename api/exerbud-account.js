// ======================================================================
// EXERBUD ACCOUNT SUMMARY API (with soft-delete + safe fallback)
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

// --------------------------------------------------------------
// Helpers to classify messages for "This Week at a Glance"
// --------------------------------------------------------------

function isMealLikeFromContent(content) {
  if (!content) return false;
  const lower = content.toLowerCase();

  if (lower.includes("analysis of the food items in the image")) return true;
  if (lower.includes("here's the analysis of the food items in the image")) return true;
  if (lower.includes("here is the analysis of the food items in the image")) return true;
  if (lower.includes("here's the analysis of this meal")) return true;
  if (lower.includes("here is the analysis of this meal")) return true;

  if (lower.includes("here's the analysis of your plate")) return true;
  if (lower.includes("here is the analysis of your plate")) return true;
  if (lower.includes("analysis of your plate")) return true;
  if (lower.includes("food items and approximate portion sizes")) return true;
  if (lower.includes("approximate portion sizes")) return true;

  if (lower.includes("analysis of the food item in your image")) return true;
  if (lower.includes("here's the analysis of the food item in your image")) return true;
  if (lower.includes("here is the analysis of the food item in your image")) return true;
  if (lower.includes("analysis of the food item in the image")) return true;

  if (lower.includes("food identified:")) return true;

  if (lower.includes("this meal") && /[0-9]{2,4}\s*(kcal|calories)/i.test(lower))
    return true;
  if (lower.includes("plate") && /[0-9]{2,4}\s*(kcal|calories)/i.test(lower))
    return true;

  return false;
}

function isWorkoutLikeFromContent(content) {
  if (!content) return false;
  const lower = content.toLowerCase();
  return (
    lower.includes("workout plan") ||
    lower.includes("training plan") ||
    lower.includes("weekly plan") ||
    (lower.includes("workout") && lower.includes("plan")) ||
    lower.includes("routine")
  );
}

function isBodyScanLikeFromContent(content) {
  if (!content) return false;
  const lower = content.toLowerCase();
  return (
    lower.includes("body scan") ||
    lower.includes("progress photos") ||
    lower.includes("progress photo") ||
    lower.includes("progress picture")
  );
}

function extractCaloriesFromText(text) {
  if (!text) return null;
  const m = text.match(/([0-9]{2,4})\s*(kcal|calories)/i);
  if (!m) return null;
  const val = parseInt(m[1], 10);
  if (Number.isNaN(val)) return null;
  return val;
}

module.exports = async function handler(req, res) {
  const allowedOrigin = "https://exerbud.com";

  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");

  try {
    if (req.method === "OPTIONS") {
      return res.status(200).end();
    }

    if (req.method !== "GET") {
      res.setHeader("Allow", "GET, OPTIONS");
      return res.status(405).json({ error: "Method not allowed" });
    }

    // --------------------------------------------------------------
    // Parse identity
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
      console.log("[Exerbud] exerbud-account: missing identity");
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
    // Look up user
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
    // Build WHERE + soft-delete support
    // --------------------------------------------------------------
    const baseWhere = {
      conversation: {
        userId: user.id,
      },
    };

    let messagesWhere = baseWhere;
    let softDeleteSupported = true;

    // Try a tiny query that touches HiddenMessage.
    // If it explodes, we know migrations / client aren’t in sync yet.
    try {
      await prisma.hiddenMessage.count({
        where: { userId: user.id },
      });

      messagesWhere = {
        ...baseWhere,
        hiddenBy: {
          none: {
            userId: user.id,
          },
        },
      };
    } catch (e) {
      softDeleteSupported = false;
      console.warn(
        "[Exerbud] HiddenMessage not available yet; falling back to no soft-delete:",
        e && e.message ? e.message : e
      );
      messagesWhere = baseWhere;
    }

    // --------------------------------------------------------------
    // Load messages (up to 250) with that WHERE
    // --------------------------------------------------------------
    let totalMessages = 0;
    let recentMessages = [];

    try {
      totalMessages = await prisma.message.count({
        where: messagesWhere,
      });

      if (totalMessages > 0) {
        recentMessages = await prisma.message.findMany({
          where: messagesWhere,
          orderBy: { createdAt: "desc" },
          take: 250,
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
      totalMessages = 0;
      recentMessages = [];
    }

    // --------------------------------------------------------------
    // Last message timestamps
    // --------------------------------------------------------------
    let lastMessageAtIso = null;
    let lastMessageAtHuman = null;

    if (recentMessages.length > 0) {
      const last = recentMessages[0];
      if (last && last.createdAt) {
        try {
          lastMessageAtIso = new Date(last.createdAt).toISOString();
        } catch {
          lastMessageAtIso = null;
        }
        try {
          lastMessageAtHuman = new Date(last.createdAt).toLocaleString(
            "en-US",
            {
              month: "short",
              day: "2-digit",
              year: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            }
          );
        } catch {
          lastMessageAtHuman = lastMessageAtIso;
        }
      }
    }

    // --------------------------------------------------------------
    // Weekly summary derived from assistant messages (last 7 days)
    // --------------------------------------------------------------
    let mealsThisWeek = 0;
    let bodyScansThisWeek = 0;
    let workoutsThisWeek = 0;
    let avgCaloriesPerDay = 0;

    try {
      if (recentMessages.length > 0) {
        const now = new Date();
        const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        const caloriesByDay = {};

        recentMessages.forEach((m) => {
          if (m.role !== "assistant") return;

          const created = new Date(m.createdAt);
          if (!created || isNaN(created.getTime())) return;
          if (created < weekAgo) return;

          const content = m.content || "";

          const looksLikeMeal = isMealLikeFromContent(content);
          const looksLikeWorkout = isWorkoutLikeFromContent(content);
          const looksLikeBodyScan = isBodyScanLikeFromContent(content);

          if (looksLikeMeal) {
            mealsThisWeek += 1;
            const cals = extractCaloriesFromText(content);
            if (typeof cals === "number") {
              const dayKey = created.toISOString().slice(0, 10);
              caloriesByDay[dayKey] =
                (caloriesByDay[dayKey] || 0) + cals;
            }
          }

          if (looksLikeWorkout) {
            workoutsThisWeek += 1;
          }

          if (looksLikeBodyScan) {
            bodyScansThisWeek += 1;
          }
        });

        const dayKeys = Object.keys(caloriesByDay);
        if (dayKeys.length > 0) {
          const totalCalories = dayKeys.reduce(
            (sum, day) => sum + caloriesByDay[day],
            0
          );
          avgCaloriesPerDay = Math.round(totalCalories / dayKeys.length);
        }
      }
    } catch (err) {
      console.error(
        "[Exerbud] exerbud-account: error computing weekly summary from messages:",
        err && err.message ? err.message : err
      );
    }

    const summary = {
      mealsThisWeek,
      bodyScansThisWeek,
      workoutsThisWeek,
      avgCaloriesPerDay,
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
        messageId: m.id,
        role: m.role,
        content: m.content,
        createdAt: new Date(m.createdAt).toISOString(),
      })),
      summary,
      uploadsPreview: [],
      softDeleteSupported,
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
