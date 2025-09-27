// lib/squad.js — turn picks into rows with EV/sell/etc.
export function shortName(el){
  const first = (el?.first_name || "").trim();
  const last  = (el?.second_name || "").trim();
  const web   = (el?.web_name || "").trim();
  if (first && last) {
    const initLast = `${first[0]}. ${last}`;
    return (web && web.length <= initLast.length) ? web : initLast;
  }
  return web || last || first || "—";
}
export function teamShort(teams, id){ return teams?.[id]?.short_name || "?"; }

export function annotateSquad(picks, elements, teams, evById){
  const rows = [];
  for (const p of picks || []) {
    const el = elements[p.element]; if (!el) continue;
    const pos = (p.position || 16);
    rows.push({
      id: el.id,
      name: shortName(el),
      teamId: el.team,
      team: teamShort(teams, el.team),
      posT: el.element_type,
      isStarter: pos <= 11,
      sell: (p?.selling_price ?? p?.purchase_price ?? el?.now_cost ?? 0) / 10,
      listPrice: (el?.now_cost ?? 0)/10,
      ev: evById[el.id]?.ev || 0
    });
  }
  return rows;
}
