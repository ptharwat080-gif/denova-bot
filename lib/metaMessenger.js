// lib/metaMessenger.js
// Sends replies via the Meta Graph API for both Messenger (Facebook Page) and Instagram DMs.
// Both platforms use the same "Send API" shape once you have the right page access token.

const GRAPH_VERSION = "v20.0";
const PAGE_ACCESS_TOKEN = process.env.META_PAGE_ACCESS_TOKEN;

async function sendMetaText(recipientId, text) {
  if (!PAGE_ACCESS_TOKEN) {
    throw new Error("META_PAGE_ACCESS_TOKEN is not set");
  }

  const url = `https://graph.facebook.com/${GRAPH_VERSION}/me/messages?access_token=${PAGE_ACCESS_TOKEN}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      recipient: { id: recipientId },
      message: { text },
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Meta send API error ${res.status}: ${errText}`);
  }
  return res.json();
}

/**
 * Parses a raw Meta webhook body into a flat list of simplified events.
 * Handles both "page" (Messenger) and "instagram" objects.
 */
function parseMetaWebhookEvents(body) {
  const events = [];
  for (const entry of body.entry || []) {
    const platform = body.object === "instagram" ? "instagram" : "messenger";
    for (const msgEvent of entry.messaging || []) {
      if (msgEvent.message && msgEvent.message.text && !msgEvent.message.is_echo) {
        events.push({
          platform,
          senderId: msgEvent.sender.id,
          text: msgEvent.message.text,
          timestamp: msgEvent.timestamp,
        });
      }
    }
    // Comment events (feed changes) arrive under entry.changes for Page/Instagram comments
    for (const change of entry.changes || []) {
      if (change.field === "feed" && change.value && change.value.item === "comment") {
        events.push({
          platform,
          isComment: true,
          senderId: change.value.from && change.value.from.id,
          commentId: change.value.comment_id,
          text: change.value.message,
          timestamp: entry.time,
        });
      }
    }
  }
  return events;
}

async function sendCommentReply(commentId, message) {
  if (!PAGE_ACCESS_TOKEN) {
    throw new Error("META_PAGE_ACCESS_TOKEN is not set");
  }
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${commentId}/comments?access_token=${PAGE_ACCESS_TOKEN}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message }),
  });
  if (!res.ok) throw new Error(`Comment reply error ${res.status}: ${await res.text()}`);
  return res.json();
}

async function sendPrivateReply(commentId, message) {
  if (!PAGE_ACCESS_TOKEN) {
    throw new Error("META_PAGE_ACCESS_TOKEN is not set");
  }
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${commentId}/private_replies?access_token=${PAGE_ACCESS_TOKEN}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message }),
  });
  if (!res.ok) throw new Error(`Private reply error ${res.status}: ${await res.text()}`);
  return res.json();
}

module.exports = { sendMetaText, parseMetaWebhookEvents, sendCommentReply, sendPrivateReply };
