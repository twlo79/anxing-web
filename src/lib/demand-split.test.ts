import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  splitDraft, parseSplitLines, planSplit, splitBlockedReason,
  inheritedFields, SPLIT_INHERITED, SPLIT_MAX,
} from './demand-split.ts';

/**
 * 手動拆開需求項目。
 *
 * ============================================================
 * 【這支在防什麼】
 *
 * 拆錯**不會報錯**,三種錯法都是安靜的:
 *
 *   ① 已請款的被拆   → 多出來的列變成「沒有請款單卻寫著已請款」的孤兒
 *   ② 狀態沒跟著抄   → 已採購的單拆完變成「還有 2 項待採購」,東西其實買了
 *   ③ 第一列被重建   → id 換掉,稽核歷史與已填的採購資訊一起消失
 *
 * 底下每一條各釘一個。
 */

describe('splitDraft —— 猜一個起點', () => {
  test('★ 使用者那一列拆成三項', () => {
    assert.equal(
      splitDraft('衛生紙*1箱 除霉劑*12瓶 洗衣精*2瓶'),
      '衛生紙*1箱\n除霉劑*12瓶\n洗衣精*2瓶');
  });

  test('★★ 全形空白也要切', () => {
    // 中文輸入法打出來的空白是全形,畫面上跟半形長得一模一樣 ——
    // 不切的話使用者會看到「明明有空白卻沒拆開」而不知道為什麼
    assert.equal(splitDraft('衛生紙*1箱　除霉劑*12瓶'), '衛生紙*1箱\n除霉劑*12瓶');
  });

  test('連續空白、前後空白都不會生出空行', () => {
    assert.equal(splitDraft('  a   b  '), 'a\nb');
  });

  test('本來就只有一項就維持一行', () => {
    assert.equal(splitDraft('衛生紙*1箱'), '衛生紙*1箱');
  });

  test('空字串不會爆', () => {
    assert.equal(splitDraft(''), '');
  });
});

describe('parseSplitLines —— 讀框裡的內容', () => {
  test('★★ 行內的空白要留著', () => {
    // 人在框裡自己排好的「衛生紙 大包裝 *1箱」就是他要的那一列,
    // 再切一次的話,他改了半天的東西會被推翻
    assert.deepEqual(
      parseSplitLines('衛生紙 大包裝 *1箱\n除霉劑*12瓶'),
      ['衛生紙 大包裝 *1箱', '除霉劑*12瓶']);
  });

  test('空行與只有空白的行都丟掉', () => {
    assert.deepEqual(parseSplitLines('a\n\n   \nb\n'), ['a', 'b']);
  });

  test('Windows 換行也要吃', () => {
    assert.deepEqual(parseSplitLines('a\r\nb'), ['a', 'b']);
  });
});

describe('planSplit —— 算出要怎麼寫', () => {
  test('★★★ 第一行留給原本那一列，其餘才是新增', () => {
    const r = planSplit('衛生紙*1箱\n除霉劑*12瓶\n洗衣精*2瓶');
    assert.ok('plan' in r);
    // 第一列是 update 不是重建 —— id 一換,稽核歷史與已填的採購資訊全斷
    assert.equal(r.plan.keep, '衛生紙*1箱');
    assert.deepEqual(r.plan.add, ['除霉劑*12瓶', '洗衣精*2瓶']);
  });

  test('★ 只有一行是合法的 —— 那是改名', () => {
    // 這個框是全站唯一能改品名的地方。擋掉的話,
    // 品名打錯字的人又沒有路可以改了
    const r = planSplit('衛生紙*1箱');
    assert.ok('plan' in r);
    assert.equal(r.plan.keep, '衛生紙*1箱');
    assert.deepEqual(r.plan.add, []);
  });

  test('★ 全空白要擋 —— 不然這一項會沒有品名', () => {
    assert.ok('error' in planSplit('   \n  \n'));
  });

  test(`★ 超過 ${SPLIT_MAX} 列要擋（防手滑貼整份 Excel）`, () => {
    const many = Array.from({ length: SPLIT_MAX + 1 }, (_, i) => `第${i}項`).join('\n');
    const r = planSplit(many);
    assert.ok('error' in r);
    assert.match(r.error, /最多/);
  });

  test(`剛好 ${SPLIT_MAX} 列可以過`, () => {
    const ok = Array.from({ length: SPLIT_MAX }, (_, i) => `第${i}項`).join('\n');
    assert.ok('plan' in planSplit(ok));
  });
});

