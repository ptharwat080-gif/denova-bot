// lib/state.js
// Minimal in-memory conversation state, keyed by "platform:senderId".
// NOTE: this resets whenever the server restarts (fine for a small clinic's volume
// to start with). If you outgrow it, swap this module for a Redis or database-backed
// store without touching the webhook handlers.

const conversations = new Map();

function key(platform, senderId) {
  return `${platform}:${senderId}`;
}

function getConversation(platform, senderId) {
  const k = key(platform, senderId);
  if (!conversations.has(k)) {
    conversations.set(k, {
      history: [], // [{role, content}]
      escalated: false, // true once a human has been requested - AI stops replying
      seenMenu: false, // whether the WhatsApp main menu was already sent
      lastActivity: Date.now(),
    });
  }
  return conversations.get(k);
}

function pushHistory(platform, senderId, role, content) {
  const convo = getConversation(platform, senderId);
  convo.history.push({ role, content });
  convo.lastActivity = Date.now();
  // keep only the last 10 turns to bound memory + token usage
  if (convo.history.length > 10) convo.history = convo.history.slice(-10);
  return convo;
}

function escalate(platform, senderId) {
  const convo = getConversation(platform, senderId);
  convo.escalated = true;
  return convo;
}

module.exports = { getConversation, pushHistory, escalate };
