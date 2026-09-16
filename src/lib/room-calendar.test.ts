import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  daysInMonth, addDays, daysBetween, isWeekend, lastNightOf, occupies,
  compareRoomName, sortRooms, matchRoom, rowOf, hasFreeDay, hasStay, overlaps,
  overlapRanges, dropContractOrders, staysInRange, exitsSoon, ENDING_DAYS, LEAVING_DAYS, monthRange, rangeDays, eachDay, MAX_RANGE_DAYS,
  type Stay, type Room,
} from './room-calendar.ts';

const S = (o: Partial<Stay>): Stay => ({
  id: 'x', room: 'A5', kind: 'order', start: '2026-09-14', end: '2026-09-18',
  guest: 'Roni', tone: 'short', ...o,
});

describe('★★★ 兩種來源的「迄」邊界（使用者 2026-09-15 指定）', () => {
  /*
   * 短租　迄 = 最後一晚 + 1 天（checkout 是退房日）
   * 契約　迄 = 最後一晚
   *
   * 錯一格的後果是「畫面說有人、實際上空著」或反過來 —— 兩種都會排錯房。
   */
  test('★★★ 短租 9/14 入住 9/18 退房 → 只佔 14~17 四晚，18 號是空的', () => {
    const s = S({ kind: 'order', start: '2026-09-14', end: '2026-09-18' });
    assert.equal(lastNightOf(s), '2026-09-17');
    assert.equal(occupies(s, '2026-09-14'), true);
    assert.equal(occupies(s, '2026-09-17'), true);
    assert.equal(occupies(s, '2026-09-18'), false, '退房日當天可以接新客');
    assert.equal(occupies(s, '2026-09-13'), false);
  });

  test('★★★ 契約租期迄 9/30 → 佔到 30 號那一格', () => {
    const c = S({ kind: 'contract', start: '2026-09-01', end: '2026-09-30', tone: 'longterm' });
    assert.equal(lastNightOf(c), '2026-09-30');
    assert.equal(occupies(c, '2026-09-30'), true, '最後一晚含當日');
    assert.equal(occupies(c, '2026-10-01'), false);
  });

  test('★ 同一組日期，兩種來源差一格 —— 這就是唯一的換算點', () => {
    const o = S({ kind: 'order', start: '2026-09-01', end: '2026-09-10' });
    const c = S({ kind: 'contract', start: '2026-09-01', end: '2026-09-10' });
    assert.equal(occupies(o, '2026-09-10'), false);
    assert.equal(occupies(c, '2026-09-10'), true);
  });

  test('★ 當日單（加費、折讓：checkin = checkout）不佔任何一晚', () => {
    const fee = S({ kind: 'order', start: '2026-09-05', end: '2026-09-05' });
    assert.equal(occupies(fee, '2026-09-05'), false, '不然加費會在日曆上長出一格假的住宿');
    assert.equal(occupies(fee, '2026-09-04'), false);
  });

  test('★ 日期缺一半就不佔任何一天 —— 不要用猜的', () => {
    assert.equal(occupies(S({ end: null }), '2026-09-14'), false);
    assert.equal(occupies(S({ start: null }), '2026-09-14'), false);
  });
});

