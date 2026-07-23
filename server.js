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
const { sendWhatsAppText, sendWhatsAppList, sendWhatsAppTemplate, parseWhatsAppWebhookEvents } = require("./lib/whatsapp");
const { WHATSAPP_MAIN_MENU, MENU_REPLIES, WHATSAPP_MAIN_MENU_EN, MENU_REPLIES_EN } = require("./lib/knowledge");
const { getConversation, getAllConversations, pushHistory, escalate } = require("./lib/state");
const { appendLead, updateLeadRow } = require("./lib/sheets");

const app = express();
app.use(express.json());

const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;
const WHATSAPP_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;

// The clinic's own WhatsApp number (doctor/reception) - digits only, country code, no + or spaces
// (e.g. "201104677046"). When a customer asks for a human on ANY platform, we proactively alert
// this number on WhatsApp with a summary, so the team can pick up the conversation with context.
const CLINIC_STAFF_WHATSAPP_NUMBER = process.env.CLINIC_STAFF_WHATSAPP_NUMBER;

// Optional second WhatsApp number (e.g. the clinic's old general-contact number) registered
// under the same WhatsApp Business Account as the primary bot number. If set, both numbers are
// handled identically by the bot; replies always go out from whichever number received the
// incoming message (see phoneNumberId on each parsed event).
const WHATSAPP_PHONE_NUMBER_ID_2 = process.env.WHATSAPP_PHONE_NUMBER_ID_2;

// Labels the sheet's "source" column so leads from the two numbers are distinguishable.
function whatsappSourceLabel(phoneNumberId) {
  if (WHATSAPP_PHONE_NUMBER_ID_2 && phoneNumberId === WHATSAPP_PHONE_NUMBER_ID_2) {
    return "واتساب (الرقم القديم)";
  }
  return "واتساب";
}

