// server.js
// Denova Dental Clinic - unified webhook server for:
//   - Meta (Messenger + Instagram) DM auto-replies + comment auto-replies, via Claude AI
//   - WhatsApp Cloud API interactive list menu + guided sub-flows
//   - Live lead logging to a Google Sheet
//
// See README.md for full setup (Meta app, WhatsApp number migration, Google service
// account, and deployment) before running this in production.

require("dotenv").config();
const express = require("express");

const { getAiReply, extractBookingDetails } = require("./lib/claude");
const { sendMetaText, parseMetaWebhookEvents, sendCommentReply, sendPrivateReply } = require("./lib/metaMessenger");
const { sendWhatsAppText, sendWhatsAppList, parseWhatsAppWebhookEvents } = require("./lib/whatsapp");
const { WHATSAPP_MAIN_MENU, MENU_REPLIES } = require("./lib/knowledge");
const { getConversation, pushHistory, escalate } = require("./lib/state");
const { appendLead } = require("./lib/sheets");

const app = express();
app.use(express.json());

const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;
const WHATSAPP_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;

const ESCALATION_KEYWORDS = ["موظف", "حد يرد", "عايز اكلم حد", "حد بشري", "دكتور", "المسؤول"];

function wantsHuman(text = "") {
  return ESCALATION_KEYWORDS.some((kw) => text.includes(kw));
}

// Heuristic: a message that contains a run of 10+ digits is very likely someone
// sharing a phone number as part of booking details (name + number + date/time).
function looksLikeBookingDetails(text = "") {
  return /\d{10,}/.test(text.replace(/[\s\-()]/g, ""));
}

async function logLeadSafely(lead) {
  try {
    await appendLead(lead);
  } catch (err) {
    // Never let a logging failure break the customer-facing reply.
    console.error("Failed to log lead to Google Sheet:", err.message);
  }
}

app.get("/", (_req, res) => res.send("Denova bot is running."));

// ---------------------------------------------------------------------------
// META (Messenger + Instagram) webhook
// ---------------------------------------------------------------------------

