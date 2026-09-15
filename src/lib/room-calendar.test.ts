import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  daysInMonth, addDays, daysBetween, isWeekend, lastNightOf, occupies,
  compareRoomName, sortRooms, matchRoom, rowOf, hasFreeDay, hasStay, overlaps,
  dropContractOrders,
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
    assert.deepEqual(overlaps(kept, '2026-09'), [], '一天都不該重疊');
    assert.deepEqual(overlaps([contract, monthly], '2026-09').length, 30,
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
    const cells = rowOf([S({ kind: 'order', start: '2026-09-14', end: '2026-09-18' })], '2026-09');
    const stay = cells.find((c) => c.type === 'stay') as any;
    assert.equal(stay.day, '2026-09-14');
    assert.equal(stay.span, 4, '14 15 16 17 四晚');
    // 格子總數（含合併）加起來要等於整個月
    const total = cells.reduce((a, c: any) => a + (c.type === 'stay' ? c.span : 1), 0);
    assert.equal(total, 30, '每一天都要被畫到，不能多也不能少');
  });

  test('★ 跨月的契約在這個月從 1 號畫到月底', () => {
    const cells = rowOf([S({ kind: 'contract', start: '2026-07-01', end: '2027-06-30' })], '2026-09');
    assert.equal(cells.length, 1);
    assert.equal((cells[0] as any).span, 30);
    assert.equal(hasFreeDay(cells), false);
  });

  test('★ 整個月沒人 → 30 格全空', () => {
    const cells = rowOf([], '2026-09');
    assert.equal(cells.length, 30);
    assert.equal(hasFreeDay(cells), true);
    assert.equal(hasStay(cells), false);
  });

  test('★ 一間房這個月住兩批，中間空幾天', () => {
    const cells = rowOf([
      S({ id: 'a', kind: 'order', start: '2026-09-01', end: '2026-09-05' }),
      S({ id: 'b', kind: 'order', start: '2026-09-10', end: '2026-09-13' }),
    ], '2026-09');
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
    ], '2026-09');
    const stays = cells.filter((c) => c.type === 'stay') as any[];
    assert.equal(stays.length, 2);
    assert.equal(stays[0].span, 4, '前客 1~4');
    assert.equal(stays[1].day, '2026-09-05');
    assert.equal(stays[1].stay.guest, '後客', '5 號是後客的');
    assert.deepEqual(overlaps([
      S({ id: 'a', kind: 'order', start: '2026-09-01', end: '2026-09-05' }),
      S({ id: 'b', kind: 'order', start: '2026-09-05', end: '2026-09-09' }),
    ], '2026-09'), [], '不算重疊');
  });

  test('★★ 真的重疊（資料有問題）要列得出來，不要靜靜蓋掉一筆', () => {
    const dup = [
      S({ id: 'a', kind: 'order', start: '2026-09-01', end: '2026-09-06' }),
      S({ id: 'b', kind: 'order', start: '2026-09-03', end: '2026-09-09' }),
    ];
    assert.deepEqual(overlaps(dup, '2026-09'),
      ['2026-09-03', '2026-09-04', '2026-09-05']);
  });
});
