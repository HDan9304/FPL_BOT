export async function getBootstrap() {
  try {
    const r = await fetch("https://fantasy.premierleague.com/api/bootstrap-static/", {
      signal: AbortSignal.timeout(10000),
      cf: { cacheTtl: 60 }
    });
    if (!r.ok) return null;
    return await r.json().catch(() => null);
  } catch { return null; }
}

export function getCurrentGw(bootstrap) {
  const ev = bootstrap?.events || [];
  const cur = ev.find(e => e.is_current);
  if (cur) return cur.id;
  const nxt = ev.find(e => e.is_next);
  if (nxt) return nxt.id;
  const up = ev.find(e => !e.finished);
  return up ? up.id : (ev[ev.length-1]?.id || 1);
}

export async function getEntry(id) {
  try {
    const r = await fetch(`https://fantasy.premierleague.com/api/entry/${id}/`, {
      signal: AbortSignal.timeout(10000),
      cf: { cacheTtl: 0 }
    });
    if (!r.ok) return null;
    const j = await r.json().catch(() => null);
    return (j && typeof j.id === "number") ? j : null;
  } catch { return null; }
}

export async function getPicks(id, gw) {
  try {
    const r = await fetch(`https://fantasy.premierleague.com/api/entry/${id}/event/${gw}/picks/`, {
      signal: AbortSignal.timeout(10000),
      cf: { cacheTtl: 0 }
    });
    if (!r.ok) return null;
    return await r.json().catch(() => null);
  } catch { return null; }
}

export function teamShort(bootstrap, teamId) {
  const t = (bootstrap?.teams || []).find(x => x.id === teamId);
  return t?.short_name || "?";
}
export function posName(et) { return ({1:"GK",2:"DEF",3:"MID",4:"FWD"})[et] || "?"; }

// Prefer "F. Lastname" when possible; else FPL web_name.
export function nameShort(el) {
  const first = (el?.first_name || "").trim();
  const last  = (el?.second_name || "").trim();
  const web   = (el?.web_name || "").trim();
  if (first && last) return `${first[0]}. ${last}`;
  return web || "—";
}
