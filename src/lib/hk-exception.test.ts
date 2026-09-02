import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  isDismissed, reparsePreview, visibleRows, dismissedCount,
  prefillFromEvent, canDismiss, reasonOf, exceptionEvents, type ExEvent,
} from './hk-exception.ts';

const E = (o: Partial<ExEvent> = {}): ExEvent => ({
  id: 'e1', event_date: '2026-08-03', title: '退-J1-Chung Hoon',
  assignees: ['Una'], parsed_code: null, work_type: '清潔', excluded: null, ...o,
});

/** 現在的別名表：J1→JPR1F、J2→JPR2F、台S→台4 */
const match = (title: string): string | null => {
  if (title.includes('J1')) return 'JPR1F';
  if (title.includes('J2')) return 'JPR2F';
  if (title.includes('台S')) return '台4';
  return null;
};

describe('reparsePreview —— 只給有改變的', () => {
  test('本來對不到、現在對得到 → 進預覽', () => {
    const out = reparsePreview([E()], match);
    assert.equal(out.length, 1);
    assert.equal(out[0].code, 'JPR1F');
  });

  /*
   * ★★★ 全部回傳的話，使用者要在一堆「還是 null」裡面找出有意義的那幾筆 ——
   *   而預覽的價值就是「只給我要看的」。
   */
  test('現在還是對不到 → 不出現', () => {
    assert.deepEqual(reparsePreview([E({ title: '聚餐' })], match), []);
    assert.deepEqual(reparsePreview([E({ title: '正隆' })], match), []);
    assert.deepEqual(reparsePreview([E({ title: '時兆三四樓洗衣機間和公區窗戶' })], match), []);
  });

  test('本來就對到了 → 不動它', () => {
    assert.deepEqual(reparsePreview([E({ parsed_code: 'A07' })], match), []);
  });

  test('休假／未指派不是房源問題 → 不碰', () => {
    assert.deepEqual(reparsePreview([E({ excluded: 'leave' })], match), []);
    assert.deepEqual(reparsePreview([E({ excluded: 'no_assignee' })], match), []);
  });

  /*
   * ★★ 按掉是人的決定（「這不是清掃」）。
   *   系統不該因為後來多了一個別名就把它翻案 —— 要翻案請先還原。
   */
  test('★★ 已經按掉的不重新解析', () => {
    assert.deepEqual(reparsePreview([E({ dismissed_at: '2026-09-01' })], match), []);
  });

  test('八筆真實資料：五筆可對上', () => {
    const rows = [
      '退-J1-Chung Hoon', '退-台S-Lance', '退-J2-Judy(8/3)', '聚餐',
      '正隆', '時兆三四樓洗衣機間和公區窗戶', '退-J2-Denys', '退-台S-律德',
    ].map((t, i) => E({ id: `e${i}`, title: t }));
    const out = reparsePreview(rows, match);
    assert.equal(out.length, 5);
    assert.deepEqual(out.map((r) => r.code), ['JPR1F', '台4', 'JPR2F', 'JPR2F', '台4']);
  });

  test('空清單不會爆', () => assert.deepEqual(reparsePreview([], match), []));
});

describe('按掉與顯示', () => {
  const rows = [E({ id: 'a' }), E({ id: 'b', dismissed_at: '2026-09-01' })];

  test('預設藏起已按掉的', () => {
    assert.deepEqual(visibleRows(rows, false).map((r) => r.id), ['a']);
  });
  test('打開就看得到', () => {
    assert.deepEqual(visibleRows(rows, true).map((r) => r.id), ['a', 'b']);
  });
  test('筆數', () => assert.equal(dismissedCount(rows), 1));

  test('isDismissed 只看有沒有時間', () => {
    assert.equal(isDismissed(E()), false);
    assert.equal(isDismissed(E({ dismissed_at: null })), false);
    assert.equal(isDismissed(E({ dismissed_at: '2026-09-01' })), true);
  });
});

describe('prefillFromEvent —— 日期與人員照抄，房源留空', () => {
  const byName = (n: string) => ({ Una: 's-una', 庭玉: 's-ting' } as Record<string, string>)[n] ?? null;

  test('帶入日期、類型、人員', () => {
    const p = prefillFromEvent(E({ assignees: ['Una', '庭玉'], work_type: '加強清潔' }), byName);
    assert.equal(p.date, '2026-08-03');
    assert.equal(p.type, '加強清潔');
    assert.deepEqual(p.staffIds, ['s-una', 's-ting']);
  });

  /*
   * ★★★ 房源留空是刻意的。標題裡抽不出房源正是這一筆在例外清單的原因 ——
   *   猜一個填進去，使用者沒注意就按加入，那筆清掃會算到錯的房源頭上。
   */
  test('★★★ 房源一律留空，不猜', () => {
    assert.equal(prefillFromEvent(E({ title: '退-J1-Chung Hoon' }), byName).code, '');
  });

  test('對不到的人名跳過，不硬塞', () => {
    assert.deepEqual(prefillFromEvent(E({ assignees: ['Una', '不認識的人'] }), byName).staffIds, ['s-una']);
  });

  test('同一個人出現兩次只算一次', () => {
    assert.deepEqual(prefillFromEvent(E({ assignees: ['Una', 'Una'] }), byName).staffIds, ['s-una']);
  });

  test('沒有負責人也不會爆', () => {
    assert.deepEqual(prefillFromEvent(E({ assignees: [] }), byName).staffIds, []);
  });

  test('沒有工作類型時預設清潔', () => {
    assert.equal(prefillFromEvent(E({ work_type: null }), byName).type, '清潔');
  });
});

describe('canDismiss —— 只有事件能按掉', () => {
  test('事件可以', () => assert.equal(canDismiss(E()), true));

  /*
   * ★★ 「尚未建檔幾床」那一區列的是**房源字串**，不是事件。
   *   它的解法是去把床數填上 —— 按掉只會讓少算的床單消失在視線外，
   *   而床單總數依然是錯的。
   */
  test('★★ 房源字串不行', () => assert.equal(canDismiss('開2-1'), false));
});

describe('reasonOf ／ exceptionEvents', () => {
  test('人員對不到', () => {
    assert.equal(reasonOf(E({ excluded: 'no_assignee' })), '人員對不到');
  });
  test('房源沒對到', () => assert.equal(reasonOf(E()), '房源沒對到'));

  // ★ 原因寫在每一列上，同一天的兩筆才會排在一起 —— 使用者是照日期找的
  test('兩種原因可以出現在同一份清單裡', () => {
    const rows = [E({ id: 'a', excluded: 'no_assignee' }), E({ id: 'b' })];
    const out = exceptionEvents(rows);
    assert.deepEqual(out.map(reasonOf), ['人員對不到', '房源沒對到']);
  });

  test('已經對到房源的不算例外', () => {
    assert.deepEqual(exceptionEvents([E({ parsed_code: 'A07' })]), []);
  });
  test('休假不算例外', () => {
    assert.deepEqual(exceptionEvents([E({ excluded: 'leave' })]), []);
  });

  // ★ 那兩種本來就不是房源工作 —— 不是例外，是常態
  test('協助行政／洗烘折毛巾不列', () => {
    assert.deepEqual(exceptionEvents([E({ title: '協助行政' }), E({ title: '洗烘折毛巾' })]), []);
  });
});
