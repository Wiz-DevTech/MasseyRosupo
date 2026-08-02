// Local SMTP mailer (postfix on 127.0.0.1:25). Everything is gated:
// MAIL_ENABLED=true|1 turns it on; empty recipient lists skip sends.
const nodemailer = require("nodemailer");

const ENABLED = ["true", "1", "yes", "on"].includes(String(process.env.MAIL_ENABLED || "").toLowerCase());
const FROM = process.env.MAIL_FROM || "Massey & Rosupo Co. <no-reply@masseyrosupo.com>";
const TRUSTEES = (process.env.MAIL_TO_TRUSTEES || "").split(",").map(s => s.trim()).filter(Boolean);

let _tx = null;
function transport() {
  if (!_tx) {
    _tx = nodemailer.createTransport({
      host: "127.0.0.1",
      port: 25,
      secure: false,
      ignoreTLS: true,          // postfix local submission, no STARTTLS
      tls: { rejectUnauthorized: false },
    });
  }
  return _tx;
}

// send(to, subject, text) -> {ok, skipped?, messageId?, error?}
async function send(to, subject, text) {
  if (!ENABLED) return { skipped: true, reason: "mail disabled (MAIL_ENABLED not set)" };
  if (!to) return { skipped: true, reason: "no recipient" };
  try {
    const info = await transport().sendMail({ from: FROM, to, subject, text });
    console.log("[mail] sent to", to, "subject:", subject, "id:", info.messageId);
    return { ok: true, messageId: info.messageId };
  } catch (e) {
    console.error("[mail] send failed:", e.message);
    return { ok: false, error: e.message };
  }
}

module.exports = { send, ENABLED, TRUSTEES, FROM };
