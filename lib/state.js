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
      platform, // "whatsapp" | "messenger" | "instagram" - used to gate platform-specific sheet fields
      history: [], // [{role, content}]
      escalated: false, // true once a human has been requested - AI stops replying
      seenMenu: false, // whether the WhatsApp main menu was already sent
      lastActivity: Date.now(),
      hourAlertSent: false, // true once the 1-hour "customer went quiet" sheet note was written
      followUpSent: false, // true once the 4-hour re-engagement message was sent to the customer
    });
  }
  return conversations.get(k);
}

/**
 * Returns every tracked conversation as { platform, senderId, convo }, so a background job can
 * scan all of them (e.g. to follow up with customers who went quiet) without needing its own
 * copy of the key-parsing logic.
 */
function getAllConversations() {
  const result = [];
  for (const [k, convo] of conversations.entries()) {
    const sepIndex = k.indexOf(":");
    result.push({
      platform: k.slice(0, sepIndex),
      senderId: k.slice(sepIndex + 1),
      convo,
    });
  }
  return result;
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

module.exports = { getConversation, getAllConversations, pushHistory, escalate };
