import test from 'node:test';
import assert from 'node:assert/strict';
import { trashAge, fieldRows, TABLE_LABEL } from './trash.ts';

const NOW = new Date('2026-08-11T00:00:00Z');

test('幾天前用天數講', () => {
  assert.equal(trashAge('2026-08-08T00:00:00Z', NOW).text, '3 天前');
  assert.equal(trashAge('2026-08-08T00:00:00Z', NOW).old, false);
});

test('★ 超過一個月要標「舊」—— 不自動刪，但要看得出年代', () => {
  const a = trashAge('2026-04-11T00:00:00Z', NOW);
  assert.equal(a.old, true);
  assert.match(a.text, /4 個月/);
});

test('超過一年講年', () => {
  assert.match(trashAge('2025-01-01T00:00:00Z', NOW).text, /1 年多/);
});

test('★ 壞掉的日期不會顯示 NaN', () => {
  assert.equal(trashAge('not-a-date', NOW).text, '');
  assert.equal(trashAge('not-a-date', NOW).days, 0);
});

test('未來的日期不會變成負數天', () => {
  assert.equal(trashAge('2026-12-01T00:00:00Z', NOW).days, 0);
});

// ── 欄位顯示 ───────────────────────────────────────

test('★ 空值一律不顯示', () => {
  // 一張 orders 四十幾欄大多是 null，全列出來的話有內容的那五欄會被埋掉
  const rows = fieldRows({
    guest_name: '王小明', note: null, account: '', nights: 0,
    fx_revenue: [], detail_comments: {},
  });
  const keys = rows.map(([k]) => k);
  assert.deepEqual(keys, ['guest_name', 'nights']);
});

test('★ 0 要顯示 —— 它是有意義的值，不是空的', () => {
  assert.deepEqual(fieldRows({ amount: 0 }), [['amount', '0']]);
});

test('★ false 也要顯示', () => {
  assert.deepEqual(fieldRows({ paid: false }), [['paid', 'false']]);
});

test('內部欄位藏起來', () => {
  const keys = fieldRows({ id: 'x', created_at: 'y', updated_at: 'z', amount: 100 })
    .map(([k]) => k);
  assert.deepEqual(keys, ['amount']);
});

test('物件與陣列轉成 JSON 字串,不會變成 [object Object]', () => {
  const rows = fieldRows({ lines: [{ ccy: 'USD', amt: 100 }] });
  assert.match(rows[0][1], /USD/);
});

test('空物件不會壞', () => {
  assert.deepEqual(fieldRows({}), []);
  assert.deepEqual(fieldRows(null as any), []);
});

// ── 表名對照 ───────────────────────────────────────

test('主要的表都有中文名', () => {
  for (const t of ['orders', 'contracts', 'expenses', 'purchase_requests', 'deposits',
                   'invoices', 'order_payments', 'revenue_recognitions']) {
    assert.ok(TABLE_LABEL[t], `${t} 沒有中文名`);
  }
});

// ── softDelete / restoreTrash ──────────────────────

import { softDelete, restoreTrash } from './trash.ts';

const rpcReturning = (data: unknown, error: { message: string } | null = null) => ({
  calls: [] as any[],
  async rpc(fn: string, args: Record<string, unknown>) {
    (this.calls as any[]).push({ fn, args });
    return { data, error };
  },
});

test('刪除成功時把 trash_id 帶回來 —— 立即 undo 要靠它', async () => {
  const db = rpcReturning({ ok: true, message: '已移到回收桶', trash_id: 't-1' });
  const r = await softDelete(db, 'orders', 'o-1', '測試');
  assert.equal(r.ok, true);
  assert.equal(r.trashId, 't-1');
  assert.deepEqual(db.calls[0], {
    fn: 'soft_delete', args: { p_table: 'orders', p_id: 'o-1', p_reason: '測試' },
  });
});

