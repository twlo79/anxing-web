/**
 * 付款排程（請款單頁）：這個月還要準備多少錢、是哪幾張單。
 *
 * 2026-10-05 David：「我要看哪些，小計要準備多少」。
 * ★ 以前只算「已核可」—— 待核可的單（這個月 13 張、五百多萬）完全不在表上，
 *   於是「共 NT$ 3,381」看起來像這個月只要準備三千塊。現在兩種都列，**分開加總**：
 *   已核可＝確定要出；待核可＝可能被駁回，所以「共」是最多可能要付的。
 */
export type SchedReq = {
  id: string; status: string; planned_transfer_on: string | null;
  payout_account: string | null; total_amount: number | null;
};

export type SchedGroup<T extends SchedReq> = {
  date: string; acct: string; approved: boolean; reqs: T[]; amt: number;
};
export type SchedDay<T extends SchedReq> = {
  date: string; groups: SchedGroup<T>[]; approvedAmt: number; pendingAmt: number;
};

const amtOf = (r: SchedReq) => Number(r.total_amount) || 0;

/** 日期 → 帳號 → 已核可／待核可，一層一層分好；每天帶小計 */
export function paySchedule<T extends SchedReq>(rows: readonly T[]): {
  days: SchedDay<T>[]; approvedAmt: number; pendingAmt: number;
} {
  const g = new Map<string, SchedGroup<T>>();
  for (const r of rows) {
    if (r.status !== 'approved' && r.status !== 'pending') continue;
    const date = r.planned_transfer_on ?? '';
    const acct = r.payout_account || '—';
    const approved = r.status === 'approved';
    const k = `${date}|${acct}|${approved ? 1 : 0}`;
    const cur = g.get(k) ?? { date, acct, approved, reqs: [], amt: 0 };
    cur.reqs.push(r); cur.amt += amtOf(r);
    g.set(k, cur);
  }
  const byDay = new Map<string, SchedDay<T>>();
  for (const x of g.values()) {
    const d = byDay.get(x.date) ?? { date: x.date, groups: [], approvedAmt: 0, pendingAmt: 0 };
    d.groups.push(x);
    if (x.approved) d.approvedAmt += x.amt; else d.pendingAmt += x.amt;
    byDay.set(x.date, d);
  }
  const days = [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
  for (const d of days) {
    d.groups.sort((a, b) => a.acct.localeCompare(b.acct) || Number(b.approved) - Number(a.approved));
  }
  return {
    days,
    approvedAmt: days.reduce((s, d) => s + d.approvedAmt, 0),
    pendingAmt: days.reduce((s, d) => s + d.pendingAmt, 0),
  };
}