const ESCALATION_KEYWORDS = [
  "موظف",
  "حد يرد",
  "عايز اكلم حد",
  "حد بشري",
  "اتكلم مع الدكتور",
  "اتكلم مع دكتور",
  "المسؤول",
  "الريسبشن",
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

// Job/vacancy inquiries (including a doctor asking about working at the clinic) are not
// patient leads - the bot should stay completely silent on these, not reply at all.
const JOB_KEYWORDS = [
  "وظيفة",
  "وظايف",
  "وظائف",
  "فرصة عمل",
  "فرص عمل",
  "فرصة شغل",
  "اشتغل عندكم",
  "اشتغل معاكم",
  "أشتغل عندكم",
  "أشتغل معاكم",
  "شغل عندكم",
  "متقدم لوظيفة",
  "التقديم على وظيفة",
  "تقديم على وظيفة",
  "سيرة ذاتية",
  "السيرة الذاتية",
  "cv",
  "توظيف",
  "تعيين",
  "محتاجين دكتور",
  "محتاجين طبيب",
  "hiring",
  "job opening",
  "job vacancy",
  "job opportunity",
  "looking for a job",
  "apply for a job",
  "send my cv",
  "send my resume",
];

function wantsJob(text = "") {
  const lower = text.toLowerCase();
  return JOB_KEYWORDS.some((kw) => lower.includes(kw.toLowerCase()));
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

// WhatsApp template parameter values can't contain newlines/tabs or long runs of spaces -
// collapse all whitespace to single spaces and cap the length as a safety margin.
function sanitizeForTemplate(value = "") {
  return String(value).replace(/\s+/g, " ").trim().slice(0, 1000);
}

// Builds a compact, single-line handoff summary from whatever we already know about this
// conversation, so clinic staff can pick it up with context instead of starting from zero.
function buildHandoffSummary(convo, text) {
  const lead = convo.leadData || {};
  const parts = [];
  if (lead.name) parts.push(`الاسم: ${lead.name}`);
  if (lead.packageInterest) parts.push(`مهتم بـ: ${lead.packageInterest}`);
  if (lead.appointmentDate) parts.push(`تاريخ مطلوب: ${lead.appointmentDate}`);
  if (lead.appointmentTime) parts.push(`الوقت: ${lead.appointmentTime}`);
  if (lead.otherTopics) parts.push(`مواضيع تانية: ${lead.otherTopics}`);
  parts.push(`آخر رسالة من العميل: ${text || ""}`);
  return sanitizeForTemplate(parts.join(" | "));
}

// Proactively pings the clinic's own WhatsApp number using an approved message template (so it
// works instantly regardless of the normal 24-hour customer-service-window rule). Never throws -
// a failed staff notification should never break the customer-facing escalation reply.
async function notifyClinicStaff(customerContact, summary) {
  if (!CLINIC_STAFF_WHATSAPP_NUMBER) return;
  try {
    await sendWhatsAppTemplate(CLINIC_STAFF_WHATSAPP_NUMBER, "escalation_alert", "ar", [
      sanitizeForTemplate(customerContact || "غير معروف"),
      summary,
    ]);
    console.log("Notified clinic staff WhatsApp about an escalation.");
  } catch (err) {
    console.error("Failed to notify clinic staff WhatsApp:", err.message);
  }
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
// Builds a sheet-update object from whatever fields extractBookingDetails() found, omitting any
// key it didn't return - logLeadSafely() merges this on top of whatever's already saved for the
// lead, so a key we omit here simply leaves that field as it already was instead of blanking it.
function leadUpdateFromDetails(details, extra = {}, { includePhone = true } = {}) {
  const update = { ...extra };
  if (details.name) update.name = details.name;
  if (includePhone && details.phone) update.phone = details.phone;
  if (details.service) update.packageInterest = details.service;
  if (details.date) update.appointmentDate = details.date;
  if (details.time) update.appointmentTime = details.time;
  if (details.otherTopics) update.otherTopics = details.otherTopics;
  if (details.complete) update.status = "تم الحجز";
  // Strip any undefined-valued key (e.g. a conditional notes: someCond ? "..." : undefined at
  // the call site) so it's never spread into logLeadSafely's merge and blank out a real value
  // that was already saved for this lead.
  for (const k of Object.keys(update)) {
    if (update[k] === undefined) delete update[k];
  }
  return update;
}

async function logLeadSafely(convo, lead) {
  // Attach the latest full transcript, built fresh from convo.history (already kept in memory
  // for the AI's own context) - no extra API call, no extra cost, just re-serializing text we
  // already have. WhatsApp only - Messenger/Instagram rows leave this column untouched.
  const transcript =
    convo.platform === "whatsapp" && convo.history && convo.history.length
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

  // Job/vacancy inquiries (including a doctor asking about work) are not patient leads -
  // go completely silent on this conversation instead of replying like a normal customer.
  if (wantsJob(text)) {
    escalate(platform, senderId);
    await logLeadSafely(convo, {
      source: platform === "instagram" ? "انستجرام" : "ماسنجر",
      status: "استفسار وظيفة",
      notes: `استفسار عن وظيفة/شغل - متجاهل: ${text || ""}`,
    });
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
    const contact = (convo.leadData && convo.leadData.phone) || `${platform === "instagram" ? "انستجرام" : "ماسنجر"} (${senderId})`;
    await notifyClinicStaff(contact, buildHandoffSummary(convo, text));
    return;
  }

  // Same language-lock as WhatsApp: detect once from the first message and stick to it, so a
  // short/ambiguous later reply (e.g. just a number) doesn't cause the AI to drift back to Arabic.
  if (text && !convo.lang) {
    convo.lang = isArabicText(text) ? "ar" : "en";
  }

  pushHistory(platform, senderId, "user", text);
  const reply = await getAiReply(text, convo.history.slice(0, -1), convo.lang);
  pushHistory(platform, senderId, "assistant", reply);
  await sendMetaText(platform, senderId, reply);

  // Check the WHOLE conversation so far, not just this one message, for booking details - run
  // this on EVERY turn (not gated behind a "looks like it has a phone number" heuristic), because
  // unlike WhatsApp there's no phone number attached to a Messenger/Instagram conversation
  // automatically. A customer who only gives their name in one message still needs that name
  // saved right away, not held back until every other field happens to show up together.
  if (!isFirstContact && (!convo.leadData || convo.leadData.status !== "تم الحجز")) {
    const transcript = convo.history.map((h) => `${h.role === "user" ? "Customer" : "Clinic"}: ${h.content}`).join("\n");
    const details = await extractBookingDetails(transcript);
    const metaSource = platform === "instagram" ? "انستجرام" : "ماسنجر";
    if (details) {
      await logLeadSafely(
        convo,
        leadUpdateFromDetails(details, {
          source: metaSource,
          notes: details.complete
            ? "تفاصيل حجز تم استخراجها تلقائيًا من المحادثة."
            : `آخر رسالة: ${text}`,
        })
      );
    } else {
      await logLeadSafely(convo, { source: metaSource, notes: `آخر رسالة: ${text}` });
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
  const { from, type, text, listId, name, phoneNumberId } = event;
  const convo = getConversation("whatsapp", from);
  const source = whatsappSourceLabel(phoneNumberId);

  // Remembered so the inactivity follow-up job (below) can reply from the SAME WhatsApp number
  // that this conversation has been happening on, if the clinic has two numbers configured.
  if (phoneNumberId) convo.phoneNumberId = phoneNumberId;

  if (convo.escalated) return; // human has taken over

  // Job/vacancy inquiries (including a doctor asking about work) are not patient leads -
  // go completely silent on this conversation instead of replying like a normal customer.
  if (type === "text" && wantsJob(text)) {
    escalate("whatsapp", from);
    await logLeadSafely(convo, {
      phone: from,
      source,
      status: "استفسار وظيفة",
      notes: `استفسار عن وظيفة/شغل - متجاهل: ${text || ""}`,
    });
    return;
  }

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
    await logLeadSafely(convo, { phone: from, source, status: "عميل جديد", notes: `أول رسالة: ${text || ""}` });
  }

  // 1) Explicit human handoff, any time.
  if (type === "text" && wantsHuman(text)) {
    escalate("whatsapp", from);
    await sendWhatsAppText(from, replies.MENU_HUMAN, phoneNumberId);
    await logLeadSafely(convo, { phone: from, source, status: "عميل جديد", notes: "طلب التحدث مع موظف بشري" });
    await notifyClinicStaff(from, buildHandoffSummary(convo, text));
    return;
  }

  // 1.5) Customer replying with just a package number after we showed the numbered offers.
  if (type === "text" && convo.awaitingPackageChoice) {
    convo.awaitingPackageChoice = false;
    const packageName = PACKAGE_BY_NUMBER[text.trim()];
    if (packageName) {
      convo.step = "awaiting_booking_details";
      await logLeadSafely(convo, { phone: from, source, packageInterest: packageName, status: "مهتم بباقة" });
      await sendWhatsAppText(from, replies.BOOKING_START, phoneNumberId);
      return;
    }
    // Not a bare number reply - fall through to normal handling below.
  }

  // 2) List selection.
  if (type === "list_reply") {
    if (listId === "MENU_BOOK") {
      convo.step = "awaiting_booking_details";
      await sendWhatsAppText(from, replies.BOOKING_START, phoneNumberId);
      return;
    }
    const canned = replies[listId];
    if (canned) {
      await sendWhatsAppText(from, canned, phoneNumberId);
      if (listId === "MENU_OFFER") {
        convo.awaitingPackageChoice = true;
      }
      await logLeadSafely(convo, {
        phone: from,
        source,
        status: "عميل جديد",
        notes: `اختار من القايمة: ${text}`,
      });
    } else {
      // Unknown/unexpected list id - don't go silent, let them know how to continue.
      await sendWhatsAppText(from, replies.UNRECOGNIZED_SELECTION, phoneNumberId);
    }
    return;
  }

  // 3) Free text while we're waiting for booking details.
  if (convo.step === "awaiting_booking_details") {
    convo.step = null;
    await sendWhatsAppText(from, replies.BOOKING_RECEIVED, phoneNumberId);

    const transcript = `Customer phone number: ${from}\nCustomer message: ${text}`;
    const details = await extractBookingDetails(transcript);
    if (details) {
      const altPhone =
        details.phone && normalizePhone(details.phone) !== normalizePhone(from) ? details.phone : "";
      // Do NOT mark as "تم الحجز" (booked) unless all 5 fields are complete - that would stop us
      // from ever re-checking the conversation later, even after the customer goes on to finish
      // the booking naturally in later messages.
      await logLeadSafely(
        convo,
        leadUpdateFromDetails(
          details,
          {
            phone: from, // always keep the real WhatsApp contact number in this column
            altPhone,
            source,
            status: details.complete ? "تم الحجز" : "في انتظار تفاصيل الحجز",
            notes: details.complete
              ? "تفاصيل حجز تم استخراجها تلقائيًا من المحادثة."
              : `آخر رسالة أثناء الحجز: ${text}`,
          },
          { includePhone: false }
        )
      );
    } else {
      await logLeadSafely(convo, {
        phone: from,
        source,
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
    await sendWhatsAppText(from, reply, phoneNumberId);
    await sendWhatsAppList(from, menu, phoneNumberId);
    return;
  }

  // 5) Anything else -> fall back to the AI for a free-form, on-brand reply.
  pushHistory("whatsapp", from, "user", text);
  const reply = await getAiReply(text, convo.history.slice(0, -1), convo.lang);
  pushHistory("whatsapp", from, "assistant", reply);
  await sendWhatsAppText(from, reply, phoneNumberId);
  console.log(`WhatsApp reply sent to ${from}.`);

  // The AI often collects booking details (name, service, date, time) naturally across several
  // plain-chat messages, without the customer ever tapping the booking menu button. Check the
  // WHOLE conversation so far after every reply so this still gets captured - including a
  // customer who only gives their name and nothing else yet, which the old digit-heuristic gate
  // used to miss entirely (it only ran extraction when a 10+ digit run was present).
  if (!convo.leadData || convo.leadData.status !== "تم الحجز") {
    const transcript = convo.history.map((h) => `${h.role === "user" ? "Customer" : "Clinic"}: ${h.content}`).join("\n");
    const details = await extractBookingDetails(transcript);
    if (details) {
      const altPhone =
        details.phone && normalizePhone(details.phone) !== normalizePhone(from) ? details.phone : "";
      await logLeadSafely(
        convo,
        leadUpdateFromDetails(
          details,
          {
            phone: from, // always keep the real WhatsApp contact number in this column
            altPhone,
            source,
            notes: details.complete ? "تفاصيل حجز تم استخراجها تلقائيًا من المحادثة." : undefined,
          },
          { includePhone: false }
        )
      );
    }
  }
}

// ---------------------------------------------------------------------------
// INACTIVITY FOLLOW-UP JOB
// Runs on all three channels (WhatsApp / Messenger / Instagram). For every conversation that
// hasn't booked yet and where WE are the ones waiting on a reply (our message was the last one):
//   - after 1 hour of silence: write a note on that customer's existing sheet row so the clinic
//     can see it went quiet (the full transcript is already kept up to date on that same row).
//   - after 4 hours of silence: send the customer ONE re-engagement message and note it on the
//     sheet. Never sends more than once per conversation.
// This applies even to conversations that only ever had a first message - that row was already
// created on first contact, so it's included and updated in place, not skipped or duplicated.
// ---------------------------------------------------------------------------

const HOUR_MS = 60 * 60 * 1000;
const QUIET_ALERT_THRESHOLD_MS = 1 * HOUR_MS;
const FOLLOW_UP_THRESHOLD_MS = 4 * HOUR_MS;
const FOLLOW_UP_CHECK_INTERVAL_MS = 5 * 60 * 1000; // scan every 5 minutes

const FOLLOW_UP_MESSAGE = {
  ar: "أهلاً بيك تاني 🙏 لسه عروض يوم الافتتاح في Denova متاحة، حابب أساعدك تكمل حجزك؟ لو محتاج أي تفاصيل تانية، أنا موجود.",
  en: "Hi again! 🙏 Denova's opening-day offers are still available - would you like help finishing your booking? Happy to answer any questions.",
};

async function checkInactiveConversations() {
  const now = Date.now();
  for (const { platform, senderId, convo } of getAllConversations()) {
    if (convo.escalated) continue; // a human already took over - leave it alone
    if (convo.leadData && convo.leadData.status === "تم الحجز") continue; // already booked
    if (!convo.history || convo.history.length === 0) continue; // nothing happened yet

    const lastEntry = convo.history[convo.history.length - 1];
    if (!lastEntry || lastEntry.role !== "assistant") continue; // we're waiting on OUR reply, not theirs

    const idleMs = now - convo.lastActivity;

    if (!convo.hourAlertSent && idleMs >= QUIET_ALERT_THRESHOLD_MS) {
      convo.hourAlertSent = true;
      await logLeadSafely(convo, { notes: "⚠️ العميل ما ردش من ساعة - محتاج متابعة" });
    }

    if (!convo.followUpSent && idleMs >= FOLLOW_UP_THRESHOLD_MS) {
      convo.followUpSent = true;
      const lang = convo.lang === "en" ? "en" : "ar";
      const message = FOLLOW_UP_MESSAGE[lang];
      try {
        if (platform === "whatsapp") {
          await sendWhatsAppText(senderId, message, convo.phoneNumberId);
        } else {
          await sendMetaText(platform, senderId, message);
        }
        pushHistory(platform, senderId, "assistant", message);
        await logLeadSafely(convo, { notes: "📞 اتبعتله رسالة متابعة تلقائية بعد عدم الرد" });
      } catch (err) {
        console.error(`Failed to send follow-up to ${platform}:${senderId}:`, err.message);
      }
    }
  }
}

setInterval(() => {
  checkInactiveConversations().catch((err) => console.error("checkInactiveConversations failed:", err));
}, FOLLOW_UP_CHECK_INTERVAL_MS);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Denova bot listening on port ${PORT}`));

module.exports = app;
