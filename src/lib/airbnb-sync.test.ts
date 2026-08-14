import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decide, summarize, toIssues, revenueOf, isCancelled,
  dedupe, isSettled, snapshotChanges, amountAdvice,
  snapshotRowOf, incomingOf, findMissing, forgetStaleChange,
  type Incoming, type Existing, type PropRef, type Snapshot,
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
  checkin: '2026-07-01', checkout: '2026-07-05', nights: 4, amount: 20000, paid: false, ...o,
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

test('★ 營收是「你賺得」＋「搭檔收款」', () => {
  // Airbnb 列表上的 Total Payout 是扣掉搭檔收款之後的淨額。
  // 直接拿來當營收的話,每一筆有搭檔的訂單都少算一大截,
  // 而且少算的比例每筆不同 —— 報表上完全看不出哪裡不對
  assert.deepEqual(revenueOf(inc({ earnings: 105479.73, cohost: -70319.83 })),
    { revenue: 175799.56, viaCohost: true });
});

test('沒有搭檔收款時就是 earnings 本身', () => {
  assert.deepEqual(revenueOf(inc({ earnings: 20000, cohost: 0 })),
    { revenue: 20000, viaCohost: false });
});

test('搭檔收款是正數或負數都要加回來', () => {
  // 明細裡是負數（被扣掉的）,但抓取端有可能已經取過絕對值
  assert.equal(revenueOf(inc({ earnings: 1000, cohost: -500 })).revenue, 1500);
  assert.equal(revenueOf(inc({ earnings: 1000, cohost: 500 })).revenue, 1500);
});

test('整筆被搭檔拆走（earnings 為 0）也算得出來', () => {
  const { decision } = decide(inc({ earnings: 0, cohost: 8000 }), null, PROP_A15);
  assert.equal(decision.kind, 'insert');
  if (decision.kind === 'insert') {
    assert.equal(decision.row.amount, 8000);
    assert.match(String(decision.row.note), /搭檔/);
  }
});

test('★ Erin 那筆的實際數字', () => {
  // 2026-08-13 的真實案例。David 手動把 95,231.63 改成 158,720,
  // 差額 63,488 就是那筆當時的搭檔收款 —— 他每改一筆就是在手算這個加法
  const { decision } = decide(
    inc({ code: 'HMPTCBX2H9', earnings: '$105,479.73', cohost: '-$70,319.83' }),
    null, PROP_A15);
  if (decision.kind === 'insert') assert.equal(decision.row.amount, 175799.56);
});

/* ── 人碰過的不動，但有三個例外 ──────────────── */

const edited = (o: Partial<Existing> = {}) => ex({ manually_edited: true, ...o });

test('★ 人工改過的金額不會被動,只列進差異', () => {
  const { decision, diffs } = decide(inc({ earnings: 99999 }), edited(), PROP_A15);
  if (decision.kind === 'update') assert.equal(decision.patch.amount, undefined);
  assert.ok(diffs.find((d) => d.field === '金額'));
});

test('★ 人工改過的房源與姓名也不會被動', () => {
  const { decision, diffs } = decide(
    inc({ guest: '別人' }), edited({ guest_name: '我填的' }), PROP_OLD);
  if (decision.kind === 'update') {
    assert.equal(decision.patch.property_id, undefined);
    assert.equal(decision.patch.guest_name, undefined);
  }
  assert.ok(diffs.find((d) => d.field === '房源'));
  assert.ok(diffs.find((d) => d.field === '房客姓名'));
});

test('★ 人改過但欄位是空的,也不自動填', () => {
  // 那個空可能就是他刻意清掉的。「幫他補回去」跟「把他改的蓋掉」
  // 對使用者來說是同一件事
  const { decision } = decide(
    inc(), edited({ amount: null, property_id: null, guest_name: '' }), PROP_A15);
  if (decision.kind === 'update') {
    assert.equal(decision.patch.amount, undefined);
    assert.equal(decision.patch.property_id, undefined);
    assert.equal(decision.patch.guest_name, undefined);
  }
});

test('★★ 例外一：取消照樣作廢,不管人有沒有改過', () => {
  // 最貴的失效方式是「某人改過一筆,之後房客取消,那筆永遠留在營收裡」。
  // 會讓營收變小的自動套用 —— 少算有人會發現,多算不會
  const { decision } = decide(
    inc({ statusKey: 'canceled_by_guest', earnings: 0, cohost: 0 }), edited(), PROP_A15);
  assert.equal(decision.kind, 'void');
});