describe('★★★ 契約與它產生的月租單只能畫一筆（2026-09-15 的 bug）', () => {
  /*
   * 房源狀態頁上線第一天，「同一天有兩筆」的警示列出了**每一間長租房的每一天**。
   * 不是資料壞掉 —— 是契約撈了一次、`gen_contract_orders` 產的月租單又撈了一次。
   */
  const contract = S({
    id: 'c1', kind: 'contract', room: '10-1', tone: 'longterm',
    start: '2026-07-01', end: '2027-06-30', contractId: 'C',
  });
  const monthly = S({
    id: 'o1', kind: 'order', room: '10-1', tone: 'longterm',
    start: '2026-09-01', end: '2026-10-01', contractId: 'C',
  });

  test('★★★ 同一張契約的月租單被丟掉 —— 整月不再天天算重疊', () => {
    const kept = dropContractOrders([contract, monthly]);
    assert.deepEqual(kept.map((s) => s.id), ['c1']);
    assert.deepEqual(overlaps(kept, monthRange('2026-09')), [], '一天都不該重疊');
    assert.deepEqual(overlaps([contract, monthly], monthRange('2026-09')).length, 30,
      '（沒修之前是整整三十天）');
  });

  test('★★★ 契約不在清單裡（停用、或不在這個月）→ 月租單要留著', () => {
    // 丟掉的話，一間有人住的房間會在畫面上變成空的 —— 比多畫一筆嚴重得多
    const kept = dropContractOrders([monthly]);
    assert.deepEqual(kept.map((s) => s.id), ['o1']);
  });

  test('★★ 別張契約的月租單不受影響', () => {
    const other = S({ id: 'o2', kind: 'order', room: '10-2', contractId: 'D' });
    assert.deepEqual(dropContractOrders([contract, other]).map((s) => s.id), ['c1', 'o2']);
  });

  test('★★ 短租單沒有 contract_id —— 一筆都不准被掃到', () => {
    const air = S({ id: 'o3', kind: 'order', contractId: null });
    const air2 = S({ id: 'o4', kind: 'order' });   // 欄位根本沒給
    assert.deepEqual(dropContractOrders([contract, air, air2]).map((s) => s.id),
      ['c1', 'o3', 'o4']);
  });

  test('★ 沒有任何契約時原封不動', () => {
    const xs = [S({ id: 'a' }), S({ id: 'b', contractId: 'C' })];
    assert.deepEqual(dropContractOrders(xs).map((s) => s.id), ['a', 'b']);
  });
});

describe('日期工具', () => {
  test('每個月有幾天', () => {
    assert.equal(daysInMonth('2026-09'), 30);
    assert.equal(daysInMonth('2026-02'), 28);
    assert.equal(daysInMonth('2024-02'), 29, '閏年');
    assert.equal(daysInMonth('2026-12'), 31);
  });

  test('格式不對回 0，不要丟例外', () => {
    assert.equal(daysInMonth(''), 0);
    assert.equal(daysInMonth('2026-13'), 0);
  });

  test('加減天數會跨月跨年', () => {
    assert.equal(addDays('2026-09-30', 1), '2026-10-01');
    assert.equal(addDays('2026-01-01', -1), '2025-12-31');
    assert.equal(daysBetween('2026-09-14', '2026-09-18'), 4);
  });

  test('週末', () => {
    assert.equal(isWeekend('2026-09-19'), true);   // 六
    assert.equal(isWeekend('2026-09-20'), true);   // 日
    assert.equal(isWeekend('2026-09-21'), false);  // 一
  });
});

describe('★★ 房源照順序排（使用者 2026-09-15）', () => {
  /*
   * ★★★ 純字串排序會把 A13 排在 A5 前面（'1' < '5'）——
   *   畫面上看起來就是「亂的」，而使用者找房間是用眼睛掃的。
   */
  test('★★★ 數字段落當數字比 —— A1 A3 A5 A13，不是 A1 A13 A3 A5', () => {
    const got = ['A13', 'A5', 'A1', 'A3'].sort(compareRoomName);
    assert.deepEqual(got, ['A1', 'A3', 'A5', 'A13']);
  });

  test('★★ 帶符號的房號也要對 —— 2F-2 在 2F-10 前面', () => {
    const got = ['2F-10', '2F-2', '2F-1'].sort(compareRoomName);
    assert.deepEqual(got, ['2F-1', '2F-2', '2F-10']);
  });

  test('★ 先照物業的 sort，同物業內才照房號', () => {
    const rooms: Room[] = [
      { name: 'A5', estate: '亞曼尼', estateSort: 2 },
      { name: 'B1', estate: '正隆', estateSort: 1 },
      { name: 'A1', estate: '亞曼尼', estateSort: 2 },
      { name: 'B10', estate: '正隆', estateSort: 1 },
    ];
    assert.deepEqual(sortRooms(rooms).map((r) => r.name), ['B1', 'B10', 'A1', 'A5']);
  });

  test('★ 沒有 sort 的物業排最後，不要卡在中間', () => {
    const rooms: Room[] = [
      { name: 'X1', estate: '新光', estateSort: null },
      { name: 'B1', estate: '正隆', estateSort: 1 },
    ];
    assert.deepEqual(sortRooms(rooms).map((r) => r.name), ['B1', 'X1']);
  });
});

