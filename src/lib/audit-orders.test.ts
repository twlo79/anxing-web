import test from 'node:test';
import assert from 'node:assert/strict';
import {
  auditOrders, nightsInRange, isStay, daysBetween,
  AUDIT_LOW_RATIO, type AuditOrder,
} from './audit-orders.ts';

let seq = 0;
const o = (p: Partial<AuditOrder> = {}): AuditOrder => ({
  id: `o${++seq}`, source: 'private', property_raw: 'A15', estate_id: 'e-1',
  guest_name: 'Kevin', checkin: '2026-10-01', checkout: '2026-10-05',
  nights: 4, amount: 20000, ...p,
});
const issues = (r: ReturnType<typeof auditOrders>, id: string) => r.byId[id]?.issues ?? [];

/* ── 佔用晚數 ────────────────────────────────── */

test('★ 退房那天不算佔用', () => {
  // 10/1 入住、10/3 退房 = 佔用 10/1 與 10/2 兩晚。
  // 算成三天的話,前一筆 10/3 退、後一筆 10/3 進會被誤判成重疊
  assert.equal(nightsInRange(o({ checkin: '2026-10-01', checkout: '2026-10-03' })), 2);
});

test('只算落在期間內的那幾晚', () => {
  const x = o({ checkin: '2026-09-28', checkout: '2026-10-10' });
  assert.equal(nightsInRange(x, '2026-10-01', '2026-10-31'), 9);   // 10/1~10/9
});

test('完全不在期間內就是 0', () => {
  assert.equal(nightsInRange(o(), '2026-11-01', '2026-11-30'), 0);
});

test('一次性收入與加費子單不算住宿', () => {
  assert.equal(isStay(o({ source: 'oneoff' })), false);
  assert.equal(isStay(o({ source: 'airbnb_cancelled' })), false);
  assert.equal(isStay(o({ parent_order_id: 'p1' })), false);
  assert.equal(isStay(o()), true);
});

/* ── 日期 ────────────────────────────────────── */

test('迄日早於起日', () => {
  const r = auditOrders([o({ id: 'x', checkin: '2026-10-10', checkout: '2026-10-01' })]);
  assert.deepEqual(issues(r, 'x'), ['日期不合理']);
});

test('起訖同一天要說「這應該是一次性收入」', () => {
  const r = auditOrders([o({ id: 'x', checkout: '2026-10-01' })]);
  assert.match(r.byId['x'].notes.join(), /一次性收入/);
});

test('★ 住超過一年 —— 幾乎都是年份打錯', () => {
  const r = auditOrders([o({ id: 'x', checkin: '2024-10-01', checkout: '2026-10-01' })]);
  assert.ok(issues(r, 'x').includes('日期不合理'));
});

test('★ 入住日在兩年前要問是不是年份打錯', () => {
  // 2026-08 真的發生過:2026 被打成 2024,那筆安靜地掉到另一年的營收裡
  const r = auditOrders(
    [o({ id: 'x', checkin: '2024-10-01', checkout: '2024-10-31' })],
    {}, { today: '2026-10-01' });
  assert.ok(issues(r, 'x').includes('日期不合理'));
  assert.match(r.byId['x'].notes.join(), /年份/);
});

test('沒給 today 就不做年份判斷', () => {
  const r = auditOrders([o({ id: 'x', checkin: '2024-10-01', checkout: '2024-10-31' })]);
  assert.ok(!issues(r, 'x').includes('日期不合理'));
});

/* ── 缺漏 ────────────────────────────────────── */

test('房客、物業、金額沒填都算缺漏', () => {
  const r = auditOrders([o({ id: 'x', guest_name: '', estate_id: null, amount: 0 })]);
  assert.deepEqual(issues(r, 'x'), ['資料缺失']);
  assert.match(r.byId['x'].notes.join(), /房客.*物業.*金額/);
});

test('★ 房源沒填不算缺漏', () => {
  // 整棟出租、公區費用本來就沒有房號。算成缺漏的話每次驗算都會
  // 跳出一整排正常資料,而那會讓人開始忽略所有標記
  const r = auditOrders([o({ id: 'x', property_raw: null })]);
  assert.ok(!issues(r, 'x').includes('資料缺失'));
});

test('★ 房源不在現有清單裡要標出來', () => {
  // 抓「舊舊舊A13(7062)」這種殘留 —— 那些在報表上會自成一格,
  // 看起來像一間不存在的房子在賺錢
  const r = auditOrders([o({ id: 'x', property_raw: '舊舊舊A13(7062)' })],
    {}, { knownRooms: new Set(['A15', 'A13']) });
  assert.ok(issues(r, 'x').includes('資料缺失'));
  assert.match(r.byId['x'].notes.join(), /不在現有房源清單/);
});

