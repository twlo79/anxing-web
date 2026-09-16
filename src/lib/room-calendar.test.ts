import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  daysInMonth, addDays, daysBetween, isWeekend, lastNightOf, occupies,
  compareRoomName, sortRooms, matchRoom, rowOf, hasFreeDay, hasStay,
  overlaps, overlapRanges, staysInRange, dropContractOrders, exitsSoon,
  monthRange, rangeDays, eachDay, ymd, weekdayOf, MAX_RANGE_DAYS,
  type Stay, type Room, type Range,
} from './room-calendar.ts';

/*
 * ══════════════════════════════════════════════════════════
 * ★★★ 2026-09-16：這一份整個改寫過。
 *
 *   舊版全部呼叫 `rowOf(stays, '2026-09')` —— 傳的是**月份字串**。
 *   但 `rowOf` 在月→區間的改版時就已經改吃 `Range` 了，
 *   而這個檔案沒有跟著改。結果是 6 條測試一直紅著，
 *   直到今天跑全站測試才被翻出來。
 *
 *   ★★ 這正是它該做的事:**規則變了，釘子要叫**。
 *     叫了半天沒有人聽，是流程的問題，不是測試寫錯。
 *
 *   ★ 所以現在的寫法一律是 `monthRange('2026-09')` ——
 *     月檢視就是「1 號到月底」的一個普通區間，不是第二條路徑。
 * ══════════════════════════════════════════════════════════
 */

const S = (o: Partial<Stay>): Stay => ({
  id: 'x', room: 'A5', kind: 'order', start: '2026-09-14', end: '2026-09-18',
  guest: 'Roni', tone: 'short', ...o,
});

/** 這一份大多數的測試都在看九月 */
const SEP: Range = monthRange('2026-09');

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
    assert.equal(weekdayOf('2026-09-20'), 0, '週日是 0');
  });

  test('ymd 組日期', () => {
    assert.equal(ymd('2026-09', 1), '2026-09-01');
    assert.equal(ymd('2026-09', 14), '2026-09-14');
  });
});

