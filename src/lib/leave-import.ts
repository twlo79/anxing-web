/**
 * 上線前紀錄匯入（管理 → 假別額度 → ①-b，2026-09-29）：
 * Excel 一列一筆「姓名・日期・種類・小時・備註」→ 對到人與假別 → 交給 RPC `import_leave_history`。
 *
 * 【這裡只做「對得到誰、哪一列不合法」】不碰資料庫。重複（同一人同一天已有單）由 RPC 判 skip ——
 *   它看得到真實資料，前端看不到別人的假單。
 *
 * 【種類用名字對，不用代碼】人事填的是「年假」「病假」，不是 annual。對法：
 *   去空白、去全形／半形括號 → 完全相等，或等於括號外的那段、或等於括號裡的那段
 *   （「年假（特休）」可以寫成 年假／特休／年假（特休）三種）。「加班」固定對到 overtime。
 *
 * 【日期三種樣子都收】Excel 存日期格式的格子讀出來是 Date 或序號（數字），存文字的是字串。
 *   序號 → 以 1899-12-30 為第 0 天（Excel 的 1900 閏年 bug 已經含在這個基準裡）。
 */

export const TEMPLATE_HEADERS = ['姓名', '日期', '種類', '小時', '備註'] as const;

export type ImportKind = { code: string; name: string };
export const OVERTIME_KIND: ImportKind = { code: 'overtime', name: '加班' };

export type ImportRow = {
  user_id: string; d: string; kind: string; hours: number; note: string | null;
};
export type ParsedRow =
  | { i: number; ok: true; row: ImportRow; who: string; kindName: string }
  | { i: number; ok: false; error: string; who: string; kindName: string; d: string; hours: string };

/** 姓名去空白、統一大小寫 —— 「cindy 」跟「Cindy」是同一個人 */
const normName = (s: unknown) => String(s ?? '').replace(/\s+/g, '').toLowerCase();

/** 種類：去空白、把括號拆成「外」「內」兩段 */
function kindKeys(name: unknown): string[] {
  const s = String(name ?? '').replace(/\s+/g, '');
  const m = s.match(/^(.*?)[（(](.*?)[）)]$/);
  return m ? [s, m[1], m[2]].filter(Boolean) : [s];
}

/** Excel 序號／Date／字串 → YYYY-MM-DD；認不出來回 null */
export function toYmd(v: unknown): string | null {
  if (v == null || v === '') return null;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  }
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v < 20000 || v > 80000) return null;   // 1954～2119 之外當成不是日期
    const ms = Math.round(v) * 86400000 + Date.UTC(1899, 11, 30);
    const d = new Date(ms);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  }
  const s = String(v).trim();
  const m = s.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), da = Number(m[3]);
  if (mo < 1 || mo > 12 || da < 1 || da > 31) return null;
  const chk = new Date(Date.UTC(y, mo - 1, da));
  if (chk.getUTCMonth() !== mo - 1) return null;   // 2/30 這種
  return `${y}-${String(mo).padStart(2, '0')}-${String(da).padStart(2, '0')}`;
}

/**
 * 一份表 → 逐列結果。每一列都回（ok 或 error），畫面才能一列對一列地標。
 * `rows` 是 sheet_to_json 吐出來的物件（鍵 ＝ 表頭）。
 */
export function parseImportRows(
  rows: readonly Record<string, unknown>[],
  people: readonly { id: string; name: string }[],
  kinds: readonly ImportKind[],
): ParsedRow[] {
  const byName = new Map<string, { id: string; name: string }[]>();
  for (const p of people) {
    const k = normName(p.name);
    if (!k) continue;
    byName.set(k, [...(byName.get(k) ?? []), p]);
  }
  const allKinds = [...kinds, OVERTIME_KIND];
  const seen = new Set<string>();
  const out: ParsedRow[] = [];
  rows.forEach((r, idx) => {
    const i = idx + 2;   // Excel 的列號（第 1 列是表頭）
    const nameRaw = String(r['姓名'] ?? '').trim();
    const kindRaw = String(r['種類'] ?? '').trim();
    const hoursRaw = String(r['小時'] ?? '').trim();
    const dRaw = r['日期'];
    const note = String(r['備註'] ?? '').trim() || null;
    const d = toYmd(dRaw) ?? '';
    const fail = (error: string): ParsedRow =>
      ({ i, ok: false, error, who: nameRaw, kindName: kindRaw, d: d || String(dRaw ?? ''), hours: hoursRaw });

    // 整列空白（Excel 常常多幾列）→ 跳過不算錯
    if (!nameRaw && !kindRaw && !hoursRaw && (dRaw == null || dRaw === '')) return;

    if (!nameRaw) { out.push(fail('沒填姓名')); return; }
    const cands = byName.get(normName(nameRaw)) ?? [];
    if (cands.length === 0) { out.push(fail('系統裡沒有這個人')); return; }
    if (cands.length > 1) { out.push(fail('有兩個同名的人，對不出來')); return; }
    const who = cands[0];

    if (!d) { out.push(fail('日期看不懂（要像 2026-03-12）')); return; }

    const keys = kindKeys(kindRaw);
    const kind = keys.length && kindRaw
      ? allKinds.find((k) => kindKeys(k.name).some((kk) => keys.includes(kk)))
      : undefined;
    if (!kind) {
      out.push(fail(`種類要是 ${allKinds.map((k) => k.name).join('／')}`));
      return;
    }

    const hours = Number(hoursRaw);
    if (!hoursRaw || !Number.isFinite(hours) || hours <= 0 || hours > 24) {
      out.push(fail('小時要是 0～24 的數字')); return;
    }
    if (Math.round(hours * 2) !== hours * 2) { out.push(fail('小時要是 0.5 的倍數')); return; }

    const dup = `${who.id}|${d}|${kind.code}`;
    if (seen.has(dup)) { out.push(fail('檔案裡同一人同一天同一種填了兩次')); return; }
    seen.add(dup);

    out.push({
      i, ok: true, who: who.name, kindName: kind.name,
      row: { user_id: who.id, d, kind: kind.code, hours, note },
    });
  });
  return out;
}

/** 範本的示範列（下載範本時放兩列，讓人看格式；匯入時要刪掉 —— 姓名對不到會被標紅，不會誤進） */
export const TEMPLATE_EXAMPLE_ROWS: Record<(typeof TEMPLATE_HEADERS)[number], string>[] = [
  { 姓名: '（填系統上的姓名）', 日期: '2026-03-12', 種類: '年假', 小時: '8', 備註: '整天' },
  { 姓名: '（填系統上的姓名）', 日期: '2026-06-20', 種類: '加班', 小時: '4', 備註: '' },
];
