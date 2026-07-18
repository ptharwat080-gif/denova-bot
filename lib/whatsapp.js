// lib/whatsapp.js
// WhatsApp Cloud API helpers: send plain text, send an interactive list message,
// and parse incoming webhook payloads (text messages + list-reply selections).

const GRAPH_VERSION = "v20.0";
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;

function endpoint() {
  return `https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`;
}

async function callWhatsApp(payload) {
  if (!PHONE_NUMBER_ID || !WHATSAPP_TOKEN) {
    throw new Error("WHATSAPP_PHONE_NUMBER_ID or WHATSAPP_TOKEN is not set");
  }
  const res = await fetch(endpoint(), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${WHATSAPP_TOKEN}`,
    },
    body: JSON.stringify({ messaging_product: "whatsapp", ...payload }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`WhatsApp API error ${res.status}: ${errText}`);
  }
  return res.json();
}

async function sendWhatsAppText(to, body) {
  return callWhatsApp({
    to,
    type: "text",
    text: { body },
  });
}

async function sendWhatsAppList(to, menu) {
  return callWhatsApp({
    to,
    type: "interactive",
    interactive: {
      type: "list",
      header: { type: "text", text: menu.header },
      body: { text: menu.body },
      footer: { text: menu.footer },
      action: {
        button: menu.button,
        sections: menu.sections,
      },
    },
  });
}

/**
 * Parses a raw WhatsApp Cloud API webhook body into a flat list of simplified events.
 * Returns { from, type: "text"|"list_reply", text, listId, name }
 */
function parseWhatsAppWebhookEvents(body) {
  const events = [];
  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      const contacts = value.contacts || [];
      for (const msg of value.messages || []) {
        const contact = contacts.find((c) => c.wa_id === msg.from);
        const name = contact && contact.profile ? contact.profile.name : undefined;

        if (msg.type === "text") {
          events.push({ from: msg.from, type: "text", text: msg.text.body, name });
        } else if (msg.type === "interactive" && msg.interactive.type === "list_reply") {
          events.push({
            from: msg.from,
            type: "list_reply",
            listId: msg.interactive.list_reply.id,
            text: msg.interactive.list_reply.title,
            name,
          });
        }
      }
    }
  }
  return events;
}

module.exports = { sendWhatsAppText, sendWhatsAppList, parseWhatsAppWebhookEvents };