app.get("/webhook/meta", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === META_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

app.post("/webhook/meta", async (req, res) => {
  res.sendStatus(200); // ack immediately - Meta requires a fast response
  try {
    const events = parseMetaWebhookEvents(req.body);
    for (const event of events) {
      if (event.isComment) {
        await handleMetaComment(event);
      } else {
        await handleMetaMessage(event);
      }
    }
  } catch (err) {
    console.error("Error handling Meta webhook:", err);
  }
});

async function handleMetaComment(event) {
  // Public comment reply: short, friendly, invites to DM.
  await sendCommentReply(event.commentId, "شكرًا لتواصلك! بعتنالك رسالة على الخاص فيها كل التفاصيل 🙏").catch((e) =>
    console.error(e.message)
  );
  // Private reply (arrives as a Messenger DM to the commenter) - this is where real info goes.
  await sendPrivateReply(
    event.commentId,
    "أهلاً بيك في Denova Dental Clinic! يسعدنا اهتمامك. تحب تعرف تفاصيل عروض الافتتاح، ولا تحجز كشف على طول؟"
  ).catch((e) => console.error(e.message));

  await logLeadSafely({
    name: "",
    phone: "",
    source: "تعليق ميتا",
    status: "عميل جديد",
    notes: `تعليق: ${event.text || ""}`,
  });
}

async function handleMetaMessage(event) {
  const { platform, senderId, text } = event;
  const convo = getConversation(platform, senderId);
  const isFirstContact = convo.history.length === 0 && !convo.escalated;

  if (convo.escalated) {
    // A human already took over this conversation - stay silent, just observe.
    return;
  }

  if (wantsHuman(text)) {
    escalate(platform, senderId);
    await sendMetaText(platform, senderId, "تمام، هيتواصل معاك حد من فريق العيادة في أقرب وقت. شكرًا لصبرك 🙏");
    await logLeadSafely({
      source: platform === "instagram" ? "انستجرام" : "ماسنجر",
      status: "عميل جديد",
      notes: "طلب التحدث مع موظف بشري",
    });
    return;
  }

  pushHistory(platform, senderId, "user", text);
  const reply = await getAiReply(text, convo.history.slice(0, -1));
  pushHistory(platform, senderId, "assistant", reply);
  await sendMetaText(platform, senderId, reply);

  if (isFirstContact) {
    await logLeadSafely({
      source: platform === "instagram" ? "انستجرام" : "ماسنجر",
      status: "عميل جديد",
      notes: `أول رسالة: ${text}`,
    });
  } else if (looksLikeBookingDetails(text)) {
    // Likely the customer just sent name + phone + preferred date/time in free chat.
    // Try to pull structured fields out of the conversation so the sheet gets real columns,
    // not just a notes blob.
    const transcript = convo.history.map((h) => `${h.role === "user" ? "Customer" : "Clinic"}: ${h.content}`).join("\n");
    const details = await extractBookingDetails(transcript);
    if (details) {
      await logLeadSafely({
        name: details.name,
        phone: details.phone,
        source: platform === "instagram" ? "انستجرام" : "ماسنجر",
        packageInterest: details.service,
        appointmentDate: details.date,
        appointmentTime: details.time,
        status: "تم الحجز",
        notes: "تفاصيل حجز تم استخراجها تلقائيًا من المحادثة.",
      });
    } else {
      await logLeadSafely({
        source: platform === "instagram" ? "انستجرام" : "ماسنجر",
        status: "تم الحجز",
        notes: `تفاصيل حجز مرسلة من العميل: ${text}`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// WHATSAPP CLOUD API webhook
// ---------------------------------------------------------------------------

app.get("/webhook/whatsapp", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

app.post("/webhook/whatsapp", async (req, res) => {
  res.sendStatus(200);
  try {
    const events = parseWhatsAppWebhookEvents(req.body);
    for (const event of events) {
      await handleWhatsAppEvent(event);
    }
  } catch (err) {
    console.error("Error handling WhatsApp webhook:", err);
  }
});

async function handleWhatsAppEvent(event) {
  const { from, type, text, listId, name } = event;
  const convo = getConversation("whatsapp", from);

  if (convo.escalated) return; // human has taken over

  // 1) Explicit human handoff, any time.
  if (type === "text" && wantsHuman(text)) {
    escalate("whatsapp", from);
    await sendWhatsAppText(from, MENU_REPLIES.MENU_HUMAN);
    await logLeadSafely({ name, phone: from, source: "واتساب", status: "عميل جديد", notes: "طلب التحدث مع موظف بشري" });
    return;
  }

  // 2) List selection.
  if (type === "list_reply") {
    if (listId === "MENU_BOOK") {
      convo.step = "awaiting_booking_details";
      await sendWhatsAppText(from, "تمام! قولي اسمك الكريم والميعاد اللي يناسبك (اليوم والوقت) وهنأكد لك.");
      return;
    }
    const canned = MENU_REPLIES[listId];
    if (canned) {
      await sendWhatsAppText(from, canned);
      await logLeadSafely({
        name,
        phone: from,
        source: "واتساب",
        status: "عميل جديد",
        notes: `اختار من القايمة: ${text}`,
      });
    }
    return;
  }

  // 3) Free text while we're waiting for booking details.
  if (convo.step === "awaiting_booking_details") {
    convo.step = null;
    await sendWhatsAppText(from, "تم استلام طلبك! هيتم تأكيد الميعاد من فريق العيادة قريب. شكرًا ليك 🙏");

    const transcript = `Customer phone number: ${from}\nCustomer message: ${text}`;
    const details = await extractBookingDetails(transcript);
    if (details) {
      await logLeadSafely({
        name: details.name,
        phone: details.phone || from,
        source: "واتساب",
        packageInterest: details.service,
        appointmentDate: details.date,
        appointmentTime: details.time,
        status: "تم الحجز",
        notes: "تفاصيل حجز تم استخراجها تلقائيًا من المحادثة.",
      });
    } else {
      await logLeadSafely({
        name,
        phone: from,
        source: "واتساب",
        status: "تم الحجز",
        notes: `تفاصيل الحجز كما أرسلها العميل: ${text}`,
      });
    }
    return;
  }

  // 4) First-ever contact -> send the interactive menu instead of free AI chat.
  if (!convo.seenMenu) {
    convo.seenMenu = true;
    await sendWhatsAppList(from, WHATSAPP_MAIN_MENU);
    await logLeadSafely({ name, phone: from, source: "واتساب", status: "عميل جديد", notes: `أول رسالة: ${text}` });
    return;
  }

  // 5) Anything else -> fall back to the AI for a free-form, on-brand reply.
  pushHistory("whatsapp", from, "user", text);
  const reply = await getAiReply(text, convo.history.slice(0, -1));
  pushHistory("whatsapp", from, "assistant", reply);
  await sendWhatsAppText(from, reply);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Denova bot listening on port ${PORT}`));

module.exports = app;