describe('★★ 區間（2026-09-16 月→區間的改版）', () => {
  /*
   * ★★★ 月檢視**就是**一個普通區間，不是第二條路徑。
   *   兩條路徑各算一次「哪一格有人」的話，改了一邊另一邊會安靜地
   *   留在舊答案，而症狀是「月檢視對、自訂檢視差一格」。
   */
  test('★★★ monthRange 只是「1 號到月底」的一個區間', () => {
    assert.deepEqual(monthRange('2026-09'), { from: '2026-09-01', to: '2026-09-30' });
    assert.deepEqual(monthRange('2024-02'), { from: '2024-02-01', to: '2024-02-29' });
  });

  test('月份不合法回空區間，不要丟例外', () => {
    assert.deepEqual(monthRange('2026-13'), { from: '', to: '' });
    assert.equal(rangeDays(monthRange('2026-13')), 0);
  });

  test('rangeDays 含頭含尾', () => {
    assert.equal(rangeDays({ from: '2026-09-01', to: '2026-09-30' }), 30);
    assert.equal(rangeDays({ from: '2026-09-14', to: '2026-09-14' }), 1, '同一天算一天');
  });

  test('★ 起迄顛倒或空的回 0 —— 不是負數', () => {
    assert.equal(rangeDays({ from: '2026-09-30', to: '2026-09-01' }), 0);
    assert.equal(rangeDays({ from: '', to: '2026-09-01' }), 0);
    assert.equal(rangeDays({ from: '2026-09-01', to: '' }), 0);
  });

  test('★★ eachDay 跟 rangeDays 一定要對得起來 —— 兩邊各數一次遲早差一格', () => {
    const r = { from: '2026-09-28', to: '2026-10-03' };
    const ds = eachDay(r);
    assert.equal(ds.length, rangeDays(r));
    assert.deepEqual(ds, [
      '2026-09-28', '2026-09-29', '2026-09-30',
      '2026-10-01', '2026-10-02', '2026-10-03',
    ]);
  });

  test('eachDay 的空區間回空陣列', () => {
    assert.deepEqual(eachDay({ from: '', to: '' }), []);
  });

  test('★ 一次最多畫 92 天 —— 這個上限要有人守著', () => {
    assert.equal(MAX_RANGE_DAYS, 92);
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
      { name: 'X1', estate: '未分類', estateSort: null },
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
    const cells = rowOf([S({ kind: 'order', start: '2026-09-14', end: '2026-09-18' })], SEP);
    const stay = cells.find((c) => c.type === 'stay') as any;
    assert.equal(stay.day, '2026-09-14');
    assert.equal(stay.span, 4, '14 15 16 17 四晚');
    // 格子總數（含合併）加起來要等於整個月
    const total = cells.reduce((a, c: any) => a + (c.type === 'stay' ? c.span : 1), 0);
    assert.equal(total, 30, '每一天都要被畫到，不能多也不能少');
  });

  test('★ 跨月的契約在這個月從 1 號畫到月底', () => {
    const cells = rowOf([S({ kind: 'contract', start: '2026-07-01', end: '2027-06-30' })], SEP);
    assert.equal(cells.length, 1);
    assert.equal((cells[0] as any).span, 30);
    assert.equal(hasFreeDay(cells), false);
  });

  test('★ 整個月沒人 → 30 格全空', () => {
    const cells = rowOf([], SEP);
    assert.equal(cells.length, 30);
    assert.equal(hasFreeDay(cells), true);
    assert.equal(hasStay(cells), false);
  });

  test('★ 一間房這個月住兩批，中間空幾天', () => {
    const cells = rowOf([
      S({ id: 'a', kind: 'order', start: '2026-09-01', end: '2026-09-05' }),
      S({ id: 'b', kind: 'order', start: '2026-09-10', end: '2026-09-13' }),
    ], SEP);
    const stays = cells.filter((c) => c.type === 'stay') as any[];
    assert.equal(stays.length, 2);
    assert.equal(stays[0].span, 4);   // 1~4
    assert.equal(stays[1].span, 3);   // 10~12
    const total = cells.reduce((a, c: any) => a + (c.type === 'stay' ? c.span : 1), 0);
    assert.equal(total, 30);
  });

  test('★★ 自訂區間跟月檢視走同一條路 —— 不是第二種算法', () => {
    const r: Range = { from: '2026-09-28', to: '2026-10-03' };
    const cells = rowOf([S({ kind: 'order', start: '2026-09-29', end: '2026-10-02' })], r);
    const total = cells.reduce((a, c: any) => a + (c.type === 'stay' ? c.span : 1), 0);
    assert.equal(total, 6, '六天都要被畫到');
    const stay = cells.find((c) => c.type === 'stay') as any;
    assert.equal(stay.day, '2026-09-29');
    assert.equal(stay.span, 3, '29 30 1 三晚 —— 2 號退房不算');
  });

  test('★ 區間畫不出來（空的／顛倒）時回空陣列，不要丟例外', () => {
    assert.deepEqual(rowOf([S({})], { from: '', to: '' }), []);
    assert.deepEqual(rowOf([S({})], { from: '2026-09-30', to: '2026-09-01' }), []);
  });

  /*
   * ★★★ 前一筆的退房日就是下一筆的入住日 —— 這是最常見的情況，
   *   而「迄 = 最後一晚 + 1」正是為了讓這一天**不會被算成兩筆**。
   */
  test('★★★ 前客退房當天後客入住 → 那一格屬於後客，不重疊', () => {
    const cells = rowOf([
      S({ id: 'a', kind: 'order', start: '2026-09-01', end: '2026-09-05', guest: '前客' }),
      S({ id: 'b', kind: 'order', start: '2026-09-05', end: '2026-09-09', guest: '後客' }),
    ], SEP);
    const stays = cells.filter((c) => c.type === 'stay') as any[];
    assert.equal(stays.length, 2);
    assert.equal(stays[0].span, 4, '前客 1~4');
    assert.equal(stays[1].day, '2026-09-05');
    assert.equal(stays[1].stay.guest, '後客', '5 號是後客的');
    assert.deepEqual(overlaps([
      S({ id: 'a', kind: 'order', start: '2026-09-01', end: '2026-09-05' }),
      S({ id: 'b', kind: 'order', start: '2026-09-05', end: '2026-09-09' }),
    ], SEP), [], '不算重疊');
  });

  test('★★ 真的重疊（資料有問題）要列得出來，不要靜靜蓋掉一筆', () => {
    const dup = [
      S({ id: 'a', kind: 'order', start: '2026-09-01', end: '2026-09-06' }),
      S({ id: 'b', kind: 'order', start: '2026-09-03', end: '2026-09-09' }),
    ];
    assert.deepEqual(overlaps(dup, SEP),
      ['2026-09-03', '2026-09-04', '2026-09-05']);
  });
});