describe('★★★ splitBlockedReason —— 不能拆的要在按下去之前擋', () => {
  test('★★★ 已經被請款單領走的不給拆', () => {
    /*
     * 請款項目與需求項目是一對一。拆成三列之後那張請款單只認得原本那一列,
     * 另外兩列變成「沒有人在買、但寫著已請款」的孤兒 ——
     * 而畫面上它們看起來完全正常,不會有任何地方叫。
     */
    const r = splitBlockedReason({
      item_name: 'a', status: 'requested',
      request_item_id: 'ri-1', request_no: 'PR-202609-003',
    });
    assert.ok(r);
    assert.match(r, /PR-202609-003/);   // 訊息要講是哪一張,不然人不知道去哪退
  });

  test('狀態是已請款、但沒有請款關聯（孤兒）也要擋', () => {
    const r = splitBlockedReason({ item_name: 'a', status: 'requested' });
    assert.ok(r);
  });

  test('已取消的不給拆', () => {
    assert.ok(splitBlockedReason({ item_name: 'a', status: 'cancelled' }));
  });

  test('★★ 已採購（done）可以拆 —— 使用者要拆的正是這一種', () => {
    // 東西買回來了才發現當初三樣打成一列,那時候才想分開記
    assert.equal(splitBlockedReason({ item_name: 'a', status: 'done' }), null);
  });

  test('待採購與已詢價都可以拆', () => {
    assert.equal(splitBlockedReason({ item_name: 'a', status: 'pending' }), null);
    assert.equal(splitBlockedReason({ item_name: 'a', status: 'quoted' }), null);
  });
});

describe('★★ 新增的那幾列要照抄原本的欄位', () => {
  const src = {
    demand_id: 'd-1', item_name: '衛生紙*1箱 除霉劑*12瓶',
    spec: '大包裝', qty: '3 箱', purpose_type: 'estate', estate_id: 'e-1',
    buy_link: 'https://x', status: 'done',
    platform: '蝦皮', eta: '2026-09-10', purchased_on: '2026-09-04',
    request_item_id: null,
  };

  test('★★★ 狀態一定要跟著抄', () => {
    /*
     * 使用者要拆的那張是「已採購」。新增的兩列若回到「待採購」,
     * 那張單會從「全部採購完」變成「2 項待採購」——
     * 明明東西早就買回來了,而會計會照著那個數字再買一次。
     */
    const got = inheritedFields(src, SPLIT_INHERITED);
    assert.equal(got.status, 'done');
  });

  test('物業、規格、平台、兩個日期都要帶過去', () => {
    const got = inheritedFields(src, SPLIT_INHERITED);
    assert.equal(got.demand_id, 'd-1');
    assert.equal(got.spec, '大包裝');
    /*
     * ★★★ 2026-09-10 新增的 qty。漏抄的話拆出來那幾列數量是空的 ——
     *   **不會報錯**，看起來像使用者當初沒填。
     */
    assert.equal(got.qty, '3 箱');
    assert.equal(got.purpose_type, 'estate');
    assert.equal(got.estate_id, 'e-1');
    assert.equal(got.buy_link, 'https://x');
    assert.equal(got.platform, '蝦皮');
    assert.equal(got.eta, '2026-09-10');
    assert.equal(got.purchased_on, '2026-09-04');
  });

  test('★ 品名不可以抄 —— 抄了就等於沒拆', () => {
    const got = inheritedFields(src, SPLIT_INHERITED) as Record<string, unknown>;
    assert.equal('item_name' in got, false);
  });

  test('★ request_item_id 不可以抄 —— 兩列指同一張請款項目就對不起來了', () => {
    const got = inheritedFields(src, SPLIT_INHERITED) as Record<string, unknown>;
    assert.equal('request_item_id' in got, false);
  });
});

describe('★ 從頭到尾走一次', () => {
  test('使用者那一列 → 三列，狀態全部維持已採購', () => {
    const item = {
      demand_id: 'd-1', item_name: '衛生紙*1箱 除霉劑*12瓶 洗衣精*2瓶',
      spec: '', qty: '', purpose_type: 'estate', estate_id: 'e-1', buy_link: '',
      status: 'done', platform: '蝦皮', eta: null, purchased_on: '2026-09-04',
      request_item_id: null,
    };
    assert.equal(splitBlockedReason(item), null);

    const r = planSplit(splitDraft(item.item_name));
    assert.ok('plan' in r);
    assert.equal(r.plan.keep, '衛生紙*1箱');
    assert.deepEqual(r.plan.add, ['除霉劑*12瓶', '洗衣精*2瓶']);

    const rows = r.plan.add.map((name) => ({
      ...inheritedFields(item, SPLIT_INHERITED), item_name: name,
    }));
    assert.equal(rows.length, 2);
    assert.ok(rows.every((x) => x.status === 'done'));
    assert.ok(rows.every((x) => x.purchased_on === '2026-09-04'));
    assert.deepEqual(rows.map((x) => x.item_name), ['除霉劑*12瓶', '洗衣精*2瓶']);
  });
});
