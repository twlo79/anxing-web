import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decide, summarize, toIssues, revenueOf, isCancelled,
  type Incoming, type Existing, type PropRef,
} from './airbnb-sync.ts';

const PROP_A15: PropRef = { id: 'p-a15', name: 'A15', estate_id: 'e-1' };
const PROP_OLD: PropRef = { id: 'p-old', name: '舊-A15', estate_id: 'e-1' };

const inc = (o: Partial<Incoming> = {}): Incoming => ({
  code: 'HM123', listingId: '1178627391586613020', guest: 'Kevin',
  start: '2026-07-01', end: '2026-07-05', nights: 4,
  statusKey: 'accepted', earnings: 20000, cohost: 0, ...o,
});

const ex = (o: Partial<Existing> = {}): Existing => ({
  order_key: 'HM123', source: 'airbnb',
  property_id: 'p-a15', property_raw: 'A15', guest_name: 'Kevin',
  checkin: '2026-07-01', checkout: '2026-07-05', amount: 20000, paid: false, ...o,
});

/* ── 新增 ────────────────────────────────────── */

test('沒見過的確認碼就新增', () => {
  const { decision } = decide(inc(), null, PROP_A15);
  assert.equal(decision.kind, 'insert');
  if (decision.kind === 'insert') {
    assert.equal(decision.row.order_key, 'HM123');
    assert.equal(decision.row.property_id, 'p-a15');
    assert.equal(decision.row.amount, 20000);
  }
});

test('對不到房源的新訂單不硬塞', () => {
  // 硬塞一筆沒有房源的訂單,它在報表上會變成沒有歸屬的數字,比不進來更難查
  const { decision } = decide(inc(), null, null);
  assert.equal(decision.kind, 'unmatched');
});

test('沒有收入的新訂單先不進來', () => {
  const { decision } = decide(inc({ earnings: 0, cohost: 0 }), null, PROP_A15);
  assert.equal(decision.kind, 'skip');
});

test('earnings 為 0 時改看搭檔收款', () => {
  assert.deepEqual(revenueOf(inc({ earnings: 0, cohost: -8000 })),
    { revenue: 8000, viaCohost: true });
  const { decision } = decide(inc({ earnings: 0, cohost: 8000 }), null, PROP_A15);
  assert.equal(decision.kind, 'insert');
  if (decision.kind === 'insert') {
    assert.equal(decision.row.amount, 8000);
    assert.match(String(decision.row.note), /搭檔/);
  }
});

/* ── 這一次改版的重點：不再重複建立 ──────────── */

test('★ 房客改名不會變成第二筆訂單', () => {
  // 2026-07 真的發生過:Michael / Michael Hu 同一筆變兩列,當月營收多算 33,053。
  // 用姓名當識別就會這樣 —— 確認碼才是鑰匙
  const { decision } = decide(inc({ guest: 'Michael Hu' }), ex({ guest_name: 'Michael' }), PROP_A15);
  assert.notEqual(decision.kind, 'insert', '同一個確認碼絕對不能再新增一筆');
});

test('★ 延住不會變成第二筆訂單', () => {
  const { decision } = decide(
    inc({ end: '2026-07-10', nights: 9 }), ex(), PROP_A15);
  assert.equal(decision.kind, 'update');
});

test('★ 房源對照改了也不會變成第二筆', () => {
  const { decision } = decide(inc(), ex(), PROP_OLD);
  assert.notEqual(decision.kind, 'insert');
});

/* ── A 級：一律更新 ──────────────────────────── */

test('★ 金額有值就不覆蓋,改列進差異', () => {
  // 2026-08-12 真的發生過:有人把一筆從 95,231.63 改成 124,346,
  // 隔天 06:06 同步改回去,中午另一個人又改成 158,720 ——
  // 兩個人都以為是自己沒存到。金額是營收,它自己會動比晚一天更新危險
  const { decision, diffs } = decide(inc({ earnings: 25000 }), ex({ amount: 20000 }), PROP_A15);
  if (decision.kind === 'update') assert.equal(decision.patch.amount, undefined);
  const d = diffs.find((x) => x.field === '金額');
  assert.ok(d, '不覆蓋但一定要講出來,否則調整就永遠進不來');
  assert.equal(d!.from, '20000');
  assert.equal(d!.to, '25000');
});

test('金額是空的或 0 才填進去', () => {
  // 那不是「改掉人工填的值」,那是把一筆殘缺的資料補完整
  for (const amt of [null, 0]) {
    const { decision } = decide(inc({ earnings: 25000 }), ex({ amount: amt }), PROP_A15);
    assert.equal(decision.kind, 'update');
    if (decision.kind === 'update') assert.equal(decision.patch.amount, 25000);
  }
});

