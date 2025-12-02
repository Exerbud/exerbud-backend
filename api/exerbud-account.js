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

module.exports = async function handler(req, res) {
  // ------------------------------------------------------------------
  // CORS: allow your storefront origin
  // ------------------------------------------------------------------
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

    // --------------------------------------------------------------
    // Prisma
    // --------------------------------------------------------------
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

          // IMPORTANT: return a big chunk; frontend paginates 5 at a time
          take: 250, // tweak this if you want more/less history

          select: {
            id: true,
            role: true,
            content: true,
            createdAt: true,
            // If your Message model doesn't have this, remove it:
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
    // Weekly Progress Summary (real stats using ProgressEvent)
    // --------------------------------------------------------------
    let mealsThisWeek = 0;
    let bodyScansThisWeek = 0;
    let workoutsThisWeek = 0;
    let avgCaloriesPerDay = 0;

    try {
      const now = new Date();
      const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

      const weeklyEvents = await prisma.progressEvent.findMany({
        where: {
          userId: user.id,
          createdAt: { gte: weekAgo },
        },
        select: {
          type: true,
          createdAt: true,
          payload: true,
        },
      });

      const caloriesByDay = {};

      weeklyEvents.forEach((ev) => {
        switch (ev.type) {
          case "meal_log":
            mealsThisWeek += 1;
            if (ev.payload && typeof ev.payload === "object") {
              const p = ev.payload;
              const calories =
                p.calories ??
                p.kcal ??
                p.caloriesTotal ??
                null;
              if (typeof calories === "number" && !Number.isNaN(calories)) {
                const dayKey = ev.createdAt.toISOString().slice(0, 10); // YYYY-MM-DD
                caloriesByDay[dayKey] =
                  (caloriesByDay[dayKey] || 0) + calories;
              }
            }
            break;
          case "body_scan":
            bodyScansThisWeek += 1;
            break;
          case "workout_plan":
            workoutsThisWeek += 1;
            break;
          default:
            // insight or other; ignore for the simple summary
            break;
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
        "[Exerbud] exerbud-account: DB error loading progress events:",
        err && err.message ? err.message : err
      );
      // leave summary values at 0 on error
    }

    const summary = {
      mealsThisWeek,
      bodyScansThisWeek,
      workoutsThisWeek,
      avgCaloriesPerDay,
    };

    // --------------------------------------------------------------
    // Recent uploads for Instagram-style grid
    // --------------------------------------------------------------
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

          // Try to find the closest relevant message in that conversation
          try {
            if (u.conversationId) {
              // Prefer the first assistant message *after* the upload
              let msg = await prisma.message.findFirst({
                where: {
                  conversationId: u.conversationId,
                  role: "assistant",
                  createdAt: { gte: u.createdAt },
                },
                orderBy: { createdAt: "asc" },
                select: { id: true },
              });

              // Fallback: the last message at or before the upload time
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

          // Guess if it's an image: MIME type or URL extension
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
            mimeType,         // used by frontend to decide image vs file tile
            fileName: label,  // used as overlay label in the grid
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

    // --------------------------------------------------------------
    // Final response: always hasData=true once user is resolved
    // --------------------------------------------------------------
    return res.status(200).json({
      hasData: true,
      totalMessages,
      lastMessageAtIso,
      lastMessageAtHuman,
      recentMessages: recentMessages.map((m) => ({
        id: m.id,
        messageId: m.id,                 // for deep links from dashboard
        role: m.role,
        content: m.content,
        workflow: m.workflow || null,    // remove if you don't have this column
        createdAt: m.createdAt.toISOString(),
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
