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
const { WHATSAPP_MAIN_MENU, MENU_REPLIES, WHATSAPP_MAIN_MENU_EN, MENU_REPLIES_EN } = require("./lib/knowledge");
const { getConversation, pushHistory, escalate } = require("./lib/state");
const { appendLead, updateLeadRow } = require("./lib/sheets");

const app = express();
app.use(express.json());

const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;
const WHATSAPP_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;

const ESCALATION_KEYWORDS = [
  "موظف",
  "حد يرد",
  "عايز اكلم حد",
  "حد بشري",
  "دكتور",
  "المسؤول",
  "human",
  "agent",
  "representative",
  "real person",
  "talk to someone",
  "speak to someone",
];

function wantsHuman(text = "") {
  const lower = text.toLowerCase();
  return ESCALATION_KEYWORDS.some((kw) => lower.includes(kw.toLowerCase()));
}

// Simple language detection: if the message contains any Arabic-script characters,
// treat the conversation as Arabic; otherwise treat it as English. Used to pick the
// right interactive-menu language and canned-reply language for WhatsApp.
function isArabicText(text = "") {
  return /[؀-ۿ]/.test(text);
}

// Normalizes a phone number for comparison (strips spaces, dashes, parens, +) so we can tell
// whether a number mentioned mid-booking is genuinely different from the number the customer
// is messaging from, rather than just formatted differently.
function normalizePhone(value = "") {
  return String(value).replace(/[^\d]/g, "");
}

// Heuristic: a message that contains a run of 10+ digits is very likely someone
// sharing a phone number as part of booking details (name + number + date/time).
function looksLikeBookingDetails(text = "") {
  return /\d{10,}/.test(text.replace(/[\s\-()]/g, ""));
}

// Bare-number replies mapped to opening-day packages, used right after we show the
// numbered offer list so a customer can just reply "1"/"2"/"3" (Arabic-Indic digits too).
const PACKAGE_BY_NUMBER = {
  "1": "Essential Clean",
  "2": "Complete Care",
  "3": "Bright Smile",
  "١": "Essential Clean",
  "٢": "Complete Care",
  "٣": "Bright Smile",
};

/**
 * Logs a lead against a conversation, keeping ONE row per conversation instead of a new row
 * per touchpoint. The first call appends a row and remembers its number on `convo.sheetRow`;
 * every later call for the same `convo` overwrites that same row, merging in only the fields
 * this call provides on top of whatever was already known (so a later call doesn't need to
 * repeat name/phone/source just to update, say, the package the customer picked).
 *
 * @param {object} convo - the conversation object from lib/state (or any object for one-off,
 *   non-conversational logs like public comments, which will always append a fresh row).
 * @param {object} lead - the fields to set/update.
 */