describe('★★ 搜尋房號或房客（使用者 2026-09-15）', () => {
  const room: Room = { name: 'A5', estate: '亞曼尼', estateSort: 1 };
  const stays = [S({ guest: 'Roni' }), S({ guest: '林小姐' })];

  test('打房號找得到', () => {
    assert.equal(matchRoom(room, stays, 'A5'), true);
    assert.equal(matchRoom(room, stays, 'a5'), true, '大小寫不該影響');
  });

  test('★ 打房客名字也找得到 —— 這是這次新增的', () => {
    assert.equal(matchRoom(room, stays, 'Roni'), true);
    assert.equal(matchRoom(room, stays, '林'), true);
  });

  test('打物業名字也找得到', () => {
    assert.equal(matchRoom(room, stays, '亞曼尼'), true);
  });

  test('★★ 清空搜尋框 = 沒有篩選（不是「篩不到任何東西」）', () => {
    assert.equal(matchRoom(room, stays, ''), true);
    assert.equal(matchRoom(room, stays, '   '), true);
    assert.equal(matchRoom(room, [], ''), true);
  });

  test('找不到就是 false', () => {
    assert.equal(matchRoom(room, stays, 'B7'), false);
    assert.equal(matchRoom(room, stays, 'Tanaka'), false);
  });
});

describe('排版成一列格子', () => {
  test('★★ 有人的那幾格合併成一條，span 要對', () => {
    const cells = rowOf([S({ kind: 'order', start: '2026-09-14', end: '2026-09-18' })], monthRange('2026-09'));
    const stay = cells.find((c) => c.type === 'stay') as any;
    assert.equal(stay.day, '2026-09-14');
    assert.equal(stay.span, 4, '14 15 16 17 四晚');
    // 格子總數（含合併）加起來要等於整個月
    const total = cells.reduce((a, c: any) => a + (c.type === 'stay' ? c.span : 1), 0);
    assert.equal(total, 30, '每一天都要被畫到，不能多也不能少');
  });

  test('★ 跨月的契約在這個月從 1 號畫到月底', () => {
    const cells = rowOf([S({ kind: 'contract', start: '2026-07-01', end: '2027-06-30' })], monthRange('2026-09'));
    assert.equal(cells.length, 1);
    assert.equal((cells[0] as any).span, 30);
    assert.equal(hasFreeDay(cells), false);
  });

  test('★ 整個月沒人 → 30 格全空', () => {
    const cells = rowOf([], monthRange('2026-09'));
    assert.equal(cells.length, 30);
    assert.equal(hasFreeDay(cells), true);
    assert.equal(hasStay(cells), false);
  });

  test('★ 一間房這個月住兩批，中間空幾天', () => {
    const cells = rowOf([
      S({ id: 'a', kind: 'order', start: '2026-09-01', end: '2026-09-05' }),
      S({ id: 'b', kind: 'order', start: '2026-09-10', end: '2026-09-13' }),
    ], monthRange('2026-09'));
    const stays = cells.filter((c) => c.type === 'stay') as any[];
    assert.equal(stays.length, 2);
    assert.equal(stays[0].span, 4);   // 1~4
    assert.equal(stays[1].span, 3);   // 10~12
    const total = cells.reduce((a, c: any) => a + (c.type === 'stay' ? c.span : 1), 0);
    assert.equal(total, 30);
  });

  /*
   * ★★★ 前一筆的退房日就是下一筆的入住日 —— 這是最常見的情況，
   *   而「迄 = 最後一晚 + 1」正是為了讓這一天**不會被算成兩筆**。
   */
  test('★★★ 前客退房當天後客入住 → 那一格屬於後客，不重疊', () => {
    const cells = rowOf([
      S({ id: 'a', kind: 'order', start: '2026-09-01', end: '2026-09-05', guest: '前客' }),
      S({ id: 'b', kind: 'order', start: '2026-09-05', end: '2026-09-09', guest: '後客' }),
    ], monthRange('2026-09'));
    const stays = cells.filter((c) => c.type === 'stay') as any[];
    assert.equal(stays.length, 2);
    assert.equal(stays[0].span, 4, '前客 1~4');
    assert.equal(stays[1].day, '2026-09-05');
    assert.equal(stays[1].stay.guest, '後客', '5 號是後客的');
    assert.deepEqual(overlaps([
      S({ id: 'a', kind: 'order', start: '2026-09-01', end: '2026-09-05' }),
      S({ id: 'b', kind: 'order', start: '2026-09-05', end: '2026-09-09' }),
    ], monthRange('2026-09')), [], '不算重疊');
  });

  test('★★ 真的重疊（資料有問題）要列得出來，不要靜靜蓋掉一筆', () => {
    const dup = [
      S({ id: 'a', kind: 'order', start: '2026-09-01', end: '2026-09-06' }),
      S({ id: 'b', kind: 'order', start: '2026-09-03', end: '2026-09-09' }),
    ];
    assert.deepEqual(overlaps(dup, monthRange('2026-09')),
      ['2026-09-03', '2026-09-04', '2026-09-05']);
  });
});

