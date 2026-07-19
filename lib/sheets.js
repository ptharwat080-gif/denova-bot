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
 * @param {string} [lead.appointmentDate]
 * @param {string} [lead.appointmentTime]
 * @param {string} [lead.notes]
 */
// Data rows start at row 5 (rows 1-4 are the title, subtitle, spacer, and header).
const FIRST_DATA_ROW = 5;

function buildRowValues(lead, dateStr) {
  return [
    dateStr,
    lead.name || "",
    lead.phone || "",
    lead.source || "",
    lead.packageInterest || "",
    lead.status || "عميل جديد",
    lead.appointmentDate || "", // appointment date - filled automatically if the bot captured it, else manually
    lead.appointmentTime || "", // appointment time
    "", // next follow-up date
    "لا", // opening gift given
    lead.notes || "",
  ];
}

async function writeRow(rowNumber, values, accessToken) {
  const writeRange = encodeURIComponent(`'${SHEET_TAB}'!A${rowNumber}:K${rowNumber}`);
  const writeUrl = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${writeRange}?valueInputOption=USER_ENTERED`;

  const res = await fetch(writeUrl, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ values: [values] }),
  });

  if (!res.ok) {
    throw new Error(`Sheets write error ${res.status}: ${await res.text()}`);
  }
}

/**
 * Appends a brand-new row for a lead and returns the row number it was written to, so the
 * caller can remember it and use updateLeadRow() for any later updates to the same lead
 * instead of creating a fresh row for every touchpoint.
 */
async function appendLead(lead) {
  if (!SHEET_ID) throw new Error("GOOGLE_SHEET_ID is not set");

  const accessToken = await getAccessToken();
  const today = new Date().toISOString().slice(0, 10);

  // Figure out the next truly-empty row ourselves by checking column A directly, instead of
  // relying on the Sheets API's "append after last table" auto-detection. That auto-detection
  // gets thrown off by leftover formatting/data-validation on far-below empty rows (a common
  // artifact of converting an .xlsx template to Google Sheets), causing new rows to land far
  // past the real data instead of right after it. Reading column A fresh on every write also
  // means manual edits/deletions in the sheet never desync the bot - it always finds the real
  // next empty row at write time.
  const colRange = encodeURIComponent(`'${SHEET_TAB}'!A${FIRST_DATA_ROW}:A`);
  const getUrl = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${colRange}`;
  const getRes = await fetch(getUrl, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!getRes.ok) {
    throw new Error(`Sheets read error ${getRes.status}: ${await getRes.text()}`);
  }
  const getData = await getRes.json();
  const columnValues = getData.values || [];

  let targetRow = FIRST_DATA_ROW;
  for (let i = 0; i < columnValues.length; i++) {
    const cellValue = columnValues[i] && columnValues[i][0] ? String(columnValues[i][0]).trim() : "";
    if (cellValue === "") {
      targetRow = FIRST_DATA_ROW + i;
      break;
    }
    targetRow = FIRST_DATA_ROW + i + 1;
  }

  await writeRow(targetRow, buildRowValues(lead, today), accessToken);
  return targetRow;
}

/**
 * Overwrites an already-known row (returned earlier by appendLead) with updated lead info.
 * Used so one ongoing conversation keeps updating the SAME sheet row instead of piling up a
 * new row for every message/menu tap.
 */
async function updateLeadRow(rowNumber, lead) {
  if (!SHEET_ID) throw new Error("GOOGLE_SHEET_ID is not set");
  const accessToken = await getAccessToken();
  const today = new Date().toISOString().slice(0, 10);
  await writeRow(rowNumber, buildRowValues(lead, today), accessToken);
}

module.exports = { appendLead, updateLeadRow };