describe('★★★ 重疊要說出是哪幾筆（2026-09-15）', () => {
  /*
   * 只列「14B2 26、27、28、29、30、31 號」的話，
   * 使用者去契約清單查 14B2，只有一筆，然後就沒路可走了。
   * 一條說「這裡有問題」卻不說是什麼的警示，比沒有還糟。
   */
  test('連續幾天併成一段，並帶著是哪幾筆', () => {
    const dup = [
      S({ id: 'a', kind: 'order', start: '2026-09-01', end: '2026-09-06' }),
      S({ id: 'b', kind: 'order', start: '2026-09-03', end: '2026-09-09' }),
    ];
    const g = overlapRanges(dup, SEP);
    assert.equal(g.length, 1, '六天不要講成六次');
    assert.equal(g[0].from, '2026-09-03');
    assert.equal(g[0].to, '2026-09-05');
    assert.deepEqual(g[0].stays.map((s) => s.id).sort(), ['a', 'b']);
  });

  test('★ 中途換了一筆就要斷成兩段 —— 「同一組」看的是哪幾筆，不是有幾筆', () => {
    const dup = [
      S({ id: 'a', kind: 'order', start: '2026-09-01', end: '2026-09-11' }),
      S({ id: 'b', kind: 'order', start: '2026-09-01', end: '2026-09-05' }),
      S({ id: 'c', kind: 'order', start: '2026-09-06', end: '2026-09-09' }),
    ];
    const g = overlapRanges(dup, SEP);
    assert.equal(g.length, 2);
    assert.deepEqual(g[0].stays.map((s) => s.id).sort(), ['a', 'b']);
    assert.deepEqual(g[1].stays.map((s) => s.id).sort(), ['a', 'c']);
  });

  test('沒有重疊就回空陣列', () => {
    assert.deepEqual(overlapRanges([S({})], SEP), []);
  });
});

describe('★★ staysInRange —— 篩選要看真相，不是看畫面', () => {
  /*
   * `rowOf` 同一天只畫第一筆，這支每一筆都回。
   * 拿 `stays` 直接去算「這間房有沒有短租」的話，
   * 邊界上那幾筆（checkout 剛好等於 from、當日單）會讓一間空房被算成有客。
   */
  test('被壓住看不見的那一筆也要回', () => {
    /*
     * ★ b 整段被 a 包住 —— 畫面上它完全不存在（rowOf 同一天只畫第一筆），
     *   而那正是「拿畫面當真相」會漏掉的那一種。
     */
    const dup = [
      S({ id: 'a', kind: 'order', start: '2026-09-01', end: '2026-09-10' }),
      S({ id: 'b', kind: 'order', start: '2026-09-03', end: '2026-09-06' }),
    ];
    assert.equal(rowOf(dup, SEP).filter((c) => c.type === 'stay').length, 1, '畫面上只有一條');
    assert.equal(staysInRange(dup, SEP).length, 2, '但真相是兩筆');
  });

  test('★★★ checkout 剛好等於區間起日的訂單**不算** —— 它的最後一晚在上個月', () => {
    const s = S({ kind: 'order', start: '2026-08-20', end: '2026-09-01' });
    assert.deepEqual(staysInRange([s], SEP), []);
  });

  test('★ 當日進當日出的加費單不算', () => {
    const fee = S({ kind: 'order', start: '2026-09-05', end: '2026-09-05' });
    assert.deepEqual(staysInRange([fee], SEP), []);
  });

  test('跟區間有交集就算', () => {
    const s = S({ kind: 'contract', start: '2026-08-20', end: '2026-09-02' });
    assert.equal(staysInRange([s], SEP).length, 1);
  });
});

