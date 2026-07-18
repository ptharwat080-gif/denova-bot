// lib/claude.js
// Thin wrapper around the Anthropic Messages API (no SDK dependency needed - uses global fetch).

const { SYSTEM_PROMPT } = require("./knowledge");

const MODEL = process.env.CLAUDE_MODEL || "claude-haiku-4-5-20251001";
const API_KEY = process.env.ANTHROPIC_API_KEY;

/**
 * @param {string} userMessage - the incoming text from the customer
 * @param {Array<{role: "user"|"assistant", content: string}>} history - prior turns, oldest first
 * @returns {Promise<string>} the AI-generated reply text
 */
async function getAiReply(userMessage, history = []) {
  if (!API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }

  const messages = [
    ...history.map((h) => ({ role: h.role, content: h.content })),
    { role: "user", content: userMessage },
  ];

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
      system: SYSTEM_PROMPT,
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

module.exports = { getAiReply };