test('★★ 住宿起訖也不自動改,但一定要建議', () => {
  // 這一條不改是有代價的,而且代價不在錢上:縮住沒更新,系統以為房間還有人,
  // 會推掉真訂單;延住沒更新,行事曆說房間是空的而實際有人住 —— 那會重複出租。
  // 補網是訂單頁的「👀防呆」期間重疊,但補網要人去按,所以分級不能放到最低
  for (const [end, nights, word] of [
    ['2026-07-03', 2, '縮住 2 晚'], ['2026-07-20', 19, '延住 15 晚'],
  ] as const) {
    const { decision, diffs } = decide(inc({ end, nights }), ex(), PROP_A15);
    assert.equal(decision.kind, 'skip', `${end} 不該自動改`);
    const d = diffs.find((x) => x.field === '住宿起訖');
    assert.ok(d, `${end} 一定要出建議`);
    assert.match(d!.reason!, new RegExp(word));
    assert.equal(d!.severity, 'mid', '不能放到最低 —— 這條會導致重複出租');
  }
});

test('★★ 例外三：訂單狀態照樣更新', () => {
  const { decision } = decide(
    inc({ statusKey: 'canceled', earnings: 3000 }), edited({ source: 'airbnb' }), PROP_A15);
  if (decision.kind === 'update') assert.equal(decision.patch.source, 'oneoff');
});

test('人工改過的已收款取消單仍然交人工', () => {
  const { decision } = decide(
    inc({ statusKey: 'canceled', earnings: 0, cohost: 0 }),
    edited({ paid: true }), PROP_A15);
  assert.equal(decision.kind, 'attention');
});

test('人改過但什麼都沒變 → 不送 update', () => {
  const { decision, diffs } = decide(inc(), edited(), PROP_A15);
  assert.equal(decision.kind, 'skip');
  assert.deepEqual(diffs, []);
});

test('沒有 manually_edited 旗標時照原本的規則走', () => {
  // 欄位是選填的。漏傳時不能整個系統變成「什麼都不填」
  const { decision } = decide(inc({ earnings: 25000 }), ex({ amount: null }), PROP_A15);
  if (decision.kind === 'update') assert.equal(decision.patch.amount, 25000);
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
  assert.notEqual(decision.kind, 'insert', '同一個確認碼絕對不能再新增一筆');
});

test('★ 房源對照改了也不會變成第二筆', () => {
  const { decision } = decide(inc(), ex(), PROP_OLD);
  assert.notEqual(decision.kind, 'insert');
});

/* ── A 級：一律更新 ──────────────────────────── */

test('★★ 人工編輯過的金額不覆蓋,改列進差異', () => {
  // 2026-08-12 真的發生過:有人把一筆從 95,231.63 改成 124,346,
  // 隔天 06:06 同步改回去,中午另一個人又改成 158,720 ——
  // 兩個人都以為是自己沒存到
  const { decision, diffs } = decide(
    inc({ earnings: 25000 }), ex({ amount: 20000, manually_edited: true }), PROP_A15);
  if (decision.kind === 'update') assert.equal(decision.patch.amount, undefined);
  const d = diffs.find((x) => x.field === '金額');
  assert.ok(d, '不覆蓋但一定要講出來,否則調整就永遠進不來');
  assert.equal(d!.from, '20000');
  assert.equal(d!.to, '25000');
  assert.match(d!.reason!, /人工編輯/, '要說出為什麼沒改,不然他會以為系統壞了');
});

