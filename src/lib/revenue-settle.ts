/**
 * 營收匯出的「結算」工作表（純函式）。
 *
 * ============================================================
 * 【這是什麼】（2026-09-02 使用者指定，附了一張紙本報表的照片）
 *
 * 一列一個分類、一欄一個物業，每個月一個區塊往下疊:
 *
 *     分類                 正隆        時兆      合計
 *     ── 115年8月 ──
 *     長租              7,325,440    63,222   7,388,662
 *     短租                445,714   669,246   1,114,960
 *     其他收入・管理費・—    16,935     4,567      21,502
 *     …（系統裡全部 13 個科目都列，沒金額的寫 0）
 *     小計              7,803,072   743,659   8,546,731
 *
 * ============================================================
 * 【★★★ 沒有金額的科目也要列】（使用者選的）
 *
 * 「只列有金額的」會讓每個月的列數不一樣 —— 而這份表是拿來
 * **上下比對月份**的。八月 9 列、九月 7 列的話，
 * 同一個位置的兩個數字根本不是同一個科目。
 *
 * ★ 這跟 `revenues/page.tsx` 匯出總表的第 2 條原則同一件事:
 *   「零就寫 0，不讓列消失」。欄的方向也一樣（見 `settleGrid`）。
 *
 * ============================================================
 * 【★★ 短租是三個平台合起來】（使用者選的）
 *
 *   短租 ＝ airbnb ＋ agoda ＋ private
 *
 * ★ 畫面上的「依來源」卡片是分開列的，這裡合併 —— 兩邊問的問題不同:
 *   卡片問「哪個通路帶進多少」，結算問「這個物業這個月收多少」。
 *
 * ============================================================
 * 【2026-09-02 拿掉的東西】
 *
 * 一度做過 A 案（`settleLines`:每個物業一塊往下疊，一欄一個月）。
 * 使用者看到實際的 Excel 之後改選 B —— A 案的 8 個物業要 140 列，
 * 而且物業之間的同一科目隔了 17 列，根本比不了。
 * A 案的程式碼與 15 條測試一起刪掉，**沒有留著當備案** ——
 * 沒人用的分支會在下次改需求時被誤以為還在跑。
 */

import { FEE_TYPES } from './fee-types.ts';

/** 結算需要的欄位。跟 `revenues/page.tsx` 的 Row 相容（多的欄位不管）。 */
export type SettleRow = {
  source: string;
  estate_name: string | null;
  fee_type?: string | null;
  month_amount: number | null;
};

/** 短租＝這三個平台（2026-09-02 使用者選的）。 */
export const SHORT_SOURCES = ['airbnb', 'agoda', 'private'] as const;

/** ★ 金額一律走這裡:null／undefined／空字串都當 0，不會變 NaN。 */
const num = (n: unknown) => Number(n) || 0;

/**
 * 結算表：**一列一個分類、一欄一個物業**，每個月一個區塊往下疊。
 *
 * ============================================================
 * 【★★★ 欄位給物業，不給月份】（2026-09-02 使用者選 B）
 *
 * 八個物業直式堆疊要 140 列，而且物業之間的同一科目隔了 17 列，
 * 根本比不了。橫著擺只有 17 列，一頁看完，而且
 * 「哪一棟的管理費最多」一眼就看得出來。
 *
 * ★ 多個月份就**往下疊區塊**，欄位維持同一批物業 ——
 *   所以橫著比物業、直著比月份，兩個方向都成立。
 *
 * ============================================================
 * 【★★★ 欄位取所有月份的聯集】
 *
 * 八月有開封、七月沒有的話，七月那個區塊**還是要有開封那一欄**（寫 0）。
 * 不然兩個區塊的欄位會錯開，同一欄上下兩個數字就不是同一棟 ——
 * 跟「沒金額也要列 0」是同一條規則，只是換成欄的方向。
 *
 * ============================================================
 * 【★★ 辦公室租金與公司登記各自一欄】
 *
 * 它們不掛物業，但**總計必須含它們**，不然跟畫面上的
 * 「當期營收總額」對不起來。所以當成兩個虛擬物業各給一欄，
 * 金額放在「長租」那一列 —— 它們本來就是租金。
 *
 * ★ 沒有資料的月份不會長出這兩欄。
 */
