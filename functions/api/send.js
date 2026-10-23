// functions/api/send.js
// Sends one individual email per recipient (no shared To/CC visible between recipients).
//
// Env vars required in Cloudflare Pages:
//   ZEPTOMAIL_TOKEN  — ZeptoMail Send API key
//   ALLOWED_FROM     — comma-separated list of verified sender addresses
//   FROM_NAME        — default display name (used if form leaves it blank)
//   ENDPOINT_SECRET  — shared secret the frontend must send

const MAX_FILES = 5;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_RECIPIENTS = 500;

// Small delay between sends to be gentle on the API (ms). Set to 0 for max speed.
const DELAY_BETWEEN_SENDS_MS = 50;

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function toBase64(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function onRequestPost({ request, env }) {
  // 1. Auth
  const provided = request.headers.get('X-Endpoint-Secret') || '';
  if (!env.ENDPOINT_SECRET || provided !== env.ENDPOINT_SECRET) {
    return json(401, { error: 'Unauthorized' });
  }

  // 2. Parse multipart
  let form;
  try {
    form = await request.formData();
  } catch {
    return json(400, { error: 'Expected multipart/form-data' });
  }

  const from = (form.get('from') || '').toString().trim();
  const displayName = (form.get('displayName') || env.FROM_NAME || '').toString().trim();
  const replyTo = (form.get('replyTo') || '').toString().trim();
  const subject = (form.get('subject') || '').toString().trim();
  const message = (form.get('message') || '').toString();

  // 3. Recipients
  let toList = [];
  try {
    toList = JSON.parse(form.get('to') || '[]');
  } catch {
    return json(400, { error: '`to` must be a JSON array of emails' });
  }
  if (!Array.isArray(toList) || toList.length === 0) {
    return json(400, { error: '`to` is required' });
  }
  if (toList.length > MAX_RECIPIENTS) {
    return json(400, { error: `Maximum ${MAX_RECIPIENTS} recipients per send` });
  }
  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  for (const addr of toList) {
    if (typeof addr !== 'string' || !emailRe.test(addr)) {
      return json(400, { error: `Invalid recipient: ${addr}` });
    }
  }

  // 4. Required fields
  if (!from) return json(400, { error: '`from` is required' });
  if (!subject) return json(400, { error: '`subject` is required' });
  if (!message) return json(400, { error: '`message` is required' });

  // 5. Verify sender against allowlist
  const allowed = (env.ALLOWED_FROM || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
  if (!allowed.includes(from.toLowerCase())) {
    return json(403, {
      error: `Sender "${from}" is not in ALLOWED_FROM. Add it to your ZeptoMail verified senders and to the env var.`,
    });
  }

  // 6. Collect attachments once (reused for every recipient)
  const files = form.getAll('files').filter(f => typeof f !== 'string');
  if (files.length > MAX_FILES) {
    return json(400, { error: `Maximum ${MAX_FILES} attachments per email` });
  }

  const attachments = [];
  for (const file of files) {
    if (file.size > MAX_FILE_BYTES) {
      return json(400, { error: `"${file.name}" exceeds 5 MB` });
    }
    const buf = await file.arrayBuffer();
    attachments.push({
      name: file.name || 'attachment',
      mime_type: file.type || 'application/octet-stream',
      content: toBase64(buf),
    });
  }

  // 7. Token
  let token = env.ZEPTOMAIL_TOKEN || '';
  if (!token.startsWith('Zoho-enczapikey ')) token = `Zoho-enczapikey ${token}`;

  // 8. Send one individual email per recipient
  const results = [];
  let okCount = 0;
  let failCount = 0;

  for (let i = 0; i < toList.length; i++) {
    const addr = toList[i];

    const zeptoBody = {
      from: { address: from, name: displayName },
      to: [{ email_address: { address: addr } }],  // single recipient only
      subject,
      htmlbody: message,
    };
    if (replyTo) zeptoBody.reply_to = [{ address: replyTo }];
    if (attachments.length) zeptoBody.attachments = attachments;

    try {
      const res = await fetch('https://api.zeptomail.com/v1.1/email', {
        method: 'POST',
        headers: {
          'Authorization': token,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify(zeptoBody),
      });

      const text = await res.text();

      if (res.ok) {
        okCount++;
        results.push({ email: addr, status: res.status, ok: true });
      } else {
        failCount++;
        results.push({ email: addr, status: res.status, ok: false, response: text });
      }
    } catch (err) {
      failCount++;
      results.push({ email: addr, ok: false, error: err.message });
    }

    if (i < toList.length - 1 && DELAY_BETWEEN_SENDS_MS > 0) {
      await sleep(DELAY_BETWEEN_SENDS_MS);
    }
  }

  // 9. Summary response
  const summary = {
    total: toList.length,
    sent: okCount,
    failed: failCount,
    results,
  };

  // If everything failed, return an error status so the frontend shows red.
  // If partially or fully succeeded, return 200 with the breakdown.
  const statusCode = okCount === 0 ? 502 : 200;

  return new Response(JSON.stringify(summary, null, 2), {
    status: statusCode,
    headers: { 'Content-Type': 'application/json' },
  });
}