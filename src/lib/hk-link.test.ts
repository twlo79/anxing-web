import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { normKey, isSubseq, guessLink, rankNames } from './hk-link.ts';

/* ── 拉平 ────────────────────────────────────── */

test('全形數字與英文轉半形', () => {
  assert.equal(normKey('ＪＰＲ１'), 'JPR1');
});

test('空白不算', () => {
  assert.equal(normKey('開封 4F'), '開封4F');
  assert.equal(normKey('開封　4F'), '開封4F');   // 全形空白
});

/* ── 子序列 ──────────────────────────────────── */

test('★ 縮寫是原名的子序列', () => {
  assert.ok(isSubseq('開4', '開封4F'));
  assert.ok(isSubseq('JPR1', 'JPR1F'));
  assert.ok(isSubseq('開2-1', '開封2-1'));
});

test('順序反了就不算', () => {
  assert.equal(isSubseq('4開', '開封4F'), false);
});

test('空字串不算對上 —— 不然它會對上每一個', () => {
  assert.equal(isSubseq('', '開封4F'), false);
});

/* ── 唯一候選 ────────────────────────────────── */

const ERP = ['開封4F', '開封3F', '開封2-1', '開封2-2', '開封2F', '開封整棟',
  'JPR1F', 'JPR2F', 'JPR整棟', '時兆A15'];

test('★★ 唯一對得上的才給提示', () => {
  assert.equal(guessLink('開4', [], ERP), '開封4F');
  assert.equal(guessLink('JPR1', [], ERP), 'JPR1F');
});

test('★★ 不只一個對得上就不提示 —— 那正是人要看的', () => {
  // 「開2」同時像 開封2-1、開封2-2、開封2F。給一個看起來很有把握的錯誤提示,
  // 比什麼都不給更容易被按下去
  assert.equal(guessLink('開2', [], ERP), null);
});

test('★ 完全相同的優先,不受其他候選干擾', () => {
  assert.equal(guessLink('JPR整棟', [], ERP), 'JPR整棟');
});

test('別名一起試 —— 別名本來就是為了比對而存在的', () => {
  assert.equal(guessLink('開整棟', ['開封整棟'], ERP), '開封整棟');
});

test('對不到就回 null,不退而求其次', () => {
  assert.equal(guessLink('復興', [], ERP), null);
});

test('沒有代碼也沒有別名時不提示', () => {
  assert.equal(guessLink('', [], ERP), null);
});

/* ── 排序 ────────────────────────────────────── */

test('★ 對得上的排到選單最前面', () => {
  const r = rankNames('開4', [], ERP);
  assert.equal(r[0], '開封4F');
  assert.equal(r.length, ERP.length, '一個都不能少 —— 排序不是篩選');
});

test('對不上的維持原本順序', () => {
  const r = rankNames('完全不相干', [], ERP);
  assert.deepEqual(r, ERP);
});


// ══════════════════════════════════════════════════════════════
// ★★★ 補零（2026-09-01 使用者:「A07 / B03」）
//
//   房務代碼是人手打的 `A7`、`B3`；ERP 房源補零對齊成 `A07`、`B03`。
//   不正規化的話 `A7` 會同時像 `A07` 與 `A17`,兩個候選、又沒有完全相等的,
//   於是**不給提示** —— 那幾間永遠對不到房源,打掃點數算不出來,
//   而畫面上顯示成「⚠ N 筆未計」,看起來像「忘了設點數」。
// ══════════════════════════════════════════════════════════════
describe('★★★ 補零正規化', () => {
  test('A07 與 A7 拉平後相同', () => {
    assert.equal(normKey('A07'), normKey('A7'));
    assert.equal(normKey('B03'), normKey('B3'));
  });

  test('★ 但 A17 不會被拉成 A7', () => {
    assert.notEqual(normKey('A17'), normKey('A7'));
  });

  test('★★ 中間與結尾的 0 不可以被吃掉', () => {
    // 直覺寫法 `.replace(/0+(\d)/g,'$1')` 會把 A100 變成 A10
    assert.equal(normKey('A100'), 'A100');
    assert.equal(normKey('A10'), 'A10');
    assert.equal(normKey('1000'), '1000');
  });

  test('多組數字各自處理', () => {
    assert.equal(normKey('開2-01'), '開2-1');
    assert.equal(normKey('台1+02'), '台1+2');
  });

  test('全形數字也要一起拉平', () => {
    assert.equal(normKey('Ａ０７'), normKey('A7'));
  });

  test('沒有數字的不受影響', () => {
    assert.equal(normKey('開封整棟'), '開封整棟');
    assert.equal(normKey(' jpr 整棟 '), 'JPR整棟');
  });
});

describe('★★★ 補零之後提示才給得出來', () => {
  const erp = ['A01', 'A05', 'A07', 'A17', 'B03', 'B05'];

  test('A7 → A07（原本因為同時像 A17 而不給提示）', () => {
    assert.equal(guessLink('A7', [], erp), 'A07');
  });

  test('B3 → B03', () => {
    assert.equal(guessLink('B3', [], erp), 'B03');
  });

  test('★ A17 還是對到 A17，沒有被搶走', () => {
    assert.equal(guessLink('A17', [], erp), 'A17');
  });

  test('★★ 真的模稜兩可時仍然不給提示', () => {
    // B3 與 B03 同時存在 —— 正規化後兩個都完全相等，回 null 才是對的。
    // 「模稜兩可時什麼都不說」這條規則沒有因為補零而鬆掉。
    assert.equal(guessLink('B3', [], ['B3', 'B03']), null);
  });

  test('★ 對不到的還是回 null', () => {
    assert.equal(guessLink('Z9', [], erp), null);
  });

  test('排序也跟著受惠：對得上的排前面', () => {
    // A07 與 A17 都是子序列命中（排前面）,B05 沒命中（排後面）
    const out = rankNames('A7', [], ['B05', 'A17', 'A07']);
    assert.equal(out[out.length - 1], 'B05');
    assert.ok(out.indexOf('A07') < out.indexOf('B05'));
  });
});