describe('★★★ 重疊要說得出「是哪兩筆」（使用者 2026-09-15：「？？」）', () => {
  /*
   * 10 月的 14B2 被列成「26、27、28、29、30、31 號」有兩筆，
   * 使用者去契約清單搜 14B2 —— 只有一筆，然後就沒路可走了。
   * 一條說「這裡有問題」卻不說是什麼的警示，比沒有還糟。
   */
  const contract = S({
    id: 'c1', kind: 'contract', room: '14B2', tone: 'longterm',
    guest: '金鋒行銷有限公司', start: '2026-10-01', end: '2029-09-30',
  });
  const air = S({
    id: 'o1', kind: 'order', room: '14B2', tone: 'short',
    guest: 'Roni', start: '2026-10-26', end: '2026-11-01',
  });

  test('★★★ 一段期間 ＋ 是哪幾筆，六天併成一段', () => {
    const rs = overlapRanges([contract, air], monthRange('2026-10'));
    assert.equal(rs.length, 1, '六天是同一件事，不是六件');
    assert.equal(rs[0].from, '2026-10-26');
    assert.equal(rs[0].to, '2026-10-31');
    assert.deepEqual(rs[0].stays.map((s) => s.guest).sort(),
      ['Roni', '金鋒行銷有限公司']);
    assert.deepEqual(rs[0].stays.map((s) => s.kind).sort(), ['contract', 'order']);
  });

  test('★★ 中途換了一筆 → 斷成兩段，不要黏成一大段', () => {
    const base = S({ id: 'a', start: '2026-10-01', end: '2026-10-21' });
    const x = S({ id: 'b', start: '2026-10-05', end: '2026-10-08' });   // 5~7
    const y = S({ id: 'c', start: '2026-10-15', end: '2026-10-18' });   // 15~17
    const rs = overlapRanges([base, x, y], monthRange('2026-10'));
    assert.deepEqual(rs.map((r) => [r.from, r.to]), [
      ['2026-10-05', '2026-10-07'],
      ['2026-10-15', '2026-10-17'],
    ]);
    assert.deepEqual(rs.map((r) => r.stays.map((s) => s.id)), [['a', 'b'], ['a', 'c']]);
  });

  test('★ 三筆疊在一起就三筆都列出來', () => {
    const rs = overlapRanges([
      S({ id: 'a', start: '2026-10-01', end: '2026-10-05' }),
      S({ id: 'b', start: '2026-10-01', end: '2026-10-05' }),
      S({ id: 'c', start: '2026-10-01', end: '2026-10-05' }),
    ], monthRange('2026-10'));
    assert.deepEqual(rs[0].stays.map((s) => s.id), ['a', 'b', 'c']);
  });

  test('★ 沒重疊就是空陣列', () => {
    assert.deepEqual(overlapRanges([contract], monthRange('2026-10')), []);
    assert.deepEqual(overlapRanges([], monthRange('2026-10')), []);
  });

  test('★★ `overlaps()` 是從 `overlapRanges()` 攤平的 —— 兩邊答案不准不一樣', () => {
    const xs = [contract, air];
    const flat = overlapRanges(xs, monthRange('2026-10'))
      .flatMap((r) => {
        const out: string[] = [];
        for (let d = r.from; d <= r.to; d = addDays(d, 1)) out.push(d);
        return out;
      });
    assert.deepEqual(overlaps(xs, monthRange('2026-10')), flat);
  });
});

