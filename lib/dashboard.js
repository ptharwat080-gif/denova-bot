// lib/dashboard.js
// A minimal, no-dependency live-chat dashboard for the clinic's bot WhatsApp number. The bot's
// number was never connected to the regular WhatsApp Business app (see README), and Meta's own
// tools (WhatsApp Manager, Business Suite Inbox) don't show its conversations either - so this
// gives the clinic a simple in-browser way to see who's messaging the bot and reply manually
// when needed, without touching the live Meta/WhatsApp account setup at all.
//
// Replying from here sends the message through the SAME WhatsApp Cloud API the bot uses, and
// marks that conversation as escalated - so the bot stops auto-replying to that customer from
// then on, exactly like the existing "طلب التحدث مع موظف" handoff path in server.js.
//
// Protected by a single shared password (HTTP Basic Auth) - no user accounts, by design, since
// this is a small clinic's internal tool for a couple of staff members, not a multi-user product.
// Set DASHBOARD_PASSWORD in your environment to override the default below.

const express = require("express");
const { getConversation, getAllConversations, pushHistory, escalate } = require("./state");
const { sendWhatsAppText } = require("./whatsapp");

const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || "Amadeus@123";

function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme === "Basic" && encoded) {
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    const separatorIndex = decoded.indexOf(":");
    const password = separatorIndex >= 0 ? decoded.slice(separatorIndex + 1) : "";
    if (password === DASHBOARD_PASSWORD) return next();
  }
  res.set("WWW-Authenticate", 'Basic realm="Denova Dashboard"');
  return res.status(401).send("Authentication required.");
}

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function timeAgoLabel(ms) {
  const diffMin = Math.round((Date.now() - ms) / 60000);
  if (diffMin < 1) return "دلوقتي";
  if (diffMin < 60) return `من ${diffMin} دقيقة`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `من ${diffHr} ساعة`;
  return `من ${Math.round(diffHr / 24)} يوم`;
}

const PAGE_STYLE = `
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "Segoe UI", Tahoma, Arial, sans-serif; background:#e5ddd5; margin:0; direction:rtl; }
  header { background:#075e54; color:#fff; padding:14px 18px; font-size:18px; position:sticky; top:0; display:flex; align-items:center; justify-content:space-between; z-index:10; }
  header a { color:#fff; text-decoration:none; font-size:14px; }
  .list { max-width:720px; margin:0 auto; background:#fff; min-height:calc(100vh - 50px); }
  .row { display:flex; justify-content:space-between; align-items:center; padding:14px 18px; border-bottom:1px solid #eee; text-decoration:none; color:#111; }
  .row:hover { background:#f5f5f5; }
  .row .name { font-weight:600; }
  .row .snippet { color:#667781; font-size:13px; margin-top:2px; max-width:440px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .row .meta { text-align:left; font-size:12px; color:#667781; white-space:nowrap; padding-right:12px; }
  .badge { display:inline-block; background:#25d366; color:#fff; border-radius:10px; padding:1px 8px; font-size:11px; margin-bottom:4px; }
  .badge.human { background:#999; }
  .chat-wrap { max-width:720px; margin:0 auto; background:#e5ddd5; min-height:calc(100vh - 50px); display:flex; flex-direction:column; }
  .messages { flex:1; padding:14px 0; }
  .bubble-row { display:flex; padding:3px 14px; }
  .bubble-row.customer { justify-content:flex-end; }
  .bubble-row.business { justify-content:flex-start; }
  .bubble { max-width:72%; padding:8px 12px; border-radius:8px; font-size:14px; line-height:1.45; white-space:pre-wrap; word-wrap:break-word; box-shadow:0 1px 1px rgba(0,0,0,.08); }
  .bubble.customer { background:#fff; }
  .bubble.business { background:#d9fdd3; }
  form.reply { display:flex; gap:8px; padding:12px; background:#f0f0f0; position:sticky; bottom:0; }
  form.reply textarea { flex:1; border-radius:8px; border:1px solid #ccc; padding:10px; font-size:14px; resize:none; font-family:inherit; }
  form.reply button { background:#25d366; color:#fff; border:none; border-radius:8px; padding:0 20px; font-size:14px; cursor:pointer; }
  .empty { padding:40px 20px; text-align:center; color:#667781; }
  .notice { padding:10px 18px; background:#fff8e1; color:#7a5c00; font-size:13px; text-align:center; }
`;

