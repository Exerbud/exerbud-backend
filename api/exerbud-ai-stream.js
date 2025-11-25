// api/exerbud-ai-stream.js

// Tiny, self-contained streaming backend for Exerbud
// - Uses OpenAI's Chat Completions streaming API
// - Supports "coach styles" (strength, hypertrophy, etc.)
// - Accepts prior conversation history
// - Emits Server-Sent Events (SSE) so the frontend can stream text

import OpenAI from "openai";

// -------------- CONFIG --------------

// You can keep this as-is; the key is read from env.
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Helper so we can tweak temperature etc. in one place
function exerbudModelConfig() {
  return {
    model: "gpt-4.1-mini",
    temperature: 0.7,
    max_tokens: 1200,
  };
}

// -------------- UTILS --------------

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function handleOptions(req, res) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders());
    res.end();
    return true;
  }
  return false;
}

// Very small sanitizer for history entries coming from the UI
function sanitizeHistory(rawHistory) {
  if (!Array.isArray(rawHistory)) return [];

  return rawHistory
    .map((m) => {
      const role = m.role === "assistant" ? "assistant" : "user";
      const content = typeof m.content === "string" ? m.content : "";
      return { role, content };
    })
    .filter((m) => m.content.trim().length > 0)
    .slice(-20); // last 20 messages max
}

// If we ever want to lightly normalize the assistant text AFTER the
// model finishes, we could plug that in here. For streaming we mostly
// rely on the frontend to handle formatting.
function normalizeAssistantText(text) {
  if (!text) return "";
  return text.replace(/\s+$/g, "").replace(/\r\n/g, "\n");
}

// -------------- COACH PROFILES --------------

const coachStyles = {
  strength: {
    name: "Strength coach",
    stylePrompt: `
You are coaching someone primarily focused on getting stronger with compound lifts.
Emphasize:
- Progressive overload on core movements (squats, deadlifts, bench, overhead press, rows, pull-ups).
- Low-to-moderate rep ranges (3–8) for main lifts and slightly higher reps (8–12) for accessories.
- Good warm-ups, bracing, and safe technique.
- Clear, sustainable weekly structure (e.g. 3–5 days).
`.trim(),
  },
  hypertrophy: {
    name: "Hypertrophy coach",
    stylePrompt: `
You are coaching someone focused on muscle gain and physique development.
Emphasize:
- Moderate rep ranges (6–15) with adequate volume for each muscle group.
- Exercise selection that covers all major muscle groups and movement patterns.
- Effort close to failure on working sets, while still being sustainable.
- Simple, repeatable weekly structure with room for progression.
`.trim(),
  },
  mobility: {
    name: "Mobility coach",
    stylePrompt: `
You are coaching someone focused on mobility, flexibility, and joint health.
Emphasize:
- Controlled, pain-free ranges of motion.
- Dynamic warm-ups, mobility flows, and targeted stretches.
- Breathing, posture, and joint stability.
- Progressions that feel approachable, not intimidating.
`.trim(),
  },
  fat_loss: {
    name: "Fat loss coach",
    stylePrompt: `
You are coaching someone whose main goal is fat loss and general health.
Emphasize:
- Sustainable activity: strength training + steps/cardio.
- Simple nutrition principles (not strict meal plans).
- Building habits and routines that can be maintained long term.
- Avoiding extreme claims or unsafely low calories.
`.trim(),
  },
};

// -------------- SYSTEM PROMPT BUILDER --------------