export type SettleGridRow = {
  kind: 'item' | 'subtotal';
  label: string;
  /** 對應 `estates` 的順序 */
  amounts: number[];
  /** 這一列橫向加總 */
  total: number;
};

export type SettleGridBlock = {
  /** 區塊標題，例如「115年8月」 */
  label: string;
  rows: SettleGridRow[];
};

export type SettleGrid = {
  /** 欄位（所有月份的聯集）。辦公室租金／公司登記排最後 */
  estates: string[];
  blocks: SettleGridBlock[];
};

/** 這兩個不掛物業，當成虛擬物業各給一欄。 */
const PSEUDO: Record<string, string> = { office: '辦公室租金', company: '公司登記' };

/** 一列資料算在哪一欄。 */
const colOf = (r: SettleRow) => PSEUDO[r.source] ?? r.estate_name ?? '無物業';

/**
 * 一列資料算在哪一列。回 null = 不屬於任何分類列（只進小計）。
 *
 * ★ 辦公室租金與公司登記歸「長租」—— 它們就是租金，
 *   而它們自己那一欄的欄名已經講清楚是什麼了。
 */
function rowOf(r: SettleRow): string | null {
  if (r.source === 'longterm' || PSEUDO[r.source]) return '長租';
  if ((SHORT_SOURCES as readonly string[]).includes(r.source)) return '短租';
  if (r.source === 'oneoff') {
    const ft = r.fee_type ?? '其他';
    return (FEE_TYPES as readonly string[]).includes(ft)
      ? `其他收入・${ft}・—`
      : '其他收入・（科目不在清單裡）・—';
  }
  return null;
}

/** 固定的列骨架。★ 順序寫死 —— 照金額排的話每個月會換位置。 */
const ROW_LABELS = ['長租', '短租', ...FEE_TYPES.map((f) => `其他收入・${f}・—`)];

export function settleGrid(
  months: { label: string; rows: SettleRow[] }[],
  order: (estate: string) => number = () => 99,
): SettleGrid {
  const ms = months ?? [];

  /*
   * 欄位 = 所有月份的聯集。真的物業照 sort 排，
   * 辦公室租金與公司登記固定排最後（它們不是物業）。
   */
  const real = new Set<string>();
  const pseudo = new Set<string>();
  for (const m of ms) {
    for (const r of m.rows ?? []) {
      const c = colOf(r);
      (PSEUDO[r.source] ? pseudo : real).add(c);
    }
  }
  const estates = [
    ...[...real].sort((a, b) => (order(a) - order(b)) || a.localeCompare(b)),
    ...['辦公室租金', '公司登記'].filter((p) => pseudo.has(p)),
  ];

  /*
   * ★★ 認不得的科目那一列**只有真的出現時才加** ——
   *   永遠掛一列 0 在那裡只會讓人以為系統有問題。
   */
  const hasStray = ms.some((m) => (m.rows ?? []).some((r) => rowOf(r) === '其他收入・（科目不在清單裡）・—'));
  const labels = hasStray ? [...ROW_LABELS, '其他收入・（科目不在清單裡）・—'] : ROW_LABELS;

  const blocks = ms.map((m) => {
    const cell = new Map<string, number>();   // `${row}|${col}`
    const colSum = new Map<string, number>();
    for (const r of m.rows ?? []) {
      const c = colOf(r);
      const amt = num(r.month_amount);
      colSum.set(c, (colSum.get(c) ?? 0) + amt);
      const rw = rowOf(r);
      if (!rw) continue;                       // 認不得的來源:只進小計
      cell.set(`${rw}|${c}`, (cell.get(`${rw}|${c}`) ?? 0) + amt);
    }

    const rows: SettleGridRow[] = labels.map((label) => {
      const amounts = estates.map((e) => cell.get(`${label}|${e}`) ?? 0);
      return { kind: 'item', label, amounts, total: amounts.reduce((a, b) => a + b, 0) };
    });

    /*
     * ★★★ 小計用**每一欄的總和**算，不是把上面那幾列加起來。
     *   加起來的話，任何一種沒被 `rowOf` 認到的來源都會安靜消失 ——
     *   而小計看起來完全正常。
     */
    const subs = estates.map((e) => colSum.get(e) ?? 0);
    rows.push({ kind: 'subtotal', label: '小計', amounts: subs,
                total: subs.reduce((a, b) => a + b, 0) });
    return { label: m.label, rows };
  });

  return { estates, blocks };
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
