// lib/sheets.js
// Logs every lead (WhatsApp / Messenger / Instagram) as a new row in a Google Sheet,
// using a service account. Implemented with Node's built-in "crypto" + global fetch
// only (no googleapis dependency) so the project stays tiny and fast to deploy.
//
// Sheet columns must match, in this order (row 1 = header, matching Denova_Booking_Tracker.xlsx):
// التاريخ | اسم المريض | رقم الواتساب | المصدر | الباقة / الخدمة المهتم بها | الحالة |
// تاريخ الموعد | وقت الموعد | تاريخ المتابعة القادمة | تم تسليم هدية الافتتاح؟ | ملاحظات

const crypto = require("crypto");

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_TAB = process.env.GOOGLE_SHEET_TAB || "سجل الحجوزات";
const SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

let cachedToken = null; // { accessToken, expiresAt }

function base64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function getServiceAccount() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not set");
  return JSON.parse(raw);
}

async function getAccessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.accessToken;
  }

  const { client_email, private_key } = getServiceAccount();
  const nowSec = Math.floor(Date.now() / 1000);

  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({
      iss: client_email,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: nowSec,
      exp: nowSec + 3600,
    })
  );
  const unsigned = `${header}.${claims}`;
  const signature = crypto.createSign("RSA-SHA256").update(unsigned).sign(private_key, "base64");
  const jwt = `${unsigned}.${signature.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  if (!res.ok) {
    throw new Error(`Google token error ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  cachedToken = { accessToken: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return cachedToken.accessToken;
}

/**
 * @param {object} lead
 * @param {string} [lead.name]
 * @param {string} [lead.phone]
 * @param {string} lead.source - e.g. "واتساب" / "ماسنجر" / "انستجرام" / "تعليق ميتا"
 * @param {string} [lead.packageInterest]
 * @param {string} [lead.status] - defaults to "عميل جديد"
 * @param {string} [lead.notes]
 */
async function appendLead(lead) {
  if (!SHEET_ID) throw new Error("GOOGLE_SHEET_ID is not set");

  const accessToken = await getAccessToken();
  const today = new Date().toISOString().slice(0, 10);

  const row = [
    today,
    lead.name || "",
    lead.phone || "",
    lead.source || "",
    lead.packageInterest || "",
    lead.status || "عميل جديد",
    "", // appointment date - filled in manually once booked
    "", // appointment time
    "", // next follow-up date
    "لا", // opening gift given
    lead.notes || "",
  ];

  const range = encodeURIComponent(`'${SHEET_TAB}'!A:K`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ values: [row] }),
  });

  if (!res.ok) {
    throw new Error(`Sheets append error ${res.status}: ${await res.text()}`);
  }
}

module.exports = { appendLead };
