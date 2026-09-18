import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  SRC_FEE_PREFIX, ONEOFF_FEE_SOURCES, feeSourceValue, feeSourceOf,
  sourceMatches, sourceFilterLabel, isAnxingRevenue, NON_ANXING_SOURCES,
} from './revenue-source.ts';

/** 營收頁下拉裡那八個真的 source 值（revenues/page.tsx 的 SOURCE_ORDER）。 */
const REAL_SOURCES = [
  'airbnb', 'agoda', 'private', 'longterm', 'office', 'company', 'oneoff', 'other',
];

const row = (source: string, fee_type: string | null = null) => ({ source, fee_type });

describe('★★★ 前綴不可以撞到真的 source', () => {
  test('八個真的來源沒有一個以 `fee:` 開頭', () => {
    for (const s of REAL_SOURCES) {
      assert.equal(s.startsWith(SRC_FEE_PREFIX), false, s);
      assert.equal(feeSourceOf(s), null, s);
    }
  });

  test('★★ 撞到的話會篩出別的東西 —— 這裡直接釘住反向', () => {
    for (const s of REAL_SOURCES) {
      /* 真的來源走的是 source 比對，不是科目比對 */
      assert.equal(sourceMatches(s, row(s)), true, s);
      assert.equal(sourceMatches(s, row('別的來源')), false, s);
    }
  });
});

describe('房務清潔 / 人事費', () => {
  const clean = feeSourceValue('房務清潔');
  const labor = feeSourceValue('人事費');

  test('選了房務清潔,只留下 oneoff ＋ 房務清潔', () => {
    assert.equal(sourceMatches(clean, row('oneoff', '房務清潔')), true);
    assert.equal(sourceMatches(clean, row('oneoff', '人事費')), false);
    assert.equal(sourceMatches(clean, row('oneoff', '管理費')), false);
    assert.equal(sourceMatches(clean, row('oneoff', null)), false);
  });

  test('選了人事費也一樣', () => {
    assert.equal(sourceMatches(labor, row('oneoff', '人事費')), true);
    assert.equal(sourceMatches(labor, row('oneoff', '房務清潔')), false);
  });

  test('★★ 科目對但來源不是其他收入 → 不留', () => {
    /*
     * 將來別的來源也用了「房務清潔」這個科目的話,
     * 它不該混進這一項 —— 這一項在畫面上掛在「其他收入」底下。
     */
    assert.equal(sourceMatches(clean, row('longterm', '房務清潔')), false);
    assert.equal(sourceMatches(clean, row('private', '房務清潔')), false);
  });

  test('★★★ 選「其他收入」時,房務那幾筆**還是要在**', () => {
    /*
     * 多這兩項是「再切細一層」,不是把它們從其他收入裡搬走。
     * 搬走的話總額會對不上,而畫面上看不出來少了什麼。
     */
    assert.equal(sourceMatches('oneoff', row('oneoff', '房務清潔')), true);
    assert.equal(sourceMatches('oneoff', row('oneoff', '人事費')), true);
    assert.equal(sourceMatches('oneoff', row('oneoff', '管理費')), true);
  });

  test('沒篩 → 全部都留', () => {
    assert.equal(sourceMatches('', row('oneoff', '房務清潔')), true);
    assert.equal(sourceMatches(null, row('airbnb')), true);
    assert.equal(sourceMatches(undefined, row('airbnb')), true);
  });

  test('缺欄位不會爆', () => {
    assert.equal(sourceMatches(clean, {}), false);
    assert.equal(sourceMatches('airbnb', {}), false);
    assert.equal(sourceMatches('', {}), true);
  });
});

describe('值與標籤', () => {
  test('來回轉得回去', () => {
    for (const f of ONEOFF_FEE_SOURCES) {
      assert.equal(feeSourceOf(feeSourceValue(f)), f);
    }
  });

  test('標籤:科目型印科目,真的來源印它的中文', () => {
    const label = (s: string) => ({ airbnb: 'Airbnb', oneoff: '其他收入' } as Record<string, string>)[s] ?? '';
    assert.equal(sourceFilterLabel(feeSourceValue('房務清潔'), label), '房務清潔');
    assert.equal(sourceFilterLabel('airbnb', label), 'Airbnb');
    assert.equal(sourceFilterLabel('oneoff', label), '其他收入');
    assert.equal(sourceFilterLabel('', label), '');
    /* ★ 對照表漏掉的鍵印原值,不要印空白（不然畫面上是一個沒有字的籤）*/
    assert.equal(sourceFilterLabel('沒見過的', label), '沒見過的');
  });

  test('★ 清單裡兩個科目都在,而且沒有重複', () => {
    assert.deepEqual([...ONEOFF_FEE_SOURCES], ['房務清潔', '人事費']);
    assert.equal(new Set(ONEOFF_FEE_SOURCES).size, ONEOFF_FEE_SOURCES.length);
  });
});

describe('★★★ 營收表只算安幸', () => {
  test('兩種「其他事業體」的來源都擋掉', () => {
    /*
     * ★ 程式碼裡 OTHER_BIZ_SOURCE 有兩個值（'other' / 'other_biz'）,
     *   漏掉哪一個都會讓非安幸的錢留在總額裡而且不會叫。
     */
    for (const s of NON_ANXING_SOURCES) {
      assert.equal(isAnxingRevenue({ source: s }), false, s);
    }
  });

  test('安幸自己的八種來源都要留著', () => {
    for (const s of ['airbnb', 'agoda', 'private', 'longterm',
                     'office', 'company', 'oneoff', 'partner', 'airbnb_cancelled']) {
      assert.equal(isAnxingRevenue({ source: s }), true, s);
    }
  });

  test('★★ 帳本是愛皮／洪鯊也擋', () => {
    assert.equal(isAnxingRevenue({ source: 'oneoff', book: 'aipi' }), false);
    assert.equal(isAnxingRevenue({ source: 'oneoff', book: 'hongsha' }), false);
  });

  test('★★★ 沒有 book 這一欄、或值怪掉 → 當安幸留著', () => {
    /*
     * 營收的列是從認列的 view 出來的,不一定帶 book。
     * 缺值就丟掉的話,整張表會少掉一批而畫面上看不出來
     *（book.ts:不要讓一筆錢因為值怪掉就從所有報表上消失）。
     */
    assert.equal(isAnxingRevenue({ source: 'airbnb' }), true);
    assert.equal(isAnxingRevenue({ source: 'airbnb', book: null }), true);
    assert.equal(isAnxingRevenue({ source: 'airbnb', book: '' }), true);
    assert.equal(isAnxingRevenue({ source: 'airbnb', book: '沒見過的' }), true);
  });

  test('空的來源也留著（不明的不丟）', () => {
    assert.equal(isAnxingRevenue({}), true);
    assert.equal(isAnxingRevenue({ source: null }), true);
  });
});