/* ══════════════════════════════════════════════════════════
 * 自訂起訖（2026-09-16 使用者:「filter 選月份外可以選 自訂 起訖」）
 *
 * ★★★ 這一組存在的理由只有一個:**月檢視與自訂檢視必須是同一條路徑**。
 *   兩條路徑各算一次「哪一格有人」的話，改了一邊另一邊會安靜地留在舊答案，
 *   而症狀是「月檢視對、自訂檢視差一格」—— 沒有人會在畫面上看出來。
 * ══════════════════════════════════════════════════════════ */
describe('Range：自訂起訖', () => {
  test('monthRange() 就是「1 號到月底」的一個普通區間', () => {
    assert.deepEqual(monthRange('2026-09'), { from: '2026-09-01', to: '2026-09-30' });
    assert.deepEqual(monthRange('2026-02'), { from: '2026-02-01', to: '2026-02-28' });
    assert.deepEqual(monthRange('2024-02'), { from: '2024-02-01', to: '2024-02-29' }, '閏年');
  });

  test('★ 壞掉的月份回空區間,不是 crash —— 使用者可以把 input 清空', () => {
    assert.deepEqual(monthRange(''), { from: '', to: '' });
    assert.deepEqual(monthRange('2026-13'), { from: '', to: '' });
  });

  test('rangeDays() 含頭含尾', () => {
    assert.equal(rangeDays({ from: '2026-09-01', to: '2026-09-30' }), 30);
    assert.equal(rangeDays({ from: '2026-09-28', to: '2026-10-06' }), 9, '跨月');
    assert.equal(rangeDays({ from: '2026-09-05', to: '2026-09-05' }), 1, '同一天');
  });

  test('★★ 起迄顛倒或空的回 0 —— 不是負數也不是無限迴圈', () => {
    assert.equal(rangeDays({ from: '2026-09-30', to: '2026-09-01' }), 0);
    assert.equal(rangeDays({ from: '', to: '2026-09-01' }), 0);
    assert.equal(rangeDays({ from: '2026-09-01', to: '' }), 0);
    assert.deepEqual(eachDay({ from: '2026-09-30', to: '2026-09-01' }), []);
  });

  test('eachDay() 跨月接得起來（9/30 → 10/1）', () => {
    assert.deepEqual(eachDay({ from: '2026-09-29', to: '2026-10-02' }),
      ['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02']);
  });

  test('★★★ 月檢視 = monthRange 的自訂檢視,一格都不准差', () => {
    const stays = [
      S({ id: 'a', kind: 'order', start: '2026-09-14', end: '2026-09-18' }),
      S({ id: 'b', kind: 'contract', start: '2026-09-20', end: '2026-09-30' }),
    ];
    assert.deepEqual(
      rowOf(stays, monthRange('2026-09')),
      rowOf(stays, { from: '2026-09-01', to: '2026-09-30' }));
  });

  test('★★ 跨月的單在跨月區間裡是**一條**,不是斷成兩段', () => {
    // 9/28 入住、10/6 退房 → 最後一晚 10/5,共 8 晚
    const cells = rowOf([S({ kind: 'order', start: '2026-09-28', end: '2026-10-06' })],
      { from: '2026-09-28', to: '2026-10-06' });
    const bars = cells.filter((c) => c.type === 'stay');
    assert.equal(bars.length, 1, '跨過月底不該斷開');
    assert.equal((bars[0] as any).span, 8, '9/28~10/5 共 8 晚');
    assert.equal(cells.filter((c) => c.type === 'free').length, 1, '10/6 退房日是空的');
  });

  test('★★★ 被區間切掉的單,stay 上帶的還是**真實**起訖', () => {
    // 8/20 住到 9/10,九月的畫面從 1 號開始 —— 卡片要說 8/20,不是 9/1
    const cells = rowOf([S({ kind: 'order', start: '2026-08-20', end: '2026-09-10' })],
      monthRange('2026-09'));
    const bar = cells.find((c) => c.type === 'stay') as any;
    assert.equal(bar.day, '2026-09-01', '畫在 9/1 開始');
    assert.equal(bar.stay.start, '2026-08-20', '★ 但 stay 記得自己真的是 8/20 開始的');
    assert.equal(bar.span, 9, '9/1 ~ 9/9,9/10 退房');
  });

  test('★ 重疊偵測在跨月區間裡照樣跨得過去', () => {
    const a = S({ id: 'a', kind: 'contract', start: '2026-09-25', end: '2026-10-10' });
    const b = S({ id: 'b', kind: 'order', start: '2026-09-29', end: '2026-10-03' });
    const rs = overlapRanges([a, b], { from: '2026-09-20', to: '2026-10-15' });
    assert.equal(rs.length, 1);
    assert.equal(rs[0].from, '2026-09-29');
    assert.equal(rs[0].to, '2026-10-02', '訂單最後一晚是 10/2');
  });

  test('MAX_RANGE_DAYS 是 92 —— 改了這裡畫面那句提示也要跟著改', () => {
    assert.equal(MAX_RANGE_DAYS, 92);
  });
});

