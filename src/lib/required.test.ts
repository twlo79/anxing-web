import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  isFilled, missingFields, missingMessage, submitGate, gateCls,
} from './required.ts';

test('文字：只打空白等於沒填', () => {
  assert.equal(isFilled({ label: 'x', value: '游宗堉' }), true);
  assert.equal(isFilled({ label: 'x', value: '' }), false);
  assert.equal(isFilled({ label: 'x', value: '   ' }), false);
  assert.equal(isFilled({ label: 'x', value: null }), false);
});

test('★ 金額必須大於 0', () => {
  assert.equal(isFilled({ label: 'x', value: 24500, kind: 'money' }), true);
  assert.equal(isFilled({ label: 'x', value: 0, kind: 'money' }), false);
  assert.equal(isFilled({ label: 'x', value: -1, kind: 'money' }), false);
  assert.equal(isFilled({ label: 'x', value: '', kind: 'money' }), false);
});

test('★ any：0 與 false 算「有填」', () => {
  // 折讓數量、勾選框這種欄位,0 跟 false 是合法的答案。
  // 跟金額混用同一套判斷的話,「填 0」會被當成沒填
  assert.equal(isFilled({ label: 'x', value: 0, kind: 'any' }), true);
  assert.equal(isFilled({ label: 'x', value: false, kind: 'any' }), true);
  assert.equal(isFilled({ label: 'x', value: null, kind: 'any' }), false);
  assert.equal(isFilled({ label: 'x', value: '', kind: 'any' }), false);
});

test('缺的全部列出來,順序照傳進來的', () => {
  const miss = missingFields([
    { label: '日期', value: '' },
    { label: '項目', value: '水費' },
    { label: '金額', value: 0, kind: 'money' },
  ]);
  assert.deepEqual(miss, ['日期', '金額']);
});

test('★ when 為 false 的欄位不檢查', () => {
  // 條件式必填:匯款才需要帳號,現金付款不需要。
  // 沒有這個開關的話,現金那條路會被一個填不了的欄位卡死
  assert.deepEqual(missingFields([
    { label: '收款帳號', value: '', when: false },
  ]), []);
  assert.deepEqual(missingFields([
    { label: '收款帳號', value: '', when: true },
  ]), ['收款帳號']);
});

test('when 沒給就是要檢查', () => {
  assert.deepEqual(missingFields([{ label: 'a', value: '' }]), ['a']);
});

test('★ 訊息開頭要有「無法」,否則會被當成成功訊息', () => {
  // 各頁的 flash() 靠內容判斷紅綠（/失敗|錯誤|不能|無法/）。
  // 少了那幾個字,這句會用綠色顯示兩秒半就消失 —— 看起來像存成功了
  const m = missingMessage(['物業', '房客']);
  assert.match(m, /無法/);
  assert.match(m, /物業、房客/);
});

// ── 送出鈕的閘門（2026-09-10 David 指定）────────────────────

describe('★★★ submitGate —— 灰掉但按得下去', () => {
  test('填齊了就不擋、不灰、沒有提示', () => {
    const g = submitGate([]);
    assert.equal(g.blocked, false);
    assert.equal(g.dim, false);
    assert.equal(g.title, '');
  });

  test('★★★ 缺欄位時 title 要講出是哪幾欄', () => {
    /*
     * 「請填寫必填欄位」等於沒說 —— 十幾個欄位裡是哪一格還是要自己找。
     * 一顆灰掉而不解釋的按鈕，使用者的結論是「系統壞了」。
     */
    const g = submitGate(['支出日期', '金額']);
    assert.equal(g.blocked, true);
    assert.equal(g.dim, true);
    assert.match(g.title, /支出日期/);
    assert.match(g.title, /金額/);
  });

  test('★★ 存檔中也擋，但理由不一樣', () => {
    // 兩個都灰、理由不同 —— 說出來的話就要不同
    const g = submitGate([], true);
    assert.equal(g.blocked, true);
    assert.match(g.title, /儲存中/);
    assert.doesNotMatch(g.title, /還沒填/);
  });

  test('★ 存檔中優先於缺欄位', () => {
    // 已經在存了就不該再講「還沒填」—— 那時候顯然填齊了
    assert.match(submitGate(['金額'], true).title, /儲存中/);
  });

  test('gateCls 不可以用 disabled: 開頭的 class', () => {
    /*
     * ★★★ 這一條釘的是整個設計:按鈕**刻意沒有 disabled 屬性**
     *   （有的話就按不下去、tried 打不開、紅框永遠不出現）。
     *   `disabled:opacity-40` 那種寫法在這裡完全不會生效，
     *   而畫面上看起來只是「灰色沒套上」，沒有任何東西會叫。
     */
    assert.doesNotMatch(gateCls(true), /disabled:/);
    assert.match(gateCls(true), /opacity-40/);
    assert.equal(gateCls(false), '');
  });
});
