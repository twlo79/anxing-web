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

const o2 = (room: string, start: string, end: string, guest = room): Stay =>
  ({ id: `o${room}${start}`, room, kind: 'order', start, end, tone: 'short', guest });

test('移房建議：搬到剛好接得上的房 → 閒置 2 → 0', () => {
  const st = [
    o('x', 'A05', '2026-11-03', '2026-11-08'), o('w', 'A05', '2026-11-10', '2026-11-20'),
    o('l', 'A09', '2026-11-02', '2026-11-10'),
  ];
  const s = suggestMoves(['A05', 'A09'], st, T);
  const w = s.find((x) => x.stayId === 'w')!;
  assert.equal(w.side, 'before');
  assert.equal(w.before, 2);
  assert.deepEqual(w.cands, [{ toRoom: 'A09', after: 0 }]);
  assert.match(suggestionsText([w], '時兆'), /w .*A05→A09（閒置 2→0）/);
});

test('移房建議：契約、已入住的不動；搬過去空得更多的不列', () => {
  const st = [o('x', 'A05', '2026-11-03', '2026-11-08', 'longterm'), o('w', 'A05', '2026-11-10', '2026-11-20', 'longterm'),
    o('l', 'A09', '2026-11-02', '2026-11-10')];
  assert.equal(suggestMoves(['A05', 'A09'], st, T).length, 0);
  // A09 上一張 11/5 就退房 → 搬過去前面空 5 晚，比原本 2 晚多 → 不列
  const st2 = [o('x', 'A05', '2026-11-03', '2026-11-08', 'longterm'), o('w', 'A05', '2026-11-10', '2026-11-20'),
    o('l', 'A09', '2026-11-02', '2026-11-05')];
  assert.equal(suggestMoves(['A05', 'A09'], st2, T).length, 0);
});

test('David 的例子：苏东彤 B01 前面空 3 晚 → A04 上一張很久以前，閒置最多，最差', () => {
  const st = [
    o2('B01', '2026-11-30', '2026-12-02', 'Seb'), o2('B01', '2026-12-05', '2027-01-01', 'Su'),  // B01 空 12/2～4（3 晚）
    o2('A08', '2026-11-30', '2026-12-03', 'Bell'),                                               // 搬過去前面空 2 晚
    o2('A17', '2026-11-30', '2026-12-04', 'Gua'),                                                // 搬過去前面空 1 晚
    o2('A04', '2026-11-10', '2026-11-20', 'Old'),                                                // 上一張 11/20 退房 → 空 15 晚
  ];
  const s = suggestMoves(['A04', 'A08', 'A17', 'B01'], st, '2026-11-01', 60).find((x) => x.guest === 'Su')!;
  assert.equal(s.before, 3);
  assert.deepEqual(s.cands, [{ toRoom: 'A17', after: 1 }, { toRoom: 'A08', after: 2 }]);   // A04 空 15 晚 > 3，不列
});

test('David 的例子：Conan Wu → B05 接得上（閒置 3 → 0）最好', () => {
  const st = [
    o2('B07', '2026-12-01', '2026-12-03', '姚'), o2('B07', '2026-12-06', '2027-01-03', 'Conan'),
    o2('B05', '2026-12-01', '2026-12-06', 'Li'),
    o2('A16', '2026-12-01', '2026-12-04', 'Ang'),
  ];
  const s = suggestMoves(['A04', 'A16', 'B05', 'B07'], st, '2026-11-30', 60).find((x) => x.guest === 'Conan')!;
  assert.deepEqual(s.cands.map((c) => [c.toRoom, c.after]), [['B05', 0], ['A16', 2]]);
});

test('空檔在這張單後面：比的是到下一張入住中間空幾晚', () => {
  const st = [
    o2('A05', '2026-11-10', '2026-11-15', 'Me'), o2('A05', '2026-11-17', '2026-11-25', 'Next'),   // Me 後面空 2 晚
    o2('A09', '2026-11-15', '2026-11-20', 'Y'),                                                  // 搬過去後面接上
  ];
  const s = suggestMoves(['A05', 'A09'], st, '2026-11-01', 60).find((x) => x.guest === 'Me')!;
  assert.equal(s.side, 'after');
  assert.deepEqual(s.cands, [{ toRoom: 'A09', after: 0 }]);
});
