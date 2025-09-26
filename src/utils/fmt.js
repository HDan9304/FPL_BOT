export const ascii = (s) =>
  String(s)
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\u00A0/g, " ");

// Basic HTML escapers for Telegram parse_mode:"HTML"
export const esc = (s) => String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
export const B = (label) => `<b>${esc(label)}:</b>`;

// Command parser (not strictly needed here but handy for future)
export const parseCmd = (t) => {
  if (!t || !t.startsWith("/")) return { name: "", args: [] };
  const parts = t.trim().split(/\s+/);
  return { name: parts[0].slice(1).toLowerCase(), args: parts.slice(1) };
};