test('★ 取消歸零不受金額保護影響', () => {
  // 取消不是「更新金額」,是作廢整筆訂單 —— 那條路不經過金額那道防護。
  // 擋掉的話已取消的訂單會一直被算進營收,而那是最貴的錯
  const { decision } = decide(
    inc({ statusKey: 'canceled_by_guest', earnings: 0, cohost: 0 }),
    ex({ amount: 99999 }), PROP_A15);
  assert.equal(decision.kind, 'void');
});

test('★ 住宿起訖一律更新,而且要列出來', () => {
  // 不更新的話營收會攤提在錯的月份,而且重複出租的檢查會失準
  const { decision, diffs } = decide(
    inc({ end: '2026-07-10', nights: 9 }), ex(), PROP_A15);
  if (decision.kind === 'update') {
    assert.equal(decision.patch.checkout, '2026-07-10');
    assert.equal(decision.patch.nights, 9);
  }
  assert.equal(diffs.length, 1);
  assert.equal(diffs[0].field, '住宿起訖');
  assert.match(diffs[0].to, /2026-07-10/);
});

test('起迄日同時變只列一筆,不是兩筆', () => {
  const { diffs } = decide(
    inc({ start: '2026-07-02', end: '2026-07-10' }), ex(), PROP_A15);
  assert.equal(diffs.filter((d) => d.field === '住宿起訖').length, 1);
});

/* ── B 級：只在空的時候填 ────────────────────── */

test('★ 房源已經有值就不覆蓋', () => {
  // 這是整個改版的目的:手動改過的房源不能被爬蟲蓋回去
  const { decision } = decide(inc(), ex({ property_id: 'p-a15' }), PROP_OLD);
  if (decision.kind === 'update') {
    assert.equal(decision.patch.property_id, undefined);
    assert.equal(decision.patch.property_raw, undefined);
    assert.equal(decision.patch.estate_id, undefined);
  }
});

test('★ 房源不一致要列出來,並附上 listing_id', () => {
  // 只是不覆蓋的話,對照表永遠是錯的,新訂單會一直掛錯而且沒人發現。
  // 這份清單就是「對照表該怎麼搬」的作業
  const { diffs } = decide(inc(), ex({ property_id: 'p-a15', property_raw: 'A15' }), PROP_OLD);
  const d = diffs.find((x) => x.field === '房源');
  assert.ok(d, '不覆蓋但要講出來');
  assert.equal(d!.from, 'A15');
  assert.equal(d!.to, '舊-A15');
  assert.equal(d!.listingId, '1178627391586613020');
});

test('房源是空的才填進去', () => {
  const { decision } = decide(inc(), ex({ property_id: null, property_raw: null }), PROP_A15);
  if (decision.kind === 'update') {
    assert.equal(decision.patch.property_id, 'p-a15');
    assert.equal(decision.patch.property_raw, 'A15');
  }
});

test('★ 姓名已經有值就不覆蓋,但要列出來', () => {
  const { decision, diffs } = decide(
    inc({ guest: 'Michael Hu' }), ex({ guest_name: '麥可' }), PROP_A15);
  if (decision.kind === 'update') assert.equal(decision.patch.guest_name, undefined);
  assert.ok(diffs.find((d) => d.field === '房客姓名'));
});

test('姓名是 (unknown) 時要補上真名', () => {
  // 那是當初抓不到名字時填的佔位字,不是人工輸入的內容
  const { decision } = decide(inc({ guest: 'Kevin Loo' }), ex({ guest_name: '(unknown)' }), PROP_A15);
  if (decision.kind === 'update') assert.equal(decision.patch.guest_name, 'Kevin Loo');
});

/* ── 取消 ────────────────────────────────────── */

test('取消且無收入 → 作廢', () => {
  const { decision } = decide(
    inc({ statusKey: 'canceled_by_guest', earnings: 0, cohost: 0 }), ex(), PROP_A15);
  assert.equal(decision.kind, 'void');
});

test('★ 已收款的取消單不自動歸零', () => {
  // 錢真的進來過。自動抹掉會讓營收憑空少一筆,而且沒有痕跡
  const { decision } = decide(
    inc({ statusKey: 'canceled', earnings: 0, cohost: 0 }), ex({ paid: true }), PROP_A15);
  assert.equal(decision.kind, 'attention');
});

test('取消但有收費 → 一次性收入的取消費', () => {
  const { decision } = decide(
    inc({ statusKey: 'canceled', earnings: 3000 }), null, PROP_A15);
  assert.equal(decision.kind, 'insert');
  if (decision.kind === 'insert') {
    assert.equal(decision.row.source, 'oneoff');
    assert.equal(decision.row.fee_type, '取消費');
  }
});

test('已經作廢過的不重複處理', () => {
  const { decision } = decide(
    inc({ statusKey: 'canceled', earnings: 0, cohost: 0 }),
    ex({ source: 'airbnb_cancelled' }), PROP_A15);
  assert.equal(decision.kind, 'skip');
});

