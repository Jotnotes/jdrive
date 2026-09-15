'use strict';

// Outbound email.
//
// JotNotes JDrive does not run a mail service for anybody. The hosting company
// supplies an SMTP server — theirs, or one they already pay for — and this sends
// through it. That is the same rule as everything else here: they own the
// commercial relationship with their customer, and a product that quietly sent
// mail from our infrastructure would put our reputation and our deliverability
// underneath their customer's password reset.
//
// Two things ride on this and both of them lock somebody out when they fail:
// confirming an address, and getting back in after a forgotten password. So a
// send that does not happen is recorded rather than swallowed, and a box with no
// mail server configured says so at boot and answers for it on an operator-only
// route. Not on /health: somebody probing does not get to learn that.
//
// With no SMTP configured the message is written to a file instead. That is for
// a machine being installed and for the audit, which follows a real verification
// link out of a real message: a test that reaches into the database for the
// token proves the database, not the product.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function createMailer({ spoolDir, env = process.env, log = console } = {}) {
  const host = (env.SMTP_HOST || '').trim();
  // A default that names this product would put it in the From line of every
  // message a hosting company's customer receives, which is the one surface a
  // white-label deployment cannot afford to leak on. Neutral and true instead:
  // this is the files service, on this machine, until an operator sets MAIL_FROM.
  const from = (env.MAIL_FROM || '').trim() || 'files@localhost';
  const mode = host ? 'smtp' : 'spool';
  let transport = null;

  if (mode === 'spool') {
    fs.mkdirSync(spoolDir, { recursive: true, mode: 0o700 });
  }

  function smtpTransport() {
    if (transport) return transport;
    // Required lazily so a box that sends through SMTP loads the library and a
    // box being installed does not.
    const nodemailer = require('nodemailer');
    const port = parseInt(env.SMTP_PORT || '587', 10);
    transport = nodemailer.createTransport({
      host,
      port,
      // 465 is implicit TLS. Everything else starts in the clear and upgrades,
      // and `requireTLS` means it refuses to carry on if the upgrade is not
      // offered rather than sending a password reset across the wire in plain.
      secure: env.SMTP_SECURE ? env.SMTP_SECURE !== 'false' : port === 465,
      requireTLS: port !== 465,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS || '' } : undefined,
    });
    return transport;
  }

  // The sender may be given per message, because the hosting company's name
  // belongs in the From line and their brand is a thing that changes without the
  // box restarting. The address stays the operator's; only the display name in
  // front of it is theirs, and it arrives already stripped of anything that could
  // end a header.
  async function send({ to, subject, text, from: sender }) {
    const envelope = sender || from;
    if (mode === 'smtp') {
      try {
        const info = await smtpTransport().sendMail({ from: envelope, to, subject, text });
        return { ok: true, mode, id: info.messageId || '' };
      } catch (error) {
        // The provider's error can carry the credentials it just tried. Nothing
        // past here is allowed to see them, so what comes back is the shape of
        // the failure and not the failure itself.
        return { ok: false, mode, error: scrub(String(error && error.message || error), env) };
      }
    }
    const name = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(4).toString('hex')}.eml`;
    const file = path.join(spoolDir, name);
    fs.writeFileSync(file, `To: ${to}\nFrom: ${envelope}\nSubject: ${subject}\n\n${text}\n`, { mode: 0o600 });
    return { ok: true, mode, id: name, file };
  }

  return {
    mode,
    from,
    spoolDir: mode === 'spool' ? spoolDir : null,
    send,
    // What an operator needs to know at boot, and what /health repeats so that
    // finding out is not something anybody has to remember to do.
    warnIfUnconfigured() {
      if (mode === 'smtp') {
        log.log(`[jdrive] mail through ${host} as ${from}`);
        return;
      }
      log.warn('[jdrive] no SMTP_HOST is set, so no mail leaves this box.');
      log.warn(`[jdrive] confirmation and password-reset messages are being written to ${spoolDir}.`);
      log.warn('[jdrive] set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS and MAIL_FROM before selling anything.');
    },
  };
}

// Anything that looks like the credential we were given, gone. Matching on the
// configured value rather than on a pattern, because the pattern for "password"
// is every string.
function scrub(text, env) {
  let out = String(text);
  for (const secret of [env.SMTP_PASS, env.SMTP_USER]) {
    if (secret && secret.length > 3) out = out.split(secret).join('[redacted]');
  }
  return out.slice(0, 300);
}

module.exports = { createMailer };