function layout(title, bodyHtml) {
  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>${PAGE_STYLE}</style>
</head>
<body>${bodyHtml}</body>
</html>`;
}

function renderList() {
  const conversations = getAllConversations()
    .filter((c) => c.platform === "whatsapp" && c.convo.history && c.convo.history.length > 0)
    .sort((a, b) => b.convo.lastActivity - a.convo.lastActivity);

  const rows = conversations
    .map(({ senderId, convo }) => {
      const lead = convo.leadData || {};
      const name = lead.name || senderId;
      const lastEntry = convo.history[convo.history.length - 1];
      const snippet = lastEntry ? lastEntry.content : "";
      const badge = convo.escalated
        ? `<span class="badge human">متابعة يدوية</span>`
        : `<span class="badge">البوت شغال</span>`;
      return `
        <a class="row" href="/dashboard/chat/${encodeURIComponent(senderId)}">
          <div>
            <div>${badge}</div>
            <div class="name">${escapeHtml(name)}</div>
            <div class="snippet">${escapeHtml(snippet)}</div>
          </div>
          <div class="meta">${timeAgoLabel(convo.lastActivity)}</div>
        </a>`;
    })
    .join("");

  const body = `
    <header><span>محادثات واتساب البوت</span></header>
    <div class="list">
      ${rows || `<div class="empty">لسه مفيش محادثات مسجلة.</div>`}
    </div>`;
  return layout("محادثات واتساب - Denova", body);
}

function renderChat(phone) {
  const convo = getConversation("whatsapp", phone);
  const lead = convo.leadData || {};
  const name = lead.name || phone;

  const bubbles = (convo.history || [])
    .map((h) => {
      const side = h.role === "user" ? "customer" : "business";
      return `<div class="bubble-row ${side}"><div class="bubble ${side}">${escapeHtml(h.content)}</div></div>`;
    })
    .join("");

  const notice = convo.escalated
    ? `<div class="notice">المحادثة دي متابعة يدويًا حاليًا - البوت مش بيرد عليها.</div>`
    : "";

  const body = `
    <header>
      <a href="/dashboard">&#8592; رجوع</a>
      <span>${escapeHtml(name)} - ${escapeHtml(phone)}</span>
    </header>
    ${notice}
    <div class="chat-wrap">
      <div class="messages">${bubbles || `<div class="empty">مفيش رسايل لسه.</div>`}</div>
      <form class="reply" method="POST" action="/dashboard/chat/${encodeURIComponent(phone)}/reply">
        <textarea name="message" rows="1" placeholder="اكتب ردك هنا..." required></textarea>
        <button type="submit">إرسال</button>
      </form>
    </div>`;
  return layout(`شات ${name} - Denova`, body);
}

function mountDashboard(app) {
  app.get("/dashboard", requireAuth, (_req, res) => {
    res.send(renderList());
  });

  app.get("/dashboard/chat/:phone", requireAuth, (req, res) => {
    res.send(renderChat(req.params.phone));
  });

  app.post("/dashboard/chat/:phone/reply", requireAuth, express.urlencoded({ extended: false }), async (req, res) => {
    const phone = req.params.phone;
    const message = (req.body.message || "").trim();
    if (message) {
      try {
        const convo = getConversation("whatsapp", phone);
        await sendWhatsAppText(phone, message, convo.phoneNumberId);
        pushHistory("whatsapp", phone, "assistant", message);
        escalate("whatsapp", phone); // human took over - bot stays silent on this chat from now on
      } catch (err) {
        console.error("Dashboard reply failed:", err.message);
      }
    }
    res.redirect(`/dashboard/chat/${encodeURIComponent(phone)}`);
  });
}

module.exports = { mountDashboard };
