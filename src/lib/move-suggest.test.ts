import { test } from 'node:test';
import assert from 'node:assert/strict';
import { smallGaps, suggestMoves, suggestionsText } from './move-suggest.ts';
import type { Stay } from './room-calendar.ts';

const o = (id: string, room: string, start: string, end: string, tone: Stay['tone'] = 'short'): Stay =>
  ({ id, room, kind: 'order', start, end, tone, guest: id });
const T = '2026-11-01';

test('零碎空檔：兩邊都有人、3 晚以下才算', () => {
  const st = [o('a', 'A05', '2026-11-03', '2026-11-08'), o('b', 'A05', '2026-11-10', '2026-11-20')];
  assert.deepEqual(smallGaps(st, T, '2026-12-01', 3), [{ from: '2026-11-08', to: '2026-11-10', n: 2 }]);
  // 11/1～11/3 前面沒人 → 不算；11/20 之後到窗口底也不算
  assert.deepEqual(smallGaps([o('a', 'A05', '2026-11-03', '2026-11-08'), o('b', 'A05', '2026-11-13', '2026-11-20')], T, '2026-12-01', 3), []);
});

test('移房建議：把空檔後那筆整段搬到剛好接得上的房', () => {
  const st = [
    o('x', 'A05', '2026-11-03', '2026-11-08'), o('w', 'A05', '2026-11-10', '2026-11-20'),
    o('l', 'A09', '2026-11-02', '2026-11-10'),
  ];
  const s = suggestMoves(['A05', 'A09'], st, T);
  assert.equal(s.length, 1);
  assert.equal(s[0].stayId, 'w');
  assert.equal(s[0].cands[0].toRoom, 'A09');
  assert.equal(s[0].before, 2);
  assert.equal(s[0].cands[0].after, 0);
  assert.match(suggestionsText(s, '時兆'), /w .*A05→A09（閒置 2→0）/);
});

test('移房建議：契約、已入住的不動；搬過去會製造新空檔的不建議', () => {
  const st = [o('x', 'A05', '2026-11-03', '2026-11-08'), o('w', 'A05', '2026-11-10', '2026-11-20', 'longterm'),
    o('l', 'A09', '2026-11-02', '2026-11-10')];
  assert.equal(suggestMoves(['A05', 'A09'], st, T).length, 0);
  // A09 移過去後會在 11/20～11/22 夾出 2 晚 → 不建議
  const st2 = [o('x', 'A05', '2026-11-03', '2026-11-08'), o('w', 'A05', '2026-11-10', '2026-11-20'),
    o('l', 'A09', '2026-11-02', '2026-11-10'), o('m', 'A09', '2026-11-22', '2026-11-30')];
  const s2 = suggestMoves(['A05', 'A09'], st2, T);
  assert.equal(s2.length, 0);
});

test('移房建議：同一張單有多個候選，照移完閒置少的排', () => {
  const st = [
    o('x', 'A05', '2026-11-03', '2026-11-08'), o('w', 'A05', '2026-11-10', '2026-11-20'),
    o('l', 'A09', '2026-11-02', '2026-11-10'),                          // 剛好接上 → 閒置 0
    o('d', 'A11', '2026-11-02', '2026-11-09'),                          // 前面空 1 晚 → 閒置 1
  ];
  const s = suggestMoves(['A05', 'A09', 'A11'], st, T);
  assert.equal(s.length, 1);
  assert.deepEqual(s[0].cands.map((c) => c.toRoom), ['A09', 'A11']);
  assert.deepEqual(s[0].cands.map((c) => c.after), [0, 1]);
});

test('閒置一樣多時，接得上的排前面（David 2026-10-20：B05 應該是最好的）', () => {
  const o2 = (room: string, start: string, end: string, guest = room): Stay =>
    ({ id: `o${room}${start}`, room, kind: 'order', start, end, tone: 'short', guest });
  const st = [
    o2('B07', '2026-12-01', '2026-12-03', '姚'), o2('B07', '2026-12-06', '2027-01-03', 'Conan'),  // B07 空 12/3～6（3 晚）
    o2('B05', '2026-12-01', '2026-12-06', 'Li'),                                                 // 12/6 退房 → 接得上
    o2('A16', '2026-12-01', '2026-12-02', 'Ang'),                                                // 空 4 晚，還能賣
  ];
  const r = suggestMoves(['A04', 'A16', 'B05', 'B07'], st, '2026-11-30', 60);
  const s = r.find((x) => x.guest === 'Conan')!;
  assert.deepEqual(s.cands.map((c) => c.toRoom), ['B05', 'A16', 'A04']);   // A04 整段空著 → 排最後，盡量留著
  assert.equal(s.cands[0].snug, 1);
  assert.equal(s.cands[0].after, s.cands[1].after);
});

test('整段沒單的房排最後，就算算出來的閒置比較少（David：A04 是最差的）', () => {
  const o2 = (room: string, start: string, end: string, guest = room): Stay =>
    ({ id: `o${room}${start}`, room, kind: 'order', start, end, tone: 'short', guest });
  const st = [
    o2('B01', '2026-11-30', '2026-12-02', 'Seb'), o2('B01', '2026-12-05', '2027-01-01', 'Su'),   // B01 空 12/2～5
    o2('A08', '2026-11-30', '2026-12-03', 'Bell'),                                               // 搬去會夾出 2 晚
  ];
  const s = suggestMoves(['A04', 'A08', 'B01'], st, '2026-11-29', 60).find((x) => x.guest === 'Su')!;
  assert.deepEqual(s.cands.map((c) => c.toRoom), ['A08', 'A04']);
  assert.equal(s.cands[1].empty, true);
});
