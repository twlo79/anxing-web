/**
 * 佈告欄 → 電話簿（2026-09-30，migration_303）的純邏輯：誰能寫、怎麼排、怎麼找、電話怎麼撥。
 *
 * 【誰能寫只有一份定義】資料庫 `board_contact_write_roles()` ＝ 這裡的 `CONTACT_WRITE_ROLES`。
 *   前端只拿它決定要不要畫「＋ 新增」與「›」；真的擋是 RLS。兩邊不一樣的話症狀是
 *   「按了說沒有權限」（前端多開）或「明明可以卻沒按鈕」（前端少開）。
 */

export type Contact = {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  note: string | null;
  created_by: string | null;
  created_at: string;
  updated_by: string | null;
  updated_at: string;
};

export type ContactDraft = { id?: string; name: string; phone: string; email: string; note: string };
export const BLANK_CONTACT: ContactDraft = { name: '', phone: '', email: '', note: '' };

export const CONTACT_WRITE_ROLES = ['accountant', 'manager', 'super_admin'] as const;
export const canWriteContacts = (role: string | null | undefined): boolean =>
  (CONTACT_WRITE_ROLES as readonly string[]).includes(role ?? '');

/** 照姓名／公司名排（中文筆畫、英文字母混排交給 localeCompare） */
export function sortContacts<T extends { name: string }>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'));
}

/** 電話只留數字（比對用）：「02-2345-6789 #12」→「0223456789 12」的數字部分都算 */
const digits = (s: string) => s.replace(/\D+/g, '');

/** 關鍵字同時找四個欄位；電話另外用純數字比（打 23456789 找得到 02-2345-6789） */
export function matchContact(c: Contact, q: string): boolean {
  const k = q.trim().toLowerCase();
  if (!k) return true;
  const hay = [c.name, c.phone ?? '', c.email ?? '', c.note ?? ''].join('\n').toLowerCase();
  if (hay.includes(k)) return true;
  const kd = digits(k);
  return kd.length >= 3 && digits(c.phone ?? '').includes(kd);
}

/**
 * 「02-2345-6789 #12」→ `tel:0223456789;ext=12`。
 * 沒有數字就回 null（那格是「LINE 找她」之類的字，不要畫成可撥）。
 */
export function telHref(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const m = phone.match(/^(.*?)(?:\s*(?:#|ext\.?|分機|轉)\s*(\d+))?\s*$/i);
  const main = digits(m?.[1] ?? phone);
  if (main.length < 5) return null;
  const ext = m?.[2];
  return `tel:${phone.trim().startsWith('+') ? '+' : ''}${main}${ext ? `;ext=${ext}` : ''}`;
}

export function mailHref(email: string | null | undefined): string | null {
  const e = (email ?? '').trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? `mailto:${e}` : null;
}

/** 存檔前的檢查。回 null ＝ 可以存 */
export function contactProblem(d: ContactDraft): string | null {
  if (!d.name.trim()) return '「姓名／公司名」要填';
  const e = d.email.trim();
  if (e && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return 'email 看起來不對（要像 name@company.com）';
  if (!d.phone.trim() && !e && !d.note.trim()) return '電話、email、備註至少填一個 —— 不然這筆什麼都查不到';
  return null;
}

/** 表單 → 要送進資料庫的欄位（空字串一律存 null，欄位定義就是可空） */
export function contactBody(d: ContactDraft): Pick<Contact, 'name' | 'phone' | 'email' | 'note'> {
  return {
    name: d.name.trim(),
    phone: d.phone.trim() || null,
    email: d.email.trim().toLowerCase() || null,
    note: d.note.trim() || null,
  };
}
