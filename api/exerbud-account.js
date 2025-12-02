// ======================================================================
// EXERBUD ACCOUNT SUMMARY API
// - Read-only endpoint used by /account dashboard
// - Returns recent Exerbud AI activity + weekly stats + uploads preview
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

// ---- helpers for summary -------------------------------------------------

function isMealLike(workflow, lowerContent) {
  const wf = workflow || "";
  const lower = lowerContent || "";

  if (wf === "food_scan") return true;
  if (!lower) return false;

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

  if (lower.includes("this meal") && /[0-9]{2,4}\s*(kcal|calories)/i.test(lower)) {
    return true;
  }
  if (lower.includes("plate") && /[0-9]{2,4}\s*(kcal|calories)/i.test(lower)) {
    return true;
  }

  return false;
}

function extractCaloriesFromText(text) {
  if (!text) return null;
  const m = text.match(/([0-9]{2,4})\s*(kcal|calories)/i);
  if (!m) return null;
  const val = parseInt(m[1], 10);
  if (Number.isNaN(val)) return null;
  return val;
}

// -------------------------------------------------------------------------
// handler
// -------------------------------------------------------------------------

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

    // ---- identity --------------------------------------------------------
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

    // ---- find user -------------------------------------------------------
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

    // ---- load messages ---------------------------------------------------
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
          take: 100, // keep a healthy buffer; front-end paginates 5-at-a-time
          select: {
            id: true,
            role: true,
            content: true,
            createdAt: true,
            workflow: true,
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

    // ---- last message timestamp ------------------------------------------
    let lastMessageAtIso = null;
    let lastMessageAtHuman = null;

    if (recentMessages.length > 0) {
      const last = recentMessages[0]; // newest because of desc order
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

    // ---- Weekly summary based on messages (last 7 days) ------------------
    let mealsThisWeek = 0;
    let bodyScansThisWeek = 0;
    let workoutsThisWeek = 0;
    let avgCaloriesPerDay = 0;

    try {
      const now = new Date();
      const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

      const weeklyMessages = await prisma.message.findMany({
        where: {
          conversation: { userId: user.id },
          role: "assistant",
          createdAt: { gte: weekAgo },
        },
        orderBy: { createdAt: "desc" },
        select: {
          content: true,
          createdAt: true,
          workflow: true,
        },
      });

      const caloriesByDay = {};

      weeklyMessages.forEach((m) => {
        const wf = m.workflow || "";
        const content = m.content || "";
        const lower = content.toLowerCase();

        const looksLikeMeal = isMealLike(wf, lower);
        const looksLikeWorkout =
          wf === "fitness_plan" ||
          lower.includes("workout plan") ||
          lower.includes("training plan") ||
          lower.includes("routine");
        const looksLikeBodyScan =
          wf === "body_scan" ||
          lower.includes("body scan") ||
          lower.includes("progress photos") ||
          lower.includes("progress picture");

        if (looksLikeMeal) {
          mealsThisWeek += 1;
          const calories = extractCaloriesFromText(content);
          if (typeof calories === "number") {
            const dayKey = m.createdAt.toISOString().slice(0, 10); // YYYY-MM-DD
            caloriesByDay[dayKey] =
              (caloriesByDay[dayKey] || 0) + calories;
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
    } catch (err) {
      console.error(
        "[Exerbud] exerbud-account: error computing weekly summary from messages:",
        err && err.message ? err.message : err
      );
      // leave summary numbers as 0 if anything goes wrong
    }

    const summary = {
      mealsThisWeek,
      bodyScansThisWeek,
      workoutsThisWeek,
      avgCaloriesPerDay,
    };

    // ---- uploads preview -------------------------------------------------
    let uploadsPreview = [];

    try {
      const uploads = await prisma.upload.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: "desc" },
        take: 9,
        select: {
          id: true,
          url: true,
          type: true,
          workflow: true,
          createdAt: true,
          conversationId: true,
        },
      });

      const workflowLabelMap = {
        food_scan: "Food scan",
        body_scan: "Body scan",
        fitness_plan: "Workout plan",
      };

      uploadsPreview = await Promise.all(
        uploads.map(async (u) => {
          let messageId = null;

          try {
            if (u.conversationId) {
              let msg = await prisma.message.findFirst({
                where: {
                  conversationId: u.conversationId,
                  role: "assistant",
                  createdAt: { gte: u.createdAt },
                },
                orderBy: { createdAt: "asc" },
                select: { id: true },
              });

              if (!msg) {
                msg = await prisma.message.findFirst({
                  where: {
                    conversationId: u.conversationId,
                    createdAt: { lte: u.createdAt },
                  },
                  orderBy: { createdAt: "desc" },
                  select: { id: true },
                });
              }

              messageId = msg?.id || null;
            }
          } catch (e) {
            console.error(
              "[Exerbud] Failed to attach messageId to upload:",
              e && e.message ? e.message : e
            );
          }

          const label =
            workflowLabelMap[u.workflow] ||
            u.type ||
            "Upload";

          const looksLikeImageType =
            typeof u.type === "string" && u.type.indexOf("image/") === 0;
          const looksLikeImageUrl =
            typeof u.url === "string" &&
            /\.(png|jpe?g|webp|gif|heic)$/i.test(u.url);

          const looksLikeImage = looksLikeImageType || looksLikeImageUrl;
          const mimeType = looksLikeImage ? (u.type || "image/*") : null;

          return {
            id: u.id,
            url: u.url,
            messageId,
            mimeType,
            fileName: label,
            createdAt: u.createdAt.toISOString(),
          };
        })
      );
    } catch (err) {
      console.error(
        "[Exerbud] exerbud-account: DB error loading uploads:",
        err && err.message ? err.message : err
      );
      uploadsPreview = [];
    }

    // ---- final response --------------------------------------------------
    return res.status(200).json({
      hasData: true,
      totalMessages,
      lastMessageAtIso,
      lastMessageAtHuman,
      recentMessages: recentMessages.map((m) => ({
        messageId: m.id,
        role: m.role,
        content: m.content,
        createdAt: m.createdAt.toISOString(),
        workflow: m.workflow || null,
      })),
      summary,
      uploadsPreview,
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
