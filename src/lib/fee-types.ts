/**
 * 一次性收入的會計科目（`orders.fee_type`）。
 *
 * 【為什麼要有這支】
 * 這份清單原本各寫各的:契約頁的「加費」有八種,短租訂單的「加費」只有三種
 * （清潔費／修繕費／其他）,而「新增一次性收入」根本沒有這個欄位 ——
 * 只能寫在備註裡。同一件事三種寫法,營收報表按 fee_type 分組時就會看到
 * 一堆自由文字混在一起。
 *
 * 全站都從這裡取,要增減科目只改這一行。
 *
 * 【順序】
 * 常用的排前面,「其他」永遠最後 —— 它是保底,不是一個真的分類。
 *
 * 【取消相關的收入歸在「其他」】
 * Airbnb 取消收入、取消預訂這幾種(2026-08 時 73 筆、約 150 萬)刻意不另立科目,
 * 明細留在備註裡。這是業務上的決定,不是漏掉。
 *
 * 代價要知道:營收報表的「其他」會包含這筆錢,光看報表分不出組成,
 * 得回訂單看備註。之後若要在報表上分開,加一個科目再重新標記即可 ——
 * 資料都還在,不是不可逆的。
 */
export const FEE_TYPES = [
  '水費', '電費', '網路費', '瓦斯費', '管理費',
  '停車費', '設備費', '清潔費', '修繕費', '其他',
] as const;

export type FeeType = (typeof FEE_TYPES)[number];

/**
 * 契約固定加費的預設項目。
 *
 * 【為什麼「設備費-冰箱」要拆成兩欄】
 * 使用者說的是一句「設備費-冰箱」，但系統裡科目與項目是分開的兩欄:
 * 營收報表按**科目**分組，項目是底下的細目。
 *
 * 合成一個字串塞進 fee_type 的話，報表上會出現「設備費-冰箱」「設備費-電視」
 * 兩個各自獨立的科目，永遠回答不了「設備費一共收多少」。
 *
 * 拆開之後兩個問題都答得出來:設備費合計看科目，是冰箱還是電視看項目。
 * 畫面上仍然是一個下拉選五項，選完自動填好兩欄 —— 使用者感覺不到差別。
 */
export const CONTRACT_FEE_PRESETS: { label: string; fee_type: string; item_name: string | null }[] = [
  { label: '管理費',        fee_type: '管理費', item_name: null },
  { label: '停車費',        fee_type: '停車費', item_name: null },
  // 網路費本來就在 FEE_TYPES 裡（營收科目對到 internet，見 migration_91），
  // 只是沒放進固定加費的預設清單 —— 加在這裡就好，不用動資料庫。
  { label: '網路費',        fee_type: '網路費', item_name: null },
  { label: '水費',          fee_type: '水費',   item_name: null },
  // 垃圾代收歸在清潔費底下（使用者指定）—— 科目看清潔費，
  // 要單獨知道垃圾代收收了多少就看項目。另立科目要改資料庫的科目對應表，
  // 為一個小金額的細目不值得。
  { label: '垃圾代收',      fee_type: '清潔費', item_name: '垃圾代收' },
  { label: '設備費－冰箱',   fee_type: '設備費', item_name: '冰箱' },
  { label: '設備費－洗烘衣機', fee_type: '設備費', item_name: '洗烘衣機' },
  { label: '設備費－電視',   fee_type: '設備費', item_name: '電視' },
];

/** 由科目＋項目反查預設的顯示名稱。找不到就自己組，不要顯示成空白。 */
export function feeLabel(fee_type: string | null, item_name: string | null): string {
  const hit = CONTRACT_FEE_PRESETS.find(
    (p) => p.fee_type === fee_type && (p.item_name ?? null) === (item_name || null));
  if (hit) return hit.label;
  return item_name ? `${fee_type ?? '其他'}－${item_name}` : (fee_type ?? '其他');
}

/**
 * 沒選科目時記到認列表的預設值。
 * 跟 migration_75 裡的預設一致 —— 兩邊不同步的話,同一種單會出現兩個科目。
 */
export const FEE_DEFAULT = '其他';
