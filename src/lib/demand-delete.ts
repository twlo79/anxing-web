/**
 * 刪採購需求單 —— 誰刪得掉、什麼不給刪、確認視窗要說什麼。
 *
 * ============================================================
 * 【為什麼要有這支】（2026-09-07 使用者:「可以刪 採購單」）
 *
 * 採購需求單從頭到尾沒有刪除功能,送錯、重複、測試留下的單子
 * 只能一直掛在清單上。加刪除本身很簡單 ——
 * **難的是「哪幾種不可以刪」,而那幾種刪下去都不會報錯。**
 *
 *
 * ============================================================
 * 【★★★ 已經被請款單領走的不能刪】
 *
 * `purchase_demand_items.request_item_id` 指向請款項目,一對一。
 * 刪掉需求項目之後:
 *
 *   · 那張請款單還在,錢照樣會付出去
 *   · 但「這筆錢當初是為了買什麼」的來源消失了
 *   · 而請款單那一頁**完全看不出來**有東西不見了
 *
 * ★★ 需求單與請款單沒有稽核觸發器（`data_audit` 只蓋七張表）,
 *   所以刪掉之後連「本來有這一項」都查不到 —— 回收桶是唯一的痕跡,
 *   而人不會想到去回收桶找一張請款單的來源。
 *
 * ★ 所以擋在按下去的那一刻,而且要說出**是哪一張請款單**,
 *   不然他不知道要去哪裡退。
 *
 *
 * ============================================================
 * 【為什麼刪整張單要看每一項】
 *
 * 一張單有五項,其中一項被請款單領走了 —— 刪整張單會把那一項一起帶走
 * （`trash_collect_children` 照外鍵自己收子列）。
 * 只檢查「這張單的狀態」是看不出來的,狀態是整張單的彙總。
 */

export type DeletableItem = {
  item_name: string;
  status: string;
  /** 被哪一列請款項目領走。有值就不能刪。 */
  request_item_id?: string | null;
  /** 領走它的那張請款單編號,只拿來寫訊息。 */
  request_no?: string | null;
};

/**
 * 這**一個項目**能不能刪。可以刪回 `null`,不能刪回一句話。
 *
 * ★ 「已請款但接不到單」（孤兒,`status === 'requested'` 而沒有
 *   `request_item_id`）**可以刪** —— 沒有任何東西指著它,
 *   而它卡在那裡不會前進。刪掉正是清理它的辦法之一。
 */
export function itemDeleteBlocked(i: DeletableItem): string | null {
  if (i.request_item_id) {
    return `「${i.item_name}」已經被請款單${i.request_no ? ` ${i.request_no}` : ''}領走了`
      + ' —— 要刪的話請先在請款單那邊退回這一項。';
  }
  return null;
}

/**
 * **整張單**能不能刪。回傳擋下來的理由,可以刪回 `null`。
 *
 * ★★ 一項都不能有。刪整張會連子列一起帶走,
 *   「其他四項可以刪、那一項留著」在回收桶那套機制裡做不到。
 */
export function demandDeleteBlocked(items: DeletableItem[]): string | null {
  const taken = items.filter((i) => i.request_item_id);
  if (taken.length === 0) return null;
  const nos = [...new Set(taken.map((i) => i.request_no).filter(Boolean))];
  return `這張單有 ${taken.length} 項已經被請款單領走`
    + (nos.length ? `（${nos.join('、')}）` : '')
    + ' —— 整張刪掉會把那幾項一起帶走。請先在請款單那邊退回，或只刪沒被領走的那幾項。';
}

// ── 確認視窗 ──────────────────────────────────────

/**
 * 刪一個項目的確認文字。
 *
 * ★★ 一定要寫**刪的是哪一項** —— 一張單五項長得很像,
 *   確認視窗只說「確定刪除?」的話,按下去才發現刪錯的機率很高。
 *
 * ★ 也要寫「進回收桶、可復原」。不寫的話人會不敢按,
 *   然後那些送錯的單就永遠留著。
 */
export function itemDeleteConfirm(i: DeletableItem): string {
  return `刪除「${i.item_name}」這一項？\n\n會移到回收桶，可以復原。`;
}

/**
 * 刪整張單的確認文字。
 *
 * ★★★ 要寫出**會連幾項一起刪**。使用者按的是單頭那顆鍵,
 *   而他腦中想的可能只是「這張單」—— 不寫項目數的話,
 *   五項一起消失會是個意外。
 */
export function demandDeleteConfirm(
  demandNo: string | null | undefined, items: DeletableItem[],
): string {
  const names = items.map((i) => i.item_name).filter(Boolean);
  const shown = names.slice(0, 5);
  return `刪除整張採購需求單 ${demandNo ?? '（未編號）'}？\n\n`
    + `底下 ${items.length} 項會一起刪掉：\n`
    + shown.map((n) => `　・${n}`).join('\n')
    + (names.length > shown.length ? `\n　…還有 ${names.length - shown.length} 項` : '')
    + '\n\n會移到回收桶，可以整張復原。';
}
