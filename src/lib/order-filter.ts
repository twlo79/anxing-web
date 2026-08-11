/**
 * 訂單頁的「費用類別」篩選。
 *
 * 【為什麼房租不是用 fee_type 判斷】
 * 直覺是「fee_type 空的就是房租」。但那是在猜 —— 一次性收入要是哪天
 * 存進來時 fee_type 沒填，它就會被算成房租，而報表上不會有任何跡象。
 *
 * 真正的規則寫在資料庫的 order_account_code()：
 * **來源是 oneoff 或 airbnb_cancelled 的，才看 fee_type 分科目；
 * 其餘一律計入租金收入。** 這裡照抄同一條規則，
 * 篩出來的結果就會跟營收報表對得上。
 *
 * 兩邊不一致的話，症狀是「訂單頁篩房租有 120 筆，報表的租金收入卻是 118 筆」——
 * 而沒有人查得出那 2 筆差在哪。
 */

/** 這兩種來源的收入按 fee_type 分科目，其餘都是租金收入 */
export const ONEOFF_SOURCES = ['oneoff', 'airbnb_cancelled'];

export type FeePredicate =
  | { kind: 'none' }
  | { kind: 'rent' }
  | { kind: 'oneoffAll' }
  | { kind: 'feeType'; feeType: string };

export const FEE_F_ALL = '';
export const FEE_F_RENT = '__rent__';
export const FEE_F_ONEOFF = '__oneoff__';

/**
 * 下拉選項。
 *
 * 「房租」與「一次性費用（全部）」放在最前面 —— 那是最常問的兩個問題
 * （這段期間收了多少房租、額外收了多少雜費）。個別科目排在後面。
 */
export function feeFilterOptions(feeTypes: readonly string[]): { value: string; label: string }[] {
  return [
    { value: FEE_F_ALL, label: '全部' },
    { value: FEE_F_RENT, label: '房租' },
    { value: FEE_F_ONEOFF, label: '一次性費用(全部)' },
    ...feeTypes.map((t) => ({ value: t, label: `　${t}` })),
  ];
}

/** 選單的值 → 要怎麼篩。畫面、合計、匯出三處都用這一份。 */
export function feeFilterPredicate(v: string): FeePredicate {
  if (!v) return { kind: 'none' };
  if (v === FEE_F_RENT) return { kind: 'rent' };
  if (v === FEE_F_ONEOFF) return { kind: 'oneoffAll' };
  return { kind: 'feeType', feeType: v };
}

/** 篩選中的說明文字。空字串代表沒篩，畫面上就不顯示。 */
export function feeFilterLabel(v: string): string {
  const p = feeFilterPredicate(v);
  switch (p.kind) {
    case 'none': return '';
    case 'rent': return '房租';
    case 'oneoffAll': return '一次性費用';
    case 'feeType': return p.feeType;
  }
}
