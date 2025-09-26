export async function send(env, chat_id, text, parse_mode = null) {
  const payload = { chat_id, text, disable_web_page_preview: true };
  if (parse_mode) payload.parse_mode = parse_mode;

  try {
    const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(payload)
    });
    // If parse_mode fails for any reason, retry plain text
    const j = await r.json().catch(() => null);
    if (!r.ok || j?.ok === false) {
      await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ chat_id, text })
      });
    }
  } catch {
    // Silent fail
  }
}