test('★★ 已作廢的取消單完全不檢查', () => {
  // 爬蟲作廢 Airbnb 取消單時就是把金額設成 0 —— 那是正確狀態不是漏填。
  // 不跳過的話三百多筆取消單會全部被標成「資料缺失」,
  // 而標記大量出現在正常資料上,真正該看的那幾筆就被淹掉了
  const r = auditOrders([o({
    id: 'x', source: 'airbnb_cancelled', amount: 0,
    guest_name: 'Lulu Tan,', checkin: '2026-07-27', checkout: '2026-07-31',
  })]);
  assert.deepEqual(issues(r, 'x'), []);
});

test('一次性收入的金額 0 仍然要標 —— 那是真的漏填', () => {
  // 取消單的 0 是作廢,一次性收入的 0 是「收了一筆零元的費用」——
  // 兩者長得一樣但意思相反
  const r = auditOrders([o({ id: 'x', source: 'oneoff', amount: 0 })]);
  assert.ok(issues(r, 'x').includes('資料缺失'));
});

/* ── 重複 ────────────────────────────────────── */

test('★ 同房源同起訖同金額 = 重複,姓名不同也一樣', () => {
  // 2026-07 就是這樣:Michael / Michael Hu 被當成兩個人,同一筆變兩列,
  // 當月營收多算 33,053
  const r = auditOrders([
    o({ id: 'a', guest_name: 'Michael' }),
    o({ id: 'b', guest_name: 'Michael Hu' }),
  ]);
  assert.ok(issues(r, 'a').includes('重複訂單'));
  assert.ok(issues(r, 'b').includes('重複訂單'));
  assert.match(r.byId['a'].notes.join(), /只有姓名不同/);
});

test('★ 同房同日期但金額不同,仍然是問題 —— 那是 100% 重疊', () => {
  // 「不是同一筆匯入兩次」不等於「沒問題」:
  // 同一間房、同一段日期、兩個不同的金額,那是房間被賣了兩次
  const r = auditOrders([o({ id: 'a' }), o({ id: 'b', amount: 25000 })]);
  assert.ok(issues(r, 'a').includes('重複訂單'));
  assert.match(r.byId['a'].notes.join(), /重疊/);
});

test('日期完全沒有交集就不算重複', () => {
  const r = auditOrders([
    o({ id: 'a', checkin: '2026-10-01', checkout: '2026-10-05' }),
    o({ id: 'b', checkin: '2026-11-01', checkout: '2026-11-05', amount: 25000 }),
  ]);
  assert.equal(r.counts['重複訂單'], 0);
});

test('★ 移房拆出來的段落不算重複', () => {
  const r = auditOrders([
    o({ id: 'a', move_group: 'g1' }),
    o({ id: 'b', move_group: 'g1' }),
  ]);
  assert.equal(r.counts['重複訂單'], 0);
});

/* ── 期間重疊 ────────────────────────────────── */

test('★★ 同一間房兩筆期間重疊要抓出來', () => {
  // 2026-08 真的發生過:A15 劉令儀 7/22–10/09 與 智宜 7/30–8/31 重疊 32 天
  const r = auditOrders([
    o({ id: 'a', guest_name: '劉令儀', checkin: '2026-07-22', checkout: '2026-10-09' }),
    o({ id: 'b', guest_name: '智宜', checkin: '2026-07-30', checkout: '2026-08-31' }),
  ]);
  assert.ok(issues(r, 'a').includes('重複訂單'));
  assert.ok(issues(r, 'b').includes('重複訂單'));
  assert.match(r.byId['a'].notes.join(), /重疊 32 晚/);
});

test('★ 前一筆退房日 = 後一筆入住日,不算重疊', () => {
  // 這是最常見的正常情況。算成重疊的話,每一間週轉正常的房子
  // 都會被標記 —— 那等於整個功能失效
  const r = auditOrders([
    o({ id: 'a', checkin: '2026-10-01', checkout: '2026-10-05' }),
    o({ id: 'b', checkin: '2026-10-05', checkout: '2026-10-09' }),
  ]);
  assert.equal(r.counts['重複訂單'], 0);
});

test('不同房源的期間重疊不算問題', () => {
  const r = auditOrders([
    o({ id: 'a', property_raw: 'A15' }),
    o({ id: 'b', property_raw: 'B7' }),
  ]);
  assert.equal(r.counts['重複訂單'], 0);
});

