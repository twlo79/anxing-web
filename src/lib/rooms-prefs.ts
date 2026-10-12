/**
 * 房源狀態頁的篩選記憶（2026-10-12 David：「要有 local storage 不要把記憶洗掉」）。
 *
 * 存在這台裝置的 localStorage —— 換手機、換電腦不會跟過去（那是設計，不是漏掉）。
 *
 * ★★ 讀回來的東西**一律驗過再用**：舊版本存的、手動改壞的、別頁同名 key 的，
 *   都可能長得不對。驗不過的那一欄用預設值，其餘照用 —— 不要因為一欄壞掉整包丟掉。
 * ★ 網址上的 `?ewin=` `?owin=` 優先於記憶（丟給會計的連結要看到同一份）—— 呼叫端處理。
 */

export const ROOMS_PREFS_KEY = 'rooms.prefs.v1';

export type RoomsPrefs = {
  estF: string;
  mode: 'month' | 'custom';
  ym: string;
  from: string;
  to: string;
  kw: string;
  view: string;
  showDup: boolean;
  showEnd: boolean;
  showOut: boolean;
  ewin: number | null;
  owin: number | null;
};

const YM = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** 讀回來的字串 → 一包可以用的設定；整包壞掉或沒有就回 null（＝用預設） */
export function parseRoomsPrefs(raw: string | null | undefined, views: readonly string[]): Partial<RoomsPrefs> | null {
  if (!raw) return null;
  let o: any;
  try { o = JSON.parse(raw); } catch { return null; }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const out: Partial<RoomsPrefs> = {};
  if (typeof o.estF === 'string') out.estF = o.estF;
  if (o.mode === 'month' || o.mode === 'custom') out.mode = o.mode;
  if (typeof o.ym === 'string' && YM.test(o.ym)) out.ym = o.ym;
  if (typeof o.from === 'string' && DATE.test(o.from)) out.from = o.from;
  if (typeof o.to === 'string' && DATE.test(o.to)) out.to = o.to;
  if (typeof o.kw === 'string') out.kw = o.kw.slice(0, 100);
  if (typeof o.view === 'string' && (o.view === '' || views.includes(o.view))) out.view = o.view;
  for (const k of ['showDup', 'showEnd', 'showOut'] as const) if (typeof o[k] === 'boolean') out[k] = o[k];
  for (const k of ['ewin', 'owin'] as const) if (typeof o[k] === 'number' && Number.isFinite(o[k])) out[k] = o[k];
  return out;
}

export function serializeRoomsPrefs(p: RoomsPrefs): string {
  return JSON.stringify(p);
}

/** `2026-10` 往前／後 n 個月 */
export function shiftYm(ym: string, n: number): string {
  const [y, m] = ym.split('-').map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
}