describe('★★★ 契約產生的月租單要丟掉（2026-09-15 上線第一天）', () => {
  /*
   * 契約與它長出來的月租單畫的是同一段期間，兩筆都留的話
   * 每一間長租房的每一天都會被算成「重疊」，警示把整頁塞滿。
   */
  const contract = S({
    id: 'c1', kind: 'contract', start: '2026-09-01', end: '2027-06-30',
    tone: 'longterm', contractId: 'K1',
  });
  const monthly = S({
    id: 'o1', kind: 'order', start: '2026-09-01', end: '2026-10-01', contractId: 'K1',
  });

  test('契約在清單裡 → 它的月租單丟掉', () => {
    const got = dropContractOrders([contract, monthly]);
    assert.deepEqual(got.map((s) => s.id), ['c1']);
  });

  test('★★ 契約不在清單裡（停用／撈不到）→ 月租單要留著', () => {
    /*
     * 一律丟掉的話，一間**有人住**的房間會在畫面上變成空的，
     * 而空房正是這一頁最會被拿來做決定的格子。
     */
    const got = dropContractOrders([monthly]);
    assert.deepEqual(got.map((s) => s.id), ['o1']);
  });

  test('★ 一般短租訂單（沒有 contractId）永遠留著', () => {
    const plain = S({ id: 'o2', kind: 'order' });
    assert.deepEqual(dropContractOrders([contract, plain]).map((s) => s.id), ['c1', 'o2']);
  });

  test('別張契約的月租單不受影響', () => {
    const other = S({ id: 'o3', kind: 'order', contractId: 'K2' });
    assert.deepEqual(dropContractOrders([contract, other]).map((s) => s.id), ['c1', 'o3']);
  });
});

describe('★★★ 退租／退房提醒 exitsSoon', () => {
  const T = '2026-09-16';
  const c = (id: string, room: string, end: string) =>
    S({ id, room, kind: 'contract', start: '2025-01-01', end, tone: 'longterm' });

  test('窗口之內的才回', () => {
    const got = exitsSoon([
      c('a', 'A1', '2026-09-20'),   // 4 天
      c('b', 'A2', '2026-12-31'),   // 106 天
    ], T, 'contract', 45);
    assert.deepEqual(got.map((e) => e.stay.id), ['a']);
    assert.equal(got[0].days, 4);
    assert.equal(got[0].on, '2026-09-20');
  });

  test('★★ 已經過去的不算 —— 提醒是關於還沒發生的事', () => {
    assert.deepEqual(exitsSoon([c('x', 'A1', '2026-09-15')], T, 'contract', 45), []);
  });

  test('★ 剛好今天到期算 0 天，不是被濾掉', () => {
    const got = exitsSoon([c('t', 'A1', T)], T, 'contract', 45);
    assert.equal(got.length, 1);
    assert.equal(got[0].days, 0);
  });

  test('★ 邊界含當天：剛好等於窗口的那一筆要進來', () => {
    const on = addDays(T, 45);
    assert.equal(exitsSoon([c('e', 'A1', on)], T, 'contract', 45).length, 1);
    assert.equal(exitsSoon([c('e', 'A1', addDays(T, 46))], T, 'contract', 45).length, 0);
  });

  test('★★ kind 要對得上 —— 契約的窗口不會撈到訂單', () => {
    const o = S({ id: 'o', kind: 'order', start: '2026-09-01', end: '2026-09-20' });
    assert.deepEqual(exitsSoon([o], T, 'contract', 45), []);
    assert.equal(exitsSoon([o], T, 'order', 45).length, 1);
  });

  test('沒有迄日的不算', () => {
    assert.deepEqual(exitsSoon([c('n', 'A1', null as any)], T, 'contract', 45), []);
  });

  test('★ 近的排前面；同一天照房號自然排序（不然每次重整順序都不一樣）', () => {
    const got = exitsSoon([
      c('c', 'A13', '2026-09-20'),
      c('a', 'A5', '2026-09-20'),
      c('b', 'A1', '2026-09-18'),
    ], T, 'contract', 45);
    assert.deepEqual(got.map((e) => e.stay.room), ['A1', 'A5', 'A13']);
  });

  test('★★★ 基準是「今天」，不是畫面上在看的期間', () => {
    /*
     * 翻到十二月看版面的時候，十月到期的契約不在日曆那一份裡 ——
     * 而提醒問的是「真實世界接下來會空出哪幾間」。
     * 這支只吃 today，沒有 Range 參數 —— 型別上就擋住了那個誤用。
     */
    const s = c('a', 'A1', '2026-10-01');
    assert.equal(exitsSoon([s], '2026-09-16', 'contract', 45).length, 1);
    assert.equal(exitsSoon([s], '2026-12-01', 'contract', 45).length, 0, '已經過去了');
  });
});
