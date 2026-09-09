import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  RECEIPT_COL, REQUEST_SIDE_KINDS, EXPENSE_INHERITS, emptyReceiptText,
  type ReceiptKind,
} from './receipt-parents.ts';
import { readFileSync } from 'node:fs';

/**
 * 憑證的「掛法」與「借看層」。
 *
 * ============================================================
 * 【★★★ 這支測試在防的那件事，2026-08-24 真的發生過】
 *
 * 那天新增了第二種掛法（逐項憑證 `request_item_id`），
 * 動了請款頁、Receipts、一支 migration —— **但沒有動支出頁**。
 *
 * 結果:之後逐項上傳的憑證在支出頁**從來沒顯示過**，
 * 而畫面寫的是「尚未上傳」。一個月後使用者才發現，
 * 而且第一直覺是「資料被刪了」。
 *
 * ★★★ 那次沒有任何東西會叫。這一支就是那個會叫的東西。
 */

describe('★★★ 憑證：新增一種掛法時，借看的那一端要跟上', () => {
  test('★★★ 請款側的每一種掛法，支出頁都要借看得到', () => {
    /*
     * 少一項的症狀:那一層的憑證在支出頁永遠是「尚未上傳」，
     * 不報錯、不留痕跡。
     *
     * ★ 如果你是因為新增掛法而看到這條紅字:
     *   把新的 kind 加進 `EXPENSE_INHERITS`，
     *   然後到 `expenses/page.tsx` 的兩個 `<Receipts>` 補上對應的 prop。
     */
    for (const k of REQUEST_SIDE_KINDS) {
      assert.ok(EXPENSE_INHERITS.includes(k),
        `請款側多了「${k}」這種掛法，但支出頁沒有借看它 —— `
        + `那一層的憑證會在支出頁永遠顯示「尚未上傳」`);
    }
  });

  test('★★ 借看的不能超出請款側 —— 借了不該借的等於顯示別人的憑證', () => {
    for (const k of EXPENSE_INHERITS) {
      assert.ok(REQUEST_SIDE_KINDS.includes(k), `${k} 不是請款側的掛法`);
    }
  });

  test('★★★ 對應表要跟 Receipts.tsx 裡那一份一致', () => {
    /*
     * 兩份會漂。這裡直接讀那支檔案比對 ——
     * 少一種的話 `Receipts` 的 col 會是 undefined，
     * 查詢變成 `.eq(undefined, id)`，PostgREST 回錯誤，
     * 而畫面上是「讀不到母單的憑證」這種看不懂的訊息。
     */
    const src = readFileSync(new URL('../components/Receipts.tsx', import.meta.url), 'utf8');
    for (const [kind, col] of Object.entries(RECEIPT_COL)) {
      assert.ok(src.includes(`'${col}'`),
        `Receipts.tsx 裡找不到欄位 '${col}'（kind=${kind}）—— 兩份對應表漂了`);
    }
  });

  test('★★★ 支出頁真的有傳那兩個 prop —— 光有清單沒有接線等於沒做', () => {
    /*
     * 這一條釘的是 2026-08-24 那次漏掉的**確切位置**。
     * 清單裡有、JSX 裡沒接，症狀跟完全沒做一模一樣。
     */
    const page = readFileSync(
      new URL('../app/(app)/expenses/page.tsx', import.meta.url), 'utf8');
    assert.ok(page.includes('inheritFromRequestId'), '支出頁沒有借看整張請款單');
    assert.ok(page.includes('inheritFromItemId'), '支出頁沒有借看請款項目');
  });

  test('★★ 每一種 kind 都有對應欄位，沒有空的', () => {
    for (const [k, col] of Object.entries(RECEIPT_COL)) {
      assert.ok(col && col.endsWith('_id'), `${k} 的欄位怪怪的：${col}`);
    }
  });

  test('★★ 沒有憑證時的說法要分兩種 —— 不要一律說「尚未上傳」', () => {
    /*
     * 說「尚未上傳」等於替使用者下了一個錯的結論，
     * 而他會去重傳一張 —— 於是同一張發票存了兩份。
     */
    assert.match(emptyReceiptText({ fromRequest: true }), /請款單/);
    assert.equal(emptyReceiptText({ fromRequest: true }).includes('尚未上傳'), false);
    assert.match(emptyReceiptText({ fromRequest: false, canEdit: true }), /尚未上傳/);
    // ★ 不能傳的人不要教他怎麼傳
    assert.equal(emptyReceiptText({ fromRequest: false }), '尚未上傳');
    assert.match(emptyReceiptText({ fromRequest: false, canEdit: true }), /手機/);
  });

  test('★ kind 的型別跟對應表對得起來', () => {
    const ks: ReceiptKind[] = Object.keys(RECEIPT_COL) as ReceiptKind[];
    assert.ok(ks.includes('pr') && ks.includes('pri') && ks.includes('exp'));
  });
});
