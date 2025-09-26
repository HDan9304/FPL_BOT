export const ascii = (s) =>
  String(s)
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\u00A0/g, " ");

export const esc = (s) => String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
export const B = (label) => `<b>${esc(label)}:</b>`;

export const parseCmd = (t) => {
  if (!t || !t.startsWith("/")) return { name: "", args: [] };
  const parts = t.trim().split(/\s+/);
  return { name: parts[0].slice(1).toLowerCase(), args: parts.slice(1) };
};

// Deep link for /start (tap to run). Requires BOT_USERNAME env (e.g., "my_bot").
export function startLink(env) {
  const u = (env?.BOT_USERNAME || "").trim();
  if (!u) return null;
  // Both forms work; https link is nicer inside Telegram.
  const href = `https://t.me/${encodeURIComponent(u)}?start`;
  return `<a href="${esc(href)}">/start</a>`;
}
