/** 出勤頁各分頁共用的型別與小工具。 */

export type Role = 'housekeeper' | 'accountant' | 'manager' | 'super_admin';

/** 訊息回報。err = true 的不會自動消失（使用者可能低頭看手機）。 */
export type Msg = (text: string, err?: boolean) => void;

export type TabProps = {
  me: { id: string; name: string; role: Role };
  isAdmin: boolean;
  onMsg: Msg;
};

export type Estate = {
  id: string; name: string; active: boolean; sort: number;
  gps_lat: number | null; gps_lng: number | null; gps_radius_m: number;
};

export type LeaveType = { code: string; name: string; has_quota: boolean; sort: number };

export type Balance = {
  id: string; user_id: string; year: number; type_code: string;
  quota_hours: number; used_hours: number;
};

export type LeaveReq = {
  id: string; user_id: string; type_code: string;
  start_at: string; end_at: string; hours: number; reason: string | null;
  status: string; manager_at: string | null; admin_at: string | null;
  reject_reason: string | null; created_at: string;
};

export type OtReq = {
  id: string; user_id: string; work_date: string;
  start_at: string; end_at: string; hours: number; reason: string;
  status: string; manager_at: string | null; reject_reason: string | null; created_at: string;
};

export type FixReq = {
  id: string; user_id: string; work_date: string; kind: 'in' | 'out';
  fix_time: string; reason: string; status: string;
  review_note: string | null; created_at: string;
};

export type Holiday = { d: string; name: string; kind: 'holiday' | 'makeup' };

export type Announcement = {
  id: string; title: string; body: string; pinned: boolean; active: boolean;
  created_by: string | null; created_at: string;
};

/** 共用的小樣式 —— 每個分頁都在用，寫死在各檔案會慢慢長歪。 */
// 極淡的陰影。白卡放在米色底上原本只靠一條框線分界,
// 加一層 4% 的影子之後卡片才會「浮」起來 —— 再重就變成 2010 年的擬物風。
export const CARD = 'rounded-xl border border-mor-line bg-white shadow-[0_1px_2px_rgba(46,56,64,0.05)]';

/** 側邊欄那三個顏色，內容區沿用同一組 —— 綠進、橘出、藍中性 */
export const C_IN = '#3FAE7C';
export const C_OUT = '#E08A4C';
export const C_NEUTRAL = '#41689B';
export const INPUT = 'rounded-lg border border-mor-line px-3 py-2 text-sm w-full';
export const BTN = 'rounded-lg px-4 py-2 text-sm font-medium bg-mor-slate text-white '
  + 'hover:bg-mor-slatedark disabled:opacity-40';
export const BTN2 = 'rounded-lg px-3 py-1.5 text-xs border border-mor-line '
  + 'hover:bg-mor-sand/60 disabled:opacity-40';

export const TONE: Record<string, string> = {
  wait: 'bg-amber-50 text-amber-700 border-amber-200',
  ok: 'bg-mor-greenlight text-mor-green border-mor-green/30',
  no: 'bg-gray-100 text-gray-500 border-gray-200',
};

/** 2026-08-10T09:00:00+08:00 → 8/10 09:00 */
export function fmtDT(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getMonth() + 1}/${d.getDate()} `
    + `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * RLS 擋掉的寫入不會回錯誤，只會影響 0 列。
 * 每個 update/insert 都要走這裡 —— 少一處就會出現「畫面說成功、其實沒存」。
 */
export function noRowsMsg(what: string): string {
  return `${what}沒有存進去 —— 你的帳號沒有這個權限。\n如果你認為應該有，請總經理確認角色設定。`;
}