describe('staysInRange：篩選要看真相不是畫面', () => {
  test('★ 邊界上不佔任何一晚的單要被排掉', () => {
    const r = { from: '2026-09-01', to: '2026-09-30' } as const;
    // checkout 剛好是 9/1 的訂單 —— 最後一晚是 8/31,跟九月沒有交集
    assert.deepEqual(staysInRange([S({ kind: 'order', start: '2026-08-25', end: '2026-09-01' })], r), []);
    // 當日進當日出（加費、折讓）不佔任何一晚
    assert.deepEqual(staysInRange([S({ kind: 'order', start: '2026-09-10', end: '2026-09-10' })], r), []);
  });

  test('★★ 被壓住看不見的那一筆也要回 —— rowOf 只畫第一筆,篩選不能跟著瞎', () => {
    const r = monthRange('2026-09');
    const a = S({ id: 'a', kind: 'contract', start: '2026-09-01', end: '2026-09-30' });
    const b = S({ id: 'b', kind: 'order', start: '2026-09-10', end: '2026-09-15', tone: 'short' });
    assert.equal(rowOf([a, b], r).filter((c) => c.type === 'stay').length, 1, 'rowOf 只畫得下一筆');
    assert.deepEqual(staysInRange([a, b], r).map((s) => s.id), ['a', 'b'], '★ 但兩筆都在');
  });
});

/* ══════════════════════════════════════════════════════════
 * 空房與有客是 MECE（2026-09-16 使用者:「空房 還有 人耶」「空房 與 有訂單 是 MECE」）
 *
 * ★★★ 第一版的「空房」問的是 `hasFreeDay()`：有**任何一天**是空的。
 *   於是 9/4 才入住的房也算空房 —— 一顆叫「空房」的藥丸，答案裡有人。
 *   現在問的是 `staysInRange().length === 0`：整段都沒人。
 * ══════════════════════════════════════════════════════════ */
describe('空房 vs 有客：互斥且窮盡', () => {
  const r = monthRange('2026-09');

  test('★★★ 月中才入住的房**不是**空房 —— 但它確實「有空的日子」', () => {
    const late = [S({ kind: 'order', start: '2026-09-04', end: '2026-10-01' })];
    assert.equal(hasFreeDay(rowOf(late, r)), true, '9/1~9/3 是空的');
    assert.equal(staysInRange(late, r).length > 0, true, '★ 但這間房有人 —— 不算空房');
  });

  test('整段都沒人才是空房', () => {
    assert.equal(staysInRange([], r).length, 0);
    // 最後一晚落在區間外的也算沒人
    assert.equal(staysInRange([S({ kind: 'order', start: '2026-08-25', end: '2026-09-01' })], r).length, 0);
  });

  test('★★ 每一間房只會落在其中一邊,不會兩邊都是也不會兩邊都不是', () => {
    const rooms = [
      [] as any[],
      [S({ kind: 'order', start: '2026-09-04', end: '2026-10-01' })],
      [S({ kind: 'contract', start: '2026-01-01', end: '2027-12-31' })],
      [S({ kind: 'order', start: '2026-09-10', end: '2026-09-10' })],   // 當日進出,不佔任何一晚
    ];
    const occupied = rooms.filter((xs) => staysInRange(xs, r).length > 0).length;
    const free = rooms.filter((xs) => staysInRange(xs, r).length === 0).length;
    assert.equal(occupied + free, rooms.length, '★ 兩邊加起來 = 全部');
    assert.equal(occupied, 2);
    assert.equal(free, 2);
  });
});