test('沒給理由時送 null,不是 undefined', async () => {
  // undefined 在 JSON 裡會整個消失,PostgREST 會說少一個參數
  const db = rpcReturning({ ok: true, message: 'x' });
  await softDelete(db, 'orders', 'o-1');
  assert.equal(db.calls[0].args.p_reason, null);
});

test('★ RPC 回 ok:false 要當成失敗,不能只看 error', async () => {
  // 權限不足是 ok:false 而不是 error —— 只看 error 的話畫面會顯示「已刪除」
  // 然後那筆資料還在,而使用者以為刪掉了
  const db = rpcReturning({ ok: false, code: 'NO_PERM', message: '沒有權限' });
  const r = await softDelete(db, 'profiles', 'p-1');
  assert.equal(r.ok, false);
  assert.equal(r.message, '沒有權限');
});

test('★ RPC 什麼都沒回時當失敗,不是成功', async () => {
  // 回 null 卻當成功的話,使用者會看到「已刪除」而資料完好無損
  const r = await softDelete(rpcReturning(null), 'orders', 'o-1');
  assert.equal(r.ok, false);
  assert.match(r.message, /沒有回應/);
});

test('連線錯誤照實說', async () => {
  const r = await softDelete(rpcReturning(null, { message: 'network down' }), 'orders', 'o-1');
  assert.equal(r.ok, false);
  assert.match(r.message, /network down/);
});

test('復原走 restore_trash', async () => {
  const db = rpcReturning({ ok: true, message: '已復原' });
  const r = await restoreTrash(db, 't-1');
  assert.equal(r.ok, true);
  assert.deepEqual(db.calls[0], { fn: 'restore_trash', args: { p_trash: 't-1' } });
});

test('★ 重複復原被擋時要回失敗', async () => {
  const r = await restoreTrash(rpcReturning({ ok: false, code: 'ALREADY', message: '這筆已經復原過了。' }), 't-1');
  assert.equal(r.ok, false);
  assert.match(r.message, /已經復原/);
});

// ── 類型下拉 ───────────────────────────────────────

import { typeOptions, DELETABLE_TABLES } from './trash.ts';

const R = (...t: string[]) => t.map((table_name) => ({ table_name }));

test('★ 沒有紀錄的類型也要列出來,標 0', () => {
  // 只列「有紀錄的」的話,選單裡只會有一個「訂單」——
  // 看到的人會以為這個系統只記得住訂單的刪除
  const o = typeOptions(R('orders', 'orders'));
  assert.equal(o.length, DELETABLE_TABLES.length);
  assert.equal(o.find((x) => x.value === 'orders')?.count, 2);
  assert.equal(o.find((x) => x.value === 'deposits')?.count, 0);
});

test('順序照 DELETABLE_TABLES,不是照筆數或字母', () => {
  // 照筆數排的話,選單的位置每天都在變 —— 使用者記不住「支出在第四個」
  const o = typeOptions(R('deposits', 'deposits', 'deposits'));
  assert.deepEqual(o.slice(0, 2).map((x) => x.value), ['orders', 'contracts']);
});

test('★ 清單裡沒有的類型也要出現,不能默默消失', () => {
  // 通常代表 DELETABLE_TABLES 漏了一張表。至少要看得見,
  // 否則那些紀錄在選單裡永遠選不到
  const o = typeOptions(R('reviews'));
  const hit = o.find((x) => x.value === 'reviews');
  assert.ok(hit, '資料裡有 reviews,選項就該有 reviews');
  assert.equal(hit?.count, 1);
});

test('用中文名當標籤', () => {
  const o = typeOptions([]);
  assert.equal(o.find((x) => x.value === 'purchase_requests')?.label, '請款單');
});

test('★ 每個可刪除的表都要有中文名', () => {
  // 沒有的話選單上會冒出一個英文表名
  for (const t of DELETABLE_TABLES) {
    assert.ok(TABLE_LABEL[t], `${t} 沒有中文名`);
  }
});