function buildSystemPrompt(coachProfile) {
  const base = `
You are Exerbud, a friendly and practical fitness coach helping people plan workouts and fitness routines.

Your job:
- Understand the user's current level, goals, schedule, equipment, and any limitations.
- Suggest realistic, sustainable workout plans and next steps.
- Explain things clearly without overwhelming jargon.
- Always stay within normal, safe fitness advice. Avoid diagnosing or prescribing medical treatment. If something sounds medical or risky, advise the user to consult a qualified professional.

Important communication rules:
- Speak in a friendly, encouraging tone, like a knowledgeable coach.
- Ask follow-up questions when you need more information to give a good answer.
- Be honest if you're uncertain or if the question is outside normal fitness guidance.
- Be considerate of time, energy, and recovery. Don't over-prescribe volume.
- If the user sounds overwhelmed, simplify and prioritize.

Safety:
- Never guarantee specific results (“lose 20 lbs in 2 weeks”, etc.).
- Avoid extreme diets or unsafely low calories.
- If the user mentions pain, serious injury, or medical conditions, recommend seeing a medical professional before doing anything strenuous.
- If the user hints at disordered eating or body image issues, respond gently and suggest professional support.

Output style:
- Start with 1–2 short sentences reflecting what you understood.
- Use short paragraphs (1–3 sentences) with a blank line between paragraphs — avoid giant walls of text.
- When asking the user multiple questions, ALWAYS format them as a numbered list, like:
  1. Question one
  2. Question two
  Each question must be on its own line, not run together in a single paragraph.
- When giving a workout plan, use clear headings (e.g. "Week 1 (and ongoing)", "Day 1 – Upper Body Push") and bullet points for exercises and notes, one exercise per line.
- End with 2–4 clear "Next steps" so the user knows exactly what to do.
- Whenever you provide a full, structured workout plan, end with:
  "If you’d like, I can also turn this into a downloadable PDF — just say “export this as a PDF.”"

The user is interacting through a custom UI that can export your plans as TXT, CSV, or PDF.
Do NOT say you are unable to create or send files — instead, say something like:
"If you’d like, I can also turn this into a downloadable PDF — just say “export this as a PDF.” and the Exerbud app can handle exporting."
`.trim();

  const style = coachStyles[coachProfile]?.stylePrompt || "";

  let systemPrompt = base;
  if (style) {
    systemPrompt += `\n\nCoach style context (${coachStyles[coachProfile].name}):\n${style}`;
  }

  return systemPrompt;
}

// -------------- HANDLER --------------

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;

  if (req.method !== "POST") {
    res.writeHead(405, {
      ...corsHeaders(),
      "Content-Type": "application/json",
    });
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  try {
    let body = "";
    await new Promise((resolve, reject) => {
      req.on("data", (chunk) => {
        body += chunk.toString();
      });
      req.on("end", resolve);
      req.on("error", reject);
    });

    let parsed;
    try {
      parsed = JSON.parse(body || "{}");
    } catch (e) {
      res.writeHead(400, {
        ...corsHeaders(),
        "Content-Type": "application/json",
      });
      res.end(JSON.stringify({ error: "Invalid JSON body" }));
      return;
    }

    const userMessage =
      typeof parsed.message === "string" ? parsed.message.trim() : "";
    const rawHistory = parsed.history || [];
    const coachProfile =
      typeof parsed.coachProfile === "string" ? parsed.coachProfile : null;

    if (!userMessage) {
      res.writeHead(400, {
        ...corsHeaders(),
        "Content-Type": "application/json",
      });
      res.end(JSON.stringify({ error: "Missing 'message' in request body" }));
      return;
    }

    const history = sanitizeHistory(rawHistory);

    // Build messages array for OpenAI Chat Completions
    const systemPrompt = buildSystemPrompt(coachProfile || "strength");

    const messages = [
      {
        role: "system",
        content: systemPrompt,
      },
      ...history.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      {
        role: "user",
        content: userMessage,
      },
    ];

    // ---- Streaming response ----
    res.writeHead(200, {
      ...corsHeaders(),
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });

    const config = exerbudModelConfig();

    const stream = await client.chat.completions.create({
      ...config,
      messages,
      stream: true,
    });

    let fullText = "";

    for await (const chunk of stream) {
      const choice = chunk.choices?.[0];
      const delta = choice?.delta?.content || "";

      if (!delta) continue;

      fullText += delta;
      // NOTE: we send the raw delta (including spaces) and let the frontend decide formatting.
      res.write(`data: ${delta}\n\n`);
    }

    res.write("data: [DONE]\n\n");
    res.end();
  } catch (err) {
    console.error("Exerbud streaming error:", err);
    if (!res.headersSent) {
      res.writeHead(500, {
        ...corsHeaders(),
        "Content-Type": "application/json",
      });
      res.end(JSON.stringify({ error: "Internal server error" }));
    } else {
      try {
        res.write(`data: [ERROR] Something went wrong on the server.\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      } catch (e) {
        // ignore
      }
    }
  }
};