/* ══════════════════════════════════════════════════════════
 * 退租／退房提醒（2026-09-16）
 *
 * ★★★ 兩種單的 `end` 存的是不同的東西，而剛好都是提醒要的那一天:
 *   契約 end_date ＝ 最後一晚 ＝ 退租日；訂單 checkout ＝ 退房日。
 *   但**畫在日曆上不一樣** —— 色條走 lastNightOf()，訂單會少一天。
 * ══════════════════════════════════════════════════════════ */
describe('退租／退房提醒', () => {
  const T = '2026-09-16';

  test('門檻：契約 45 天、訂單 7 天', () => {
    assert.equal(ENDING_DAYS, 45);
    assert.equal(LEAVING_DAYS, 7);
  });

  test('★ 契約：end_date 就是退租日,不用 ±1', () => {
    const c = S({ id: 'c1', kind: 'contract', start: '2025-01-01', end: '2026-10-20' });
    const r = exitsSoon([c], T, 'contract', ENDING_DAYS);
    assert.equal(r.length, 1);
    assert.equal(r[0].on, '2026-10-20');
    assert.equal(r[0].days, 34);
  });

  test('★★★ 訂單：提醒說的是 checkout,而色條畫到前一天 —— 差一天是對的', () => {
    const o = S({ id: 'o1', kind: 'order', start: '2026-09-20', end: '2026-09-23' });
    const r = exitsSoon([o], T, 'order', LEAVING_DAYS);
    assert.equal(r[0].on, '2026-09-23', '提醒:9/23 退房');
    assert.equal(r[0].days, 7);
    assert.equal(lastNightOf(o), '2026-09-22', '★ 而色條只畫到 9/22');
  });

  test('★★ 已經過去的不算 —— 提醒是關於還沒發生的事', () => {
    const past = S({ id: 'x', kind: 'contract', start: '2020-01-01', end: '2026-09-15' });
    assert.deepEqual(exitsSoon([past], T, 'contract', ENDING_DAYS), []);
  });

  test('今天到期的算進去（還有 0 天）', () => {
    const now = S({ id: 'n', kind: 'contract', start: '2020-01-01', end: T });
    const r = exitsSoon([now], T, 'contract', ENDING_DAYS);
    assert.equal(r.length, 1);
    assert.equal(r[0].days, 0);
  });

  test('剛好在門檻上算進去，超過一天就不算', () => {
    const on45  = S({ id: 'a', kind: 'contract', start: '2020-01-01', end: addDays(T, 45) });
    const on46  = S({ id: 'b', kind: 'contract', start: '2020-01-01', end: addDays(T, 46) });
    assert.equal(exitsSoon([on45, on46], T, 'contract', ENDING_DAYS).length, 1);
  });

  test('★ 只挑自己那一種 —— 契約的清單不會混進訂單', () => {
    const c = S({ id: 'c', kind: 'contract', start: '2020-01-01', end: '2026-09-20' });
    const o = S({ id: 'o', kind: 'order', start: '2026-09-18', end: '2026-09-20' });
    assert.deepEqual(exitsSoon([c, o], T, 'contract', ENDING_DAYS).map((x) => x.stay.id), ['c']);
    assert.deepEqual(exitsSoon([c, o], T, 'order', LEAVING_DAYS).map((x) => x.stay.id), ['o']);
  });

  test('快到的排前面,同一天照房號自然排序', () => {
    const mk = (id: string, room: string, end: string) =>
      S({ id, room, kind: 'contract', start: '2020-01-01', end });
    const r = exitsSoon([
      mk('c3', 'A13', '2026-09-30'),
      mk('c1', 'A5', '2026-09-20'),
      mk('c2', 'A5', '2026-09-30'),
    ], T, 'contract', ENDING_DAYS);
    assert.deepEqual(r.map((x) => x.stay.id), ['c1', 'c2', 'c3'], 'A5 排在 A13 前面');
  });

  test('沒有迄日的（訂金階段）不算', () => {
    const e = S({ id: 'e', kind: 'contract', start: '2026-09-01', end: null });
    assert.deepEqual(exitsSoon([e], T, 'contract', ENDING_DAYS), []);
  });
});