test('★ 跨月的重疊也抓得到 —— 這是「房源過載」漏掉的', () => {
  // 兩筆各佔 20 天、重疊 10 天,分到兩個月看每個月都沒破表,
  // 實際上房間被賣了兩次
  const r = auditOrders([
    o({ id: 'a', checkin: '2026-10-20', checkout: '2026-11-09' }),
    o({ id: 'b', checkin: '2026-10-30', checkout: '2026-11-19' }),
  ]);
  assert.ok(issues(r, 'a').includes('重複訂單'));
  assert.equal(r.counts['房源過載'], 0, '每個月各自都沒超過天數');
});

/* ── 房源過載 ────────────────────────────────── */

test('★ 一個月被訂超過該月天數', () => {
  const r = auditOrders([
    o({ id: 'a', checkin: '2026-10-01', checkout: '2026-10-25' }),
    o({ id: 'b', checkin: '2026-10-05', checkout: '2026-10-28' }),
  ]);
  assert.ok(r.overloads.length > 0);
  assert.equal(r.overloads[0].limit, 31);
  assert.ok(r.overloads[0].used > 31);
});

test('★ 有選期間就用期間當上限', () => {
  // 使用者說的:「如果期間只選了 20 天,那房源加起來只能低於 20 天」
  const r = auditOrders([
    o({ id: 'a', checkin: '2026-10-01', checkout: '2026-10-16' }),
    o({ id: 'b', checkin: '2026-10-02', checkout: '2026-10-17' }),
  ], { from: '2026-10-01', to: '2026-10-20' });
  assert.equal(r.overloads[0].limit, 20);
  assert.equal(r.overloads[0].used, 30);
  assert.equal(r.overloads[0].scope, '篩選期間');
});

test('正常週轉不會被標成過載', () => {
  const r = auditOrders([
    o({ id: 'a', checkin: '2026-10-01', checkout: '2026-10-15' }),
    o({ id: 'b', checkin: '2026-10-15', checkout: '2026-10-31' }),
  ]);
  assert.equal(r.counts['房源過載'], 0);
});

test('一次性收入不佔用天數', () => {
  const r = auditOrders([
    o({ id: 'a', checkin: '2026-10-01', checkout: '2026-10-31' }),
    o({ id: 'b', source: 'oneoff', checkin: '2026-10-01', checkout: '2026-10-01', nights: 0 }),
  ]);
  assert.equal(r.counts['房源過載'], 0);
});

/* ── 房價過低 ────────────────────────────────── */

const cheap = (id: string, amount: number) =>
  o({ id, amount, checkin: '2026-10-01', checkout: '2026-10-02', nights: 1 });

test('★ 低於同房源均價六成要標', () => {
  const r = auditOrders([
    cheap('a', 3000), cheap('b', 3000), cheap('c', 3000), cheap('d', 300),
  ]);
  assert.ok(issues(r, 'd').includes('房價過低'));
  assert.ok(!issues(r, 'a').includes('房價過低'));
});

test('★ 樣本不足就不比 —— 那不是異常,是資料不夠', () => {
  const r = auditOrders([cheap('a', 3000), cheap('b', 300)]);
  assert.equal(r.counts['房價過低'], 0);
});

test('門檻是使用者定的六成', () => {
  assert.equal(AUDIT_LOW_RATIO, 0.6);
});

test('★ 比的是每晚單價,不是總額', () => {
  // 比總額的話,住一晚的訂單全部都會被標 —— 而那是最常見的情況
  const r = auditOrders([
    o({ id: 'a', amount: 30000, checkin: '2026-10-01', checkout: '2026-10-11' }),
    o({ id: 'b', amount: 30000, checkin: '2026-11-01', checkout: '2026-11-11' }),
    o({ id: 'c', amount: 30000, checkin: '2026-12-01', checkout: '2026-12-11' }),
    o({ id: 'd', amount: 3000, checkin: '2027-01-01', checkout: '2027-01-02' }),
  ]);
  assert.equal(r.counts['房價過低'], 0, '每晚都是 3000,沒有人偏低');
});

/* ── 整體 ────────────────────────────────────── */

test('乾淨的資料掃出來沒有任何標記', () => {
  const r = auditOrders([
    o({ id: 'a', checkin: '2026-10-01', checkout: '2026-10-05' }),
    o({ id: 'b', checkin: '2026-10-06', checkout: '2026-10-10' }),
  ]);
  assert.deepEqual(r.byId, {});
  assert.equal(r.scanned, 2);
});

test('同一筆可以同時有好幾種問題', () => {
  const r = auditOrders([o({ id: 'x', guest_name: '', checkin: '2026-10-10', checkout: '2026-10-01' })]);
  assert.deepEqual(issues(r, 'x').sort(), ['日期不合理', '資料缺失'].sort());
});

test('daysBetween 跨月跨年都對', () => {
  assert.equal(daysBetween('2026-10-01', '2026-11-01'), 31);
  assert.equal(daysBetween('2025-12-28', '2026-01-02'), 5);
});
