// lib/claude.js
// Thin wrapper around the Anthropic Messages API (no SDK dependency needed - uses global fetch).

const { SYSTEM_PROMPT } = require("./knowledge");

const MODEL = process.env.CLAUDE_MODEL || "claude-haiku-4-5-20251001";
const API_KEY = process.env.ANTHROPIC_API_KEY;

/**
 * @param {string} userMessage - the incoming text from the customer
 * @param {Array<{role: "user"|"assistant", content: string}>} history - prior turns, oldest first
 * @param {"ar"|"en"} [lang] - if known, the language this conversation has been running in so
 *   far (e.g. detected from the customer's first WhatsApp message). Passing this stops the
 *   model drifting back to Arabic mid-conversation on short/ambiguous later messages.
 * @returns {Promise<string>} the AI-generated reply text
 */
async function getAiReply(userMessage, history = [], lang) {
  if (!API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }

  const messages = [
    ...history.map((h) => ({ role: h.role, content: h.content })),
    { role: "user", content: userMessage },
  ];

  let systemPrompt = SYSTEM_PROMPT;
  if (lang === "en") {
    systemPrompt +=
      "\n\nملحوظة مهمة: العميل ده بيتكلم إنجليزي طول المحادثة دي - رد عليه بالإنجليزي بس، حتى لو رسالته الحالية قصيرة جدًا أو غامضة أو مجرد رقم، لأن ده معناه إنه بيرد على سؤال سابق مش بيبدأ لغة جديدة.";
  } else if (lang === "ar") {
    systemPrompt +=
      "\n\nملحوظة مهمة: العميل ده بيتكلم عربي طول المحادثة دي - رد عليه بالعربي بس، حتى لو رسالته الحالية قصيرة جدًا أو غامضة.";
  }

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 300,
      system: systemPrompt,
      messages,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Claude API error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  const textBlock = (data.content || []).find((c) => c.type === "text");
  return textBlock ? textBlock.text.trim() : "معلش، ممكن تعيد سؤالك بطريقة تانية؟";
}

/**
 * Tries to pull structured booking details (name, phone, service, date, time, otherTopics) out
 * of a conversation transcript. Returns null if any of the 5 required fields isn't clearly
 * present yet (still mid-conversation) - the caller should fall back to just logging raw notes
 * in that case.
 *
 * @param {string} conversationText - the recent conversation, one line per turn
 * @returns {Promise<{name:string, phone:string, service:string, date:string, time:string, otherTopics:string}|null>}
 */
async function extractBookingDetails(conversationText) {
  if (!API_KEY) return null;

  const prompt = `From the conversation below, check if the customer has clearly provided ALL FIVE of: their name, a phone number, the service/package they want, an appointment date, and an appointment time.

If even one of these five is missing, unclear, or vague (like "tomorrow" or "soon" instead of an actual date), respond with exactly the single word: NONE

If all five are clearly present, respond with ONLY a compact JSON object, no markdown, no explanation, in this exact shape:
{"name":"...","phone":"...","service":"...","date":"...","time":"...","otherTopics":"..."}

Important for the "service" field: if the customer mentioned MORE THAN ONE thing they're interested in (for example a specific treatment like a root canal AND one of the opening-day packages), include ALL of them in the "service" field, separated by " / " - do not drop any of them and do not collapse them into just one.

For the "otherTopics" field: write a short phrase in Arabic noting any OTHER subject the customer asked about or discussed that is separate from the booking itself (for example: سأل عن التأمين، سأل عن أماكن الانتظار، سأل عن خطط الدفع، سأل عن علاج الأطفال). If nothing else was discussed, use an empty string "".

Conversation:
${conversationText}`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 200,
        system: "You are a precise data-extraction tool. Output only what is asked, nothing else - no greetings, no explanations.",
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!res.ok) return null;
    const data = await res.json();
    const textBlock = (data.content || []).find((c) => c.type === "text");
    const raw = textBlock ? textBlock.text.trim() : "";

    if (!raw || raw === "NONE") return null;

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);
    if (parsed.name && parsed.phone && parsed.service && parsed.date && parsed.time) {
      return parsed;
    }
    return null;
  } catch (err) {
    console.error("extractBookingDetails failed:", err.message);
    return null;
  }
}

module.exports = { getAiReply, extractBookingDetails };
