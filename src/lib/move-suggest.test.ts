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
  assert.equal(s[0].toRoom, 'A09');
  assert.equal(s[0].gain, 2);
  assert.match(suggestionsText(s, '時兆'), /A05→A09 w/);
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