test('★★ 連空的金額都不自動填 —— 既有訂單一律只建議', () => {
  // 「幫他補回去」跟「把他改的蓋掉」對使用者是同一件事:
  // 那個 0 也可能是某人刻意留的
  for (const amt of [null, 0]) {
    const { decision, diffs } = decide(inc({ earnings: 25000 }), ex({ amount: amt }), PROP_A15);
    assert.equal(decision.kind, 'skip');
    assert.ok(diffs.find((d) => d.field === '金額'), '不填但一定要講');
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
  assert.equal(s.voided, 1);
  // B 只有日期變了 —— 那是建議,不是自動更新
  assert.equal(s.updated, 0);
  assert.equal(s.diffs.filter((d) => d.field === '住宿起訖').length, 1);
  assert.equal(s.unmatched['1178627391586613020'], 1);
  assert.equal(s.diffs.filter((d) => d.field === '房源').length, 1);
});

/* ── 待辦清單 ────────────────────────────────── */

test('★★ 房源差異變成待辦,姓名差異不進清單', () => {
  // 姓名(Airbnb 顯示名 vs 正式姓名)永遠不會被修好 —— 它不是一件待辦。
  // 自清的清單只有在「空了就代表沒事」時才有意義,
  // 放永遠清不掉的東西進去,幾週後就沒有人在看那份清單了
  const s = summarize([
    decide(inc({ code: 'A' }), ex({ order_key: 'A', property_id: 'p-a15', property_raw: 'A15' }), PROP_OLD),
    decide(inc({ code: 'B', guest: 'Michael Hu' }), ex({ order_key: 'B', guest_name: '麥可' }), PROP_A15),
  ]);
  const issues = toIssues(s);
  assert.equal(issues.filter((i) => i.field === '房源').length, 1);
  assert.equal(issues.filter((i) => i.field === '房客姓名').length, 0);
  // 但差異本身還在 —— API 回應裡查得到,只是不佔清單
  assert.equal(s.diffs.filter((d) => d.field === '房客姓名').length, 1);
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

/* ══════════════════════════════════════════════════════
 * 去重
 * ══════════════════════════════════════════════════════ */

test('★★ 同一個確認碼在同一批裡只留一筆', () => {
  // 爬蟲翻頁時同一筆出現在兩頁是常態(Airbnb 的分頁依時間切)。
  // 不去重的話同一個碼會走兩次決策,兩次都判斷「這是新訂單」,
  // 然後插入兩列 —— 而重複的訂單在報表上看起來完全正常,
  // 只是那個月多了一筆錢。2026-07 多算 33,053、2026-08 多算 782,102
  const { items, dropped } = dedupe([inc({ code: 'X' }), inc({ code: 'X' }), inc({ code: 'Y' })]);
  assert.equal(items.length, 2);
  assert.equal(dropped, 1);
});

test('★★ 去重時不能丟掉有搭檔收款的那一筆', () => {
  // 明細抓失敗時 cohost 是 null,那不代表真的沒有搭檔收款。
  // 留錯的話那一筆就少算了 —— 而少算完全看不出來
  const withCohost = inc({ code: 'X', earnings: 105479.73, cohost: -70319.83 });
  const without = inc({ code: 'X', earnings: 105479.73, cohost: null });

  for (const order of [[withCohost, without], [without, withCohost]]) {
    const { items } = dedupe(order);
    assert.equal(revenueOf(items[0]).revenue, 175799.56,
      '不管哪個先來,都要留抓到搭檔收款的那筆');
  }
});

test('兩筆都沒有搭檔收款時留後面那筆 —— 後抓的資料比較完整', () => {
  const { items } = dedupe([inc({ code: 'X', guest: '舊' }), inc({ code: 'X', guest: '新' })]);
  assert.equal(items[0].guest, '新');
});

test('沒有確認碼的直接丟掉 —— 沒有鑰匙就無法比對', () => {
  const { items } = dedupe([inc({ code: '' }), inc({ code: 'X' })]);
  assert.equal(items.length, 1);
});

/* ══════════════════════════════════════════════════════
 * 退房後的結算窗口
 * ══════════════════════════════════════════════════════ */

test('★ 退房 7 天內還算「還在變動中」', () => {
  // Airbnb 的金額在退房之後還會動:最終結算、事後退款、客訴賠償。
  // 退房當天就鎖的話,那些最終數字永遠進不了系統
  assert.equal(isSettled('2026-07-05', '2026-07-12'), false, '第 7 天還沒鎖');
  assert.equal(isSettled('2026-07-05', '2026-07-13'), true, '第 8 天鎖住');
});

test('不知道退房日或今天就當作還沒定案', () => {
  assert.equal(isSettled(null, '2026-07-20'), false);
  assert.equal(isSettled('2026-07-05', null), false);
});

test('★★ 還在結算中的金額差異降一級 —— 過幾天可能還會再變', () => {
  // 現在去對,很可能過幾天要再對一次。那種「做了但白做」的事
  // 會讓人開始整份清單都不看
  const { decision, diffs } = decide(
    inc({ earnings: 105479.73, cohost: -70319.83 }),
    ex({ amount: 105479.73, checkout: '2026-07-05' }),
    PROP_A15, { today: '2026-07-08' });
  assert.equal(decision.kind, 'skip', '一個字都不改');
  const d = diffs.find((x) => x.field === '金額')!;
  assert.equal(d.severity, 'mid');
  assert.match(d.reason!, /還在結算中/);
});

test('★★ 已經定案的金額差異是最高級 —— 那個差是真的', () => {
  const { decision, diffs } = decide(
    inc({ earnings: 25000 }), ex({ amount: 20000, checkout: '2026-07-05' }),
    PROP_A15, { today: '2026-08-01' });
  assert.equal(decision.kind, 'skip');
  const d = diffs.find((x) => x.field === '金額')!;
  assert.equal(d.severity, 'high');
  assert.ok(!/還在結算中/.test(d.reason!), '已定案就不該說還會再變');
});

/* ══════════════════════════════════════════════════════
 * 快照比對與原因
 * ══════════════════════════════════════════════════════ */

const snap = (o: Partial<Snapshot> = {}): Snapshot => ({
  code: 'HM123', listing_id: '1178627391586613020', guest: 'Kevin',
  start_date: '2026-07-01', end_date: '2026-07-05', nights: 4,
  status_key: 'accepted', earnings: 20000, cohost: 0, revenue: 20000, ...o,
});

test('第一次看到就沒有「改了什麼」可講', () => {
  assert.deepEqual(snapshotChanges(null, inc()), []);
});

test('完全沒變就是空的', () => {
  assert.deepEqual(snapshotChanges(snap(), inc()), []);
});

test('★★ 搭檔收款從 0 變成有值要講出來', () => {
  // 這是這個專案最貴的一種錯:每筆有搭檔的訂單都少算,
  // 少算的比例每筆不同,看報表完全看不出哪裡不對
  const c = snapshotChanges(snap(), inc({ earnings: 105479.73, cohost: -70319.83 }));
  assert.ok(c.some((x) => /搭檔收款 \$0 → \$70,320/.test(x)), c.join(' | '));
});

test('★ 延住要講幾晚,不是只給兩個日期', () => {
  const c = snapshotChanges(snap(), inc({ end: '2026-07-09', nights: 8 }));
  assert.ok(c.some((x) => /4 晚 → 8 晚/.test(x)), c.join(' | '));
});

test('★ 取消與取消被撤回都要講', () => {
  assert.match(snapshotChanges(snap(), inc({ statusKey: 'canceled_by_guest' })).join(), /已取消/);
  assert.match(
    snapshotChanges(snap({ status_key: 'canceled_by_guest' }), inc()).join(), /撤回/);
});

test('★★ 金額建議要講方向與差多少', () => {
  // 「105,479 → 175,799」讀完還要自己減。差額才是他要填的東西
  const a = amountAdvice(105479.73, inc({ earnings: 105479.73, cohost: -70319.83 }));
  assert.equal(a.direction, '增加');
  assert.equal(a.delta, 70320);
  assert.match(a.reason, /應增加 \$70,320/);
});

test('★★ 差額正好等於搭檔收款時要直接點破', () => {
  // 這是一算就能確認的鐵證,而且是系統性的算法錯 ——
  // 不是這一筆的問題,是每一筆有搭檔的都少算
  const a = amountAdvice(105479.73, inc({ earnings: 105479.73, cohost: -70319.83 }));
  assert.match(a.reason, /少了搭檔收款/);
  assert.match(a.reason, /175,800/, '要把加法算式寫出來讓他當場對得起來');
  assert.equal(a.airbnbChanged, false, '沒有快照就不是「今天才變的」');
});

test('★★ Airbnb 今天改了的話,原因要講改了什麼', () => {
  // 這是新事件,跟「一直不一樣」的舊帳要分得開 ——
  // 混在一起的話每天早上看到的都是同一批熟面孔
  const a = amountAdvice(20000, inc({ earnings: 105479.73, cohost: -70319.83 }), snap());
  assert.equal(a.airbnbChanged, true);
  assert.match(a.reason, /Airbnb 這次改了/);
  assert.match(a.reason, /搭檔收款/);
});

test('系統裡是 0 的時候講「從來沒填過」', () => {
  assert.match(amountAdvice(0, inc({ earnings: 25000 })).reason, /從來沒填過/);
});

test('都對不上時說這個差是我們自己調的', () => {
  const a = amountAdvice(30000, inc({ earnings: 25000 }));
  assert.equal(a.direction, '減少');
  assert.match(a.reason, /我們這邊調過/);
});

/* ══════════════════════════════════════════════════════
 * 分級
 * ══════════════════════════════════════════════════════ */

test('★★ 會讓營收數字錯的排最前面', () => {
  const TODAY = '2026-08-01';   // 兩筆都已退房超過 7 天 = 已定案
  const s = summarize([
    // 住宿起訖:要改行事曆,但不影響營收金額
    decide(inc({ code: 'A', end: '2026-07-09', nights: 8 }),
      ex({ order_key: 'A' }), PROP_A15, { today: TODAY }),
    // 金額:營收數字是錯的
    decide(inc({ code: 'B', earnings: 25000 }),
      ex({ order_key: 'B' }), PROP_A15, { today: TODAY }),
  ]);
  const issues = toIssues(s);
  assert.equal(issues[0].field, '金額');
  assert.equal(issues[0].severity, 'high');
  assert.equal(issues.at(-1)!.field, '住宿起訖');
  assert.equal(issues.at(-1)!.severity, 'mid');
});

test('★★ Airbnb 今天才變的排在所有舊帳前面', () => {
  // 新事件多半好處理,而且錯過就會沉進舊帳裡。
  // 只按嚴重度排的話,它會被一整排陳年的高風險項目蓋住
  const s = summarize([
    decide(inc({ code: 'OLD', earnings: 25000 }),
      ex({ order_key: 'OLD', manually_edited: true }), PROP_A15),
    decide(inc({ code: 'NEW', end: '2026-07-09', nights: 8 }),
      ex({ order_key: 'NEW' }), PROP_A15,
      { prev: snap({ code: 'NEW' }) }),
  ]);
  const issues = toIssues(s);
  assert.equal(issues[0].code, 'NEW');
  assert.equal(issues[0].airbnbChanged, true);
});

test('對不到房源與待人工判斷都是最高級', () => {
  const s = summarize([
    decide(inc({ code: 'A' }), null, null),
    decide(inc({ code: 'B', statusKey: 'canceled', earnings: 0, cohost: 0 }),
      ex({ order_key: 'B', paid: true }), PROP_A15),
  ]);
  for (const i of toIssues(s)) assert.equal(i.severity, 'high', i.field);
});

test('★ 每一條待辦都要講得出「怎麼做」', () => {
  // 沒有建議的清單只是一份焦慮清單
  const s = summarize([
    decide(inc({ code: 'A' }), null, null),
    decide(inc({ code: 'B', earnings: 25000 }),
      ex({ order_key: 'B', manually_edited: true }), PROP_A15),
    decide(inc({ code: 'C' }), ex({ order_key: 'C' }), PROP_OLD),
    decide(inc({ code: 'D', statusKey: 'canceled', earnings: 0, cohost: 0 }),
      ex({ order_key: 'D', paid: true }), PROP_A15),
  ]);
  for (const i of toIssues(s)) {
    assert.ok(i.reason && i.reason.length > 10, `${i.field} 沒有說明`);
  }
});

/* ══════════════════════════════════════════════════════
 * 階段一 ⇄ 階段二：快照的來回
 * ══════════════════════════════════════════════════════ */

const NOW = '2026-08-14T02:00:00.000Z';

test('★ 第一次看到就建一列,changed_at 是空的', () => {
  // 第一輪所有訂單都是「第一次看到」,不該有任何「這次才改的」標記 ——
  // 全部亮起來的話那個標記等於沒有
  const r = snapshotRowOf(inc(), null, NOW);
  assert.equal(r.code, 'HM123');
  assert.equal(r.revenue, 20000);
  assert.equal(r.changed_at, null);
  assert.equal(r.change_note, null);
  assert.equal(r.seen_count, 1);
});

test('★★ 沒變的話 changed_at 與 change_note 要原封不動寫回去', () => {
  // PostgREST 的批次 upsert 取所有列的欄位聯集,少了某個鍵就填 null ——
  // 那會把「上次是什麼時候變的」整批抹掉,而且完全不報錯
  const prev: Snapshot = {
    code: 'HM123', start_date: '2026-07-01', end_date: '2026-07-05', nights: 4,
    status_key: 'accepted', earnings: 20000, cohost: 0, revenue: 20000,
    changed_at: '2026-08-01T00:00:00.000Z', change_note: '搭檔收款 $0 → $500', seen_count: 9,
  };
  const r = snapshotRowOf(inc(), prev, NOW);
  assert.equal(r.changed_at, '2026-08-01T00:00:00.000Z');
  assert.equal(r.change_note, '搭檔收款 $0 → $500');
  assert.equal(r.last_seen, NOW, 'last_seen 每次都要更新');
  assert.equal(r.seen_count, 10);
});

test('★★ 變了就記下改了什麼 —— 那句話只有這一刻講得出來', () => {
  // 對帳可能晚幾小時甚至隔天跑,那時舊值已經被蓋掉,
  // 「從多少變成多少」再也算不出來
  const prev: Snapshot = {
    code: 'HM123', start_date: '2026-07-01', end_date: '2026-07-05', nights: 4,
    status_key: 'accepted', earnings: 105479.73, cohost: 0, revenue: 105479.73,
  };
  const r = snapshotRowOf(inc({ earnings: 105479.73, cohost: -70319.83 }), prev, NOW);
  assert.equal(r.changed_at, NOW);
  assert.match(r.change_note!, /搭檔收款 \$0 → \$70,320/);
  assert.equal(r.revenue, 175799.56);
});

test('★ 又看到就把「不見了」的記號清掉', () => {
  // 不清的話,一筆曾經因為掃描範圍沒涵蓋而被標記過的訂單,
  // 會永遠掛著失蹤的記號
  assert.equal(snapshotRowOf(inc(), null, NOW).missing_since, null);
});

test('★ 原始明細整包存著 —— 錯過就再也拿不到', () => {
  // 今天只想到要比金額、日期、搭檔收款。哪天發現清潔費要單獨記帳,
  // raw 裡有的話回頭算得出來,沒有的話那段歷史就永遠沒有了
  const m = inc();
  assert.deepEqual(snapshotRowOf(m, null, NOW).raw, m);
});

test('★★ 快照轉回去對帳時金額要一樣', () => {
  // 決策邏輯只有一份,兩個階段共用 —— 轉換弄丟東西的話,
  // 對帳看到的會是另一筆訂單
  const m = inc({ earnings: 105479.73, cohost: -70319.83 });
  const row = snapshotRowOf(m, null, NOW);
  const back = incomingOf(row as unknown as Snapshot);
  assert.equal(revenueOf(back).revenue, 175799.56);
  assert.equal(back.code, m.code);
  assert.equal(back.start, m.start);
  assert.equal(back.statusKey, m.statusKey);
});

test('★★ 快照的搭檔收款已經是絕對值,轉回去不能再翻一次號', () => {
  const row = snapshotRowOf(inc({ earnings: 1000, cohost: -500 }), null, NOW);
  assert.equal(row.cohost, 500, '存的時候取絕對值');
  assert.equal(revenueOf(incomingOf(row as unknown as Snapshot)).revenue, 1500);
});

/* ══════════════════════════════════════════════════════
 * 消失偵測
 * ══════════════════════════════════════════════════════ */

const sn = (o: Partial<Snapshot> = {}): Snapshot => ({
  code: 'A', start_date: '2026-07-01', last_seen: '2026-08-01T00:00:00.000Z', ...o,
});

test('★★ 沒給掃描範圍就完全不做 —— 那不是偵測,是猜', () => {
  // 爬蟲每天只抓最近幾頁,一年前的訂單本來就不會出現。
  // 拿「這輪沒看到」當「不見了」,會把幾千筆正常歷史全標成失蹤
  assert.deepEqual(findMissing([sn()], null, NOW), []);
  assert.deepEqual(findMissing([sn()], { from: '2026-07-01', to: null }, NOW), []);
});

test('★★ 範圍內這輪沒看到的才算不見了', () => {
  const got = findMissing(
    [sn({ code: 'A' }), sn({ code: 'B', last_seen: NOW })],
    { from: '2026-06-01', to: '2026-08-31' }, NOW);
  assert.deepEqual(got.map((s) => s.code), ['A'], 'B 這輪看到了就不算');
});

test('★ 範圍外的一律不碰', () => {
  const got = findMissing([sn({ start_date: '2025-01-01' })],
    { from: '2026-06-01', to: '2026-08-31' }, NOW);
  assert.equal(got.length, 0);
});

test('已經標記過的不重複報 —— 同一件事講一次就好', () => {
  const got = findMissing([sn({ missing_since: '2026-08-10T00:00:00.000Z' })],
    { from: '2026-06-01', to: '2026-08-31' }, NOW);
  assert.equal(got.length, 0);
});

/* ══════════════════════════════════════════════════════
 * 變動記號會過期
 * ══════════════════════════════════════════════════════ */

test('★★ 太舊的變動記號要忘掉,否則標記會永遠亮著', () => {
  // change_note 是留著的 —— 三個月前改過搭檔收款的訂單,那句話到今天都還在。
  // 直接拿來當「這次才改的」,清單上就會永遠亮著一排,等於沒有標記
  const old = sn({ changed_at: '2026-05-01T00:00:00.000Z', change_note: '搭檔收款 $0 → $500' });
  const f = forgetStaleChange(old, '2026-08-13T00:00:00.000Z');
  assert.equal(f.change_note, null);
  assert.equal(f.changed_at, null);
});

test('夠新的就留著', () => {
  const fresh = sn({ changed_at: '2026-08-14T01:00:00.000Z', change_note: '延住 4 晚' });
  assert.equal(forgetStaleChange(fresh, '2026-08-13T00:00:00.000Z').change_note, '延住 4 晚');
});

test('★★ 對帳時靠 change_note 認出「這次才改的」', () => {
  // 階段二拿到的 prev 就是快照本身(已經是今天的樣子),逐欄比一定相同 ——
  // 認得出來全靠爬取當下存下的那句話
  const snapNow = sn({
    code: 'HM123', end_date: '2026-07-05', nights: 4,
    status_key: 'accepted', earnings: 25000, cohost: 0, revenue: 25000,
    changed_at: NOW, change_note: '搭檔收款 $0 → $5,000',
  });
  const a = amountAdvice(20000, incomingOf(snapNow), snapNow);
  assert.equal(a.airbnbChanged, true);
  assert.match(a.reason, /Airbnb 這次改了：搭檔收款/);
});

test('★ 忘掉記號之後就退回一般的原因判斷', () => {
  const stale = forgetStaleChange(sn({
    code: 'HM123', end_date: '2026-07-05', nights: 4, status_key: 'accepted',
    earnings: 105479.73, cohost: 70319.83, revenue: 175799.56,
    changed_at: '2026-05-01T00:00:00.000Z', change_note: '搭檔收款 $0 → $70,320',
  }), '2026-08-13T00:00:00.000Z');
  const a = amountAdvice(105479.73, incomingOf(stale), stale);
  assert.equal(a.airbnbChanged, false);
  assert.match(a.reason, /少了搭檔收款/, '退回「差額正好等於搭檔收款」那條');
});

test('★★ scope 是「窮舉範圍」不是「涵蓋範圍」', () => {
  // 2026-08-14 的真實事故:爬蟲送三趟抓取的 min/max 入住日,
  // 但其中一趟只取前 100 筆 —— 那些沒抓到的訂單落在 min~max 之間,
  // 於是 203 筆正常的歷史訂單被標成失蹤。
  //
  // 這個測試釘的是**函式的合約**:它信任 scope,所以 scope 必須只涵蓋
  // 真的全抓了的區間。餵錯範圍就會得到錯的答案 —— 這裡把那個後果寫下來。
  const 舊訂單 = sn({ code: 'OLD', start_date: '2025-03-01', last_seen: '2026-01-01T00:00:00.000Z' });
  const 今天抓到的 = sn({ code: 'NEW', start_date: '2026-08-20', last_seen: NOW });

  // 錯的用法:宣告涵蓋 2025-03 到 2026-08(min/max)
  const 誤報 = findMissing([舊訂單, 今天抓到的], { from: '2025-03-01', to: '2026-08-31' }, NOW);
  assert.deepEqual(誤報.map((s) => s.code), ['OLD'],
    '舊訂單被誤判成失蹤 —— 這就是那 203 筆的成因');

  // 對的用法:只宣告真的翻到取完的那一段(今天以後)
  const 正確 = findMissing([舊訂單, 今天抓到的], { from: '2026-08-14', to: '2026-12-31' }, NOW);
  assert.deepEqual(正確, [], '舊訂單不在窮舉範圍內,不做判斷');
});
