// lib/metaMessenger.js
// Sends replies via the Meta Graph API for both Messenger (Facebook Page) and Instagram DMs.
// IMPORTANT: these are NOT the same API despite both being "Meta" -
//   - Messenger: POST graph.facebook.com/<ver>/me/messages using the Facebook Page access token.
//   - Instagram: POST graph.instagram.com/<ver>/<IG_ID>/messages using the separate Instagram
//     User access token generated via Instagram business login. Using the Messenger token/host
//     for an Instagram recipient returns "(#100) No matching user found".

const GRAPH_VERSION = "v20.0";
const IG_GRAPH_VERSION = "v21.0";
const PAGE_ACCESS_TOKEN = process.env.META_PAGE_ACCESS_TOKEN;
const INSTAGRAM_ACCESS_TOKEN = process.env.INSTAGRAM_ACCESS_TOKEN;
const INSTAGRAM_ACCOUNT_ID = process.env.INSTAGRAM_ACCOUNT_ID || "17841426891211842";

async function sendMetaText(platform, recipientId, text) {
  if (platform === "instagram") {
    return sendInstagramText(recipientId, text);
  }
  return sendMessengerText(recipientId, text);
}

async function sendMessengerText(recipientId, text) {
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

async function sendInstagramText(recipientId, text) {
  if (!INSTAGRAM_ACCESS_TOKEN) {
    throw new Error("INSTAGRAM_ACCESS_TOKEN is not set");
  }

  const url = `https://graph.instagram.com/${IG_GRAPH_VERSION}/${INSTAGRAM_ACCOUNT_ID}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${INSTAGRAM_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      recipient: { id: recipientId },
      message: { text },
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Instagram send API error ${res.status}: ${errText}`);
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
