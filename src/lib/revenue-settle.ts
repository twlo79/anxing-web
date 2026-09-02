/**
 * 營收匯出的【結算】區塊（純函式）。
 *
 * ============================================================
 * 【這是什麼】（2026-09-02 使用者指定，附了一張紙本報表的照片）
 *
 * 每個月工作表的**最上面**先給一份結算，底下才接既有的逐筆明細:
 *
 *     【結算】
 *     時兆
 *             長租                    63,222
 *             短租                   669,246
 *             其他收入・管理費・—        4,567
 *             其他收入・修繕費・—            0
 *             …（系統裡全部 13 個科目都列）
 *     小計                           743,659
 *
 * ============================================================
 * 【★★★ 沒有金額的科目也要列】（使用者選的）
 *
 * 「只列有金額的」會讓每個月的列數不一樣 —— 而這份表是拿來
 * **橫向比對月份**的。八月有 9 列、九月有 7 列的話，
 * 同一個位置的兩個數字根本不是同一個科目。
 *
 * ★ 這跟 `revenues/page.tsx` 匯出總表的第 2 條原則同一件事:
 *   「零就寫 0，不讓列消失」。
 *
 * ============================================================
 * 【★★ 短租是三個平台合起來】（使用者選的）
 *
 *   短租 ＝ airbnb ＋ agoda ＋ private
 *
 * ★ 畫面上的「依來源」卡片是分開列的，這裡合併 —— 兩邊問的問題不同:
 *   卡片問「哪個通路帶進多少」，結算問「這個物業這個月收多少」。
 */

import { FEE_TYPES } from './fee-types.ts';

/** 結算需要的欄位。跟 `revenues/page.tsx` 的 Row 相容（多的欄位不管）。 */
export type SettleRow = {
  source: string;
  estate_name: string | null;
  fee_type?: string | null;
  month_amount: number | null;
};

export type SettleLine = {
  /** 縮排層級:0 = 物業名 / 1 = 分類 / 小計自己一列 */
  kind: 'estate' | 'item' | 'subtotal' | 'total';
  label: string;
  amount: number;
};

/** 短租＝這三個平台（2026-09-02 使用者選的）。 */
export const SHORT_SOURCES = ['airbnb', 'agoda', 'private'] as const;

const num = (n: unknown) => Number(n) || 0;

/**
 * 一個物業的結算列。
 *
 * ★ 順序固定:長租 → 短租 → 其他收入（照 FEE_TYPES 的順序）。
 *   照金額排序的話，每個月的列會換位置，橫向比對就失效了。
 */
function estateLines(rows: SettleRow[], estate: string): SettleLine[] {
  const out: SettleLine[] = [];
  const sum = (f: (r: SettleRow) => boolean) =>
    rows.reduce((a, r) => a + (f(r) ? num(r.month_amount) : 0), 0);

  out.push({ kind: 'estate', label: estate, amount: 0 });
  out.push({ kind: 'item', label: '長租', amount: sum((r) => r.source === 'longterm') });
  out.push({
    kind: 'item', label: '短租',
    amount: sum((r) => (SHORT_SOURCES as readonly string[]).includes(r.source)),
  });

  /*
   * ★★★ 其他收入照 `FEE_TYPES` 全部列出來，**沒有金額的寫 0**。
   *
   *   科目清單直接用 lib/fee-types 那一份 —— 這裡再抄一份的話，
   *   哪天多一個科目（像今天才加的「稅費」）這張表就會漏掉它，
   *   而那筆錢會消失在結算裡卻還在明細裡（CLAUDE.md 的坑）。
   *
   * ★ 項目一律寫「—」:同一個科目底下的細項合併計算。
   *   使用者給的樣張上每一列都是「・—」。
   */
  for (const ft of FEE_TYPES) {
    out.push({
      kind: 'item',
      label: `其他收入・${ft}・—`,
      amount: sum((r) => r.source === 'oneoff' && (r.fee_type ?? '其他') === ft),
    });
  }

  /*
   * ★★ 認不得的科目要有地方去。`fee_type` 是自由文字，
   *   舊資料可能有 FEE_TYPES 裡沒有的值 —— 不接住的話那筆錢
   *   會從結算裡消失，而小計就跟明細對不起來。
   */
  const known = new Set<string>(FEE_TYPES as readonly string[]);
  const stray = sum((r) => r.source === 'oneoff' && !known.has(r.fee_type ?? '其他'));
  if (stray !== 0) {
    out.push({ kind: 'item', label: '其他收入・（科目不在清單裡）・—', amount: stray });
  }

  /*
   * ★★★ 小計用**整個物業的總和**算，不是把上面那幾列加起來。
   *
   *   加起來的話，任何一種沒被上面列到的來源都會安靜地消失 ——
   *   而小計看起來完全正常。用總和算的話，對不起來就會浮出來。
   */
  out.push({ kind: 'subtotal', label: '小計', amount: sum(() => true) });
  return out;
}

/**
 * 整份【結算】。
 *
 * @param rows   這個月的全部認列列（已經照畫面的篩選過濾過）
 * @param order  物業的排序（`estates.sort`）。沒給就照名稱
 *
 * ★★ 辦公室租金與公司登記**不掛物業**，所以自成兩塊排在最後 ——
 *   少了它們，總計就跟畫面上的「當期營收總額」對不起來。
 */
export function settleLines(
  rows: SettleRow[],
  order: (estate: string) => number = () => 99,
): SettleLine[] {
  const list = rows ?? [];
  const out: SettleLine[] = [];

  // 掛得到物業的
  const inEstate = list.filter((r) => r.source !== 'office' && r.source !== 'company');
  const names = [...new Set(inEstate.map((r) => r.estate_name ?? '無物業'))]
    .sort((a, b) => (order(a) - order(b)) || a.localeCompare(b));

  for (const nm of names) {
    out.push(...estateLines(
      inEstate.filter((r) => (r.estate_name ?? '無物業') === nm), nm));
  }

  // 不掛物業的兩種
  for (const [src, label] of [['office', '辦公室租金'], ['company', '公司登記']] as const) {
    const sub = list.filter((r) => r.source === src);
    if (!sub.length) continue;
    out.push({ kind: 'estate', label, amount: 0 });
    out.push({ kind: 'item', label, amount: sub.reduce((a, r) => a + num(r.month_amount), 0) });
    out.push({ kind: 'subtotal', label: '小計', amount: sub.reduce((a, r) => a + num(r.month_amount), 0) });
  }

  out.push({
    kind: 'total', label: '總計',
    amount: list.reduce((a, r) => a + num(r.month_amount), 0),
  });
  return out;
}

/**
 * 民國年的日期範圍，給表頭用:「115年8月1日~115年8月31日」。
 *
 * ★ 使用者給的樣張是民國年。西元寫上去的話，拿去跟其他報表對的人
 *   得自己換算 —— 而換錯一年不會有人發現。
 */
export function rocRange(y: number, m: number): string {
  const roc = y - 1911;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${roc}年${m}月1日~${roc}年${m}月${last}日`;
}