async function logLeadSafely(convo, lead) {
  // Always attach the latest full transcript, built fresh from convo.history (already kept in
  // memory for the AI's own context) - no extra API call, no extra cost, just re-serializing
  // text we already have, so the clinic can read any conversation directly from the sheet.
  const transcript =
    convo.history && convo.history.length
      ? convo.history.map((h) => `${h.role === "user" ? "العميل" : "العيادة"}: ${h.content}`).join("\n")
      : undefined;

  const merged = { ...(convo.leadData || {}), ...lead, ...(transcript ? { transcript } : {}) };
  console.log("Logging lead to Google Sheet:", JSON.stringify(merged));
  try {
    if (convo.sheetRow) {
      await updateLeadRow(convo.sheetRow, merged);
    } else {
      convo.sheetRow = await appendLead(merged);
    }
    convo.leadData = merged;
    console.log("Successfully logged lead to Google Sheet.");
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

  await logLeadSafely(
    {},
    {
      source: "تعليق ميتا",
      status: "عميل جديد",
      notes: `تعليق: ${event.text || ""}`,
    }
  );
}

async function handleMetaMessage(event) {
  const { platform, senderId, text } = event;
  const convo = getConversation(platform, senderId);
  const isFirstContact = convo.history.length === 0 && !convo.escalated;

  if (convo.escalated) {
    // A human already took over this conversation - stay silent, just observe.
    return;
  }

  // Log the contact immediately, before doing anything that could fail (AI call, send call).
  // This way, even if something breaks downstream, we still have a record that this person
  // reached out - never lose a lead just because a later step errored.
  if (!convo.sheetRow) {
    await logLeadSafely(convo, {
      source: platform === "instagram" ? "انستجرام" : "ماسنجر",
      status: "عميل جديد",
      notes: `أول رسالة: ${text}`,
    });
  }

  if (wantsHuman(text)) {
    escalate(platform, senderId);
    await sendMetaText(platform, senderId, "تمام، هيتواصل معاك حد من فريق العيادة في أقرب وقت. شكرًا لصبرك 🙏");
    await logLeadSafely(convo, {
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

  // Check the WHOLE conversation so far, not just this one message, for booking details -
  // the AI often collects name/phone/service/date/time naturally across several messages,
  // and we don't want to miss it just because the phone number appeared a few turns back.
  if (!isFirstContact && (!convo.leadData || convo.leadData.status !== "تم الحجز")) {
    const transcript = convo.history.map((h) => `${h.role === "user" ? "Customer" : "Clinic"}: ${h.content}`).join("\n");
    if (looksLikeBookingDetails(transcript)) {
      const details = await extractBookingDetails(transcript);
      if (details) {
        await logLeadSafely(convo, {
          name: details.name,
          phone: details.phone,
          source: platform === "instagram" ? "انستجرام" : "ماسنجر",
          packageInterest: details.service,
          appointmentDate: details.date,
          appointmentTime: details.time,
          status: "تم الحجز",
          otherTopics: details.otherTopics || "",
          notes: "تفاصيل حجز تم استخراجها تلقائيًا من المحادثة.",
        });
      } else {
        await logLeadSafely(convo, {
          source: platform === "instagram" ? "انستجرام" : "ماسنجر",
          notes: `آخر رسالة: ${text}`,
        });
      }
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
  console.log("WhatsApp webhook raw payload:", JSON.stringify(req.body));
  try {
    const events = parseWhatsAppWebhookEvents(req.body);
    console.log(`WhatsApp webhook parsed ${events.length} event(s).`);
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

  // Detect and remember the customer's language from the first real text they send, so every
  // canned reply and menu after this matches it - not just the free-form AI replies.
  if (type === "text" && text && !convo.lang) {
    convo.lang = isArabicText(text) ? "ar" : "en";
  }
  const lang = convo.lang || "ar";
  const menu = lang === "en" ? WHATSAPP_MAIN_MENU_EN : WHATSAPP_MAIN_MENU;
  const replies = lang === "en" ? MENU_REPLIES_EN : MENU_REPLIES;

  // Log the phone number immediately on first contact, before anything that could fail
  // (AI call, WhatsApp send call). This way we always have a way to reach this person back,
  // even if a later step in this same message errors out.
  if (!convo.sheetRow && from) {
    await logLeadSafely(convo, { phone: from, source: "واتساب", status: "عميل جديد", notes: `أول رسالة: ${text || ""}` });
  }

  // 1) Explicit human handoff, any time.
  if (type === "text" && wantsHuman(text)) {
    escalate("whatsapp", from);
    await sendWhatsAppText(from, replies.MENU_HUMAN);
    await logLeadSafely(convo, { phone: from, source: "واتساب", status: "عميل جديد", notes: "طلب التحدث مع موظف بشري" });
    return;
  }

  // 1.5) Customer replying with just a package number after we showed the numbered offers.
  if (type === "text" && convo.awaitingPackageChoice) {
    convo.awaitingPackageChoice = false;
    const packageName = PACKAGE_BY_NUMBER[text.trim()];
    if (packageName) {
      convo.step = "awaiting_booking_details";
      await logLeadSafely(convo, { phone: from, source: "واتساب", packageInterest: packageName, status: "مهتم بباقة" });
      await sendWhatsAppText(from, replies.BOOKING_START);
      return;
    }
    // Not a bare number reply - fall through to normal handling below.
  }

  // 2) List selection.
  if (type === "list_reply") {
    if (listId === "MENU_BOOK") {
      convo.step = "awaiting_booking_details";
      await sendWhatsAppText(from, replies.BOOKING_START);
      return;
    }
    const canned = replies[listId];
    if (canned) {
      await sendWhatsAppText(from, canned);
      if (listId === "MENU_OFFER") {
        convo.awaitingPackageChoice = true;
      }
      await logLeadSafely(convo, {
        phone: from,
        source: "واتساب",
        status: "عميل جديد",
        notes: `اختار من القايمة: ${text}`,
      });
    } else {
      // Unknown/unexpected list id - don't go silent, let them know how to continue.
      await sendWhatsAppText(from, replies.UNRECOGNIZED_SELECTION);
    }
    return;
  }

  // 3) Free text while we're waiting for booking details.
  if (convo.step === "awaiting_booking_details") {
    convo.step = null;
    await sendWhatsAppText(from, replies.BOOKING_RECEIVED);

    const transcript = `Customer phone number: ${from}\nCustomer message: ${text}`;
    const details = await extractBookingDetails(transcript);
    if (details) {
      const altPhone =
        details.phone && normalizePhone(details.phone) !== normalizePhone(from) ? details.phone : "";
      await logLeadSafely(convo, {
        name: details.name,
        phone: from, // always keep the real WhatsApp contact number in this column
        altPhone,
        source: "واتساب",
        packageInterest: details.service,
        appointmentDate: details.date,
        appointmentTime: details.time,
        status: "تم الحجز",
        otherTopics: details.otherTopics || "",
        notes: "تفاصيل حجز تم استخراجها تلقائيًا من المحادثة.",
      });
    } else {
      // Extraction failed because this first reply didn't contain all 5 details yet (e.g. the
      // customer just said "I have pain" instead of giving name/date/time). Do NOT mark this as
      // "تم الحجز" (booked) - that would stop us from ever re-checking the conversation later,
      // even after the customer goes on to complete the booking naturally in later messages.
      await logLeadSafely(convo, {
        phone: from,
        source: "واتساب",
        status: "في انتظار تفاصيل الحجز",
        notes: `آخر رسالة أثناء الحجز: ${text}`,
      });
    }
    return;
  }

  // 4) First-ever contact -> actually answer their message like a real receptionist would
  // (same as Messenger/Instagram), then also send the quick-options menu as a follow-up so
  // they know it's there if they'd rather tap through instead of typing.
  if (!convo.seenMenu) {
    convo.seenMenu = true;
    pushHistory("whatsapp", from, "user", text);
    const reply = await getAiReply(text, convo.history.slice(0, -1), convo.lang);
    pushHistory("whatsapp", from, "assistant", reply);
    await sendWhatsAppText(from, reply);
    await sendWhatsAppList(from, menu);
    return;
  }

  // 5) Anything else -> fall back to the AI for a free-form, on-brand reply.
  pushHistory("whatsapp", from, "user", text);
  const reply = await getAiReply(text, convo.history.slice(0, -1), convo.lang);
  pushHistory("whatsapp", from, "assistant", reply);
  await sendWhatsAppText(from, reply);
  console.log(`WhatsApp reply sent to ${from}.`);

  // The AI often collects full booking details (name, service, date, time) naturally across
  // several plain-chat messages, without the customer ever tapping the booking menu button.
  // Check the WHOLE conversation so far after every reply so this still gets captured.
  if (!convo.leadData || convo.leadData.status !== "تم الحجز") {
    const transcript = convo.history.map((h) => `${h.role === "user" ? "Customer" : "Clinic"}: ${h.content}`).join("\n");
    if (looksLikeBookingDetails(transcript)) {
      const details = await extractBookingDetails(transcript);
      if (details) {
        const altPhone =
          details.phone && normalizePhone(details.phone) !== normalizePhone(from) ? details.phone : "";
        await logLeadSafely(convo, {
          name: details.name,
          phone: from, // always keep the real WhatsApp contact number in this column
          altPhone,
          source: "واتساب",
          packageInterest: details.service,
          appointmentDate: details.date,
          appointmentTime: details.time,
          status: "تم الحجز",
          otherTopics: details.otherTopics || "",
          notes: "تفاصيل حجز تم استخراجها تلقائيًا من المحادثة.",
        });
      }
    }
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Denova bot listening on port ${PORT}`));

module.exports = app;