test('isCancelled 認得各種取消字樣', () => {
  assert.ok(isCancelled(inc({ statusKey: 'canceled_by_host' })));
  assert.ok(isCancelled(inc({ statusKey: 'CANCELLED' })));
  assert.ok(!isCancelled(inc({ statusKey: 'accepted' })));
});

/* ── 沒有變化 ────────────────────────────────── */

test('★ 完全沒變的訂單不要送 update', () => {
  // 每天同步幾百筆,沒變的也全部 update 的話,updated_at 會全部跳動,
  // 「今天改了什麼」就再也看不出來了
  const { decision } = decide(inc(), ex(), PROP_A15);
  assert.equal(decision.kind, 'skip');
});

test('房源不一致但其他都沒變 → 只回報,不更新', () => {
  const { decision, diffs } = decide(inc(), ex(), PROP_OLD);
  assert.equal(decision.kind, 'skip');
  assert.equal(diffs.length, 1);
  assert.equal(diffs[0].field, '房源');
});

/* ── 統計 ────────────────────────────────────── */

test('summarize 把各種結果分類', () => {
  const s = summarize([
    decide(inc({ code: 'A' }), null, PROP_A15),
    decide(inc({ code: 'B', end: '2026-07-10', nights: 9 }), ex({ order_key: 'B' }), PROP_A15),
    decide(inc({ code: 'C', statusKey: 'canceled', earnings: 0, cohost: 0 }), ex({ order_key: 'C' }), PROP_A15),
    decide(inc({ code: 'D' }), null, null),
    decide(inc({ code: 'E' }), ex({ order_key: 'E' }), PROP_OLD),
  ]);
  assert.equal(s.inserted, 1);
  assert.equal(s.updated, 1);
  assert.equal(s.voided, 1);
  assert.equal(s.unmatched['1178627391586613020'], 1);
  assert.equal(s.diffs.filter((d) => d.field === '房源').length, 1);
});

/* ── 待辦清單 ────────────────────────────────── */

test('房源與姓名差異都會變成一條待辦', () => {
  const s = summarize([
    decide(inc({ code: 'A' }), ex({ order_key: 'A', property_id: 'p-a15', property_raw: 'A15' }), PROP_OLD),
    decide(inc({ code: 'B', guest: 'Michael Hu' }), ex({ order_key: 'B', guest_name: '麥可' }), PROP_A15),
  ]);
  const issues = toIssues(s);
  assert.equal(issues.filter((i) => i.field === '房源').length, 1);
  assert.equal(issues.filter((i) => i.field === '房客姓名').length, 1);
});

test('★ 房源不一致要附上 listing_id 與那個停用房源', () => {
  // 這條待辦要人去 /admin 修對照表。沒有 listing_id 的話他得自己回頭查,
  // 而「目前對到哪個停用房源」通常就是元兇
  const s = summarize([
    decide(inc(), ex({ property_id: 'p-a15', property_raw: 'A15' }), PROP_OLD),
  ]);
  const i = toIssues(s, { '1178627391586613020': '舊-A15' })[0];
  assert.equal(i.listingId, '1178627391586613020');
  assert.equal(i.extra?.['停用對照'], '舊-A15');
});

test('★ 對不到房源用 listing_id 當 code,不是訂單編號', () => {
  // 同一個 listing 一次對不到 5 筆訂單,那是同一件事、同一個地方要修。
  // 用訂單編號當鍵會變成 5 條待辦,而修好只需要動一個地方
  const s = summarize([
    decide(inc({ code: 'A' }), null, null),
    decide(inc({ code: 'B' }), null, null),
    decide(inc({ code: 'C' }), null, null),
  ]);
  const un = toIssues(s).filter((i) => i.field === '對不到房源');
  assert.equal(un.length, 1, '三筆訂單同一個 listing,只該有一條待辦');
  assert.equal(un[0].code, '1178627391586613020');
  assert.match(String(un[0].to), /3 筆/);
});

test('★ 已收款卻取消的要列進待辦,不能只是回傳一次就算了', () => {
  // 那筆要人去判斷錢到底收了沒。只在當天的回報講一次的話,
  // 沒看到就永遠不會再看到 —— 而它會一直錯下去
  const s = summarize([
    decide(inc({ statusKey: 'canceled', earnings: 0, cohost: 0 }), ex({ paid: true }), PROP_A15),
  ]);
  assert.equal(toIssues(s).filter((i) => i.field === '待人工判斷').length, 1);
});

test('沒有任何差異時清單是空的', () => {
  const s = summarize([decide(inc(), ex(), PROP_A15)]);
  assert.deepEqual(toIssues(s), []);
});

test('★ 同一個 listing 對不到多次要累計,不是各報各的', () => {
  const s = summarize([
    decide(inc({ code: 'A' }), null, null),
    decide(inc({ code: 'B' }), null, null),
  ]);
  assert.equal(s.unmatched['1178627391586613020'], 2);
});
