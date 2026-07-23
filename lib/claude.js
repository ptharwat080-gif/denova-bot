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
      max_tokens: 700,
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
 * Pulls WHATEVER booking details are clearly stated so far out of a conversation transcript -
 * name, phone, service, date, time - each one independently, not all-or-nothing. This matters
 * most on Messenger/Instagram, where (unlike WhatsApp) there's no phone number attached to the
 * conversation automatically, so a customer who gives just their name in one message needs that
 * name saved immediately, not held back until every other field also happens to be present.
 *
 * Returns null only if NOTHING at all identifiable has been given yet. Otherwise returns an
 * object with whichever fields were found (missing ones omitted) plus `complete: true/false`
 * telling the caller whether all five required fields are now present (safe to mark as booked).
 *
 * @param {string} conversationText - the recent conversation, one line per turn
 * @returns {Promise<{name?:string, phone?:string, service?:string, date?:string, time?:string, otherTopics?:string, complete:boolean}|null>}
 */
async function extractBookingDetails(conversationText) {
  if (!API_KEY) return null;

  const prompt = `From the conversation below, pull out whatever the customer has CLEARLY stated so far about their booking. Extract each field independently - do not wait for all of them to be present.

Fields: name (their name), phone (a phone number), service (the treatment/package they're interested in), date (an actual appointment date - not vague words like "tomorrow" or "soon"), time (an actual appointment time).

If NONE of these five fields has been clearly stated anywhere in the conversation, respond with exactly the single word: NONE

Otherwise respond with ONLY a compact JSON object, no markdown, no explanation, in this exact shape - omit any key whose field was not clearly stated (do not guess or invent values):
{"name":"...","phone":"...","service":"...","date":"...","time":"...","otherTopics":"..."}

Important for the "service" field: if the customer mentioned MORE THAN ONE thing they're interested in (for example a specific treatment like a root canal AND one of the opening-day packages), include ALL of them in the "service" field, separated by " / " - do not drop any of them and do not collapse them into just one.

For the "otherTopics" field: write a short phrase in Arabic noting any OTHER subject the customer asked about or discussed that is separate from the booking itself (for example: سأل عن التأمين، سأل عن أماكن الانتظار، سأل عن خطط الدفع، سأل عن علاج الأطفال). Omit this key entirely if nothing else was discussed.

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
    // Drop empty/whitespace-only values the model may still emit for an omitted field.
    for (const field of ["name", "phone", "service", "date", "time", "otherTopics"]) {
      if (parsed[field] != null && !String(parsed[field]).trim()) delete parsed[field];
    }

    if (!parsed.name && !parsed.phone && !parsed.service && !parsed.date && !parsed.time) {
      return null; // nothing usable came back despite not being the literal "NONE" string
    }

    parsed.complete = Boolean(parsed.name && parsed.phone && parsed.service && parsed.date && parsed.time);
    return parsed;
  } catch (err) {
    console.error("extractBookingDetails failed:", err.message);
    return null;
  }
}

module.exports = { getAiReply, extractBookingDetails };
