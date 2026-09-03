import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  splitJobKey, splitLineJobKey, splitExpenseKey, isSplitKey, splitIdOf,
  indexSplits, splitTotal, splitError, hasSplit, orphanSplitKeys,
  type SplitLine,
} from './work-split.ts';

const line = (o: Partial<SplitLine> = {}): SplitLine => ({
  id: 'aaa', work_date: '2026-08-14', job_code: '正隆多間',
  work_type: '清潔', property_id: 'p1', amount: 1500, ...o,
});

describe('splitJobKey —— 拆帳對到哪一份工（2026-09-03）', () => {
  /*
   * ★★★ 這個鍵必須跟 `estateLog` 合併的依據一致。
   *   不一致的話拆帳對不到那份工，而畫面上只是「拆了但沒有效果」——
   *   沒有錯誤訊息，因為兩邊各自都是對的。
   */
  test('★★★ 從 LogEntry 與從 SplitLine 算出來要一樣', () => {
    const fromJob = splitJobKey({ work_date: '2026-08-14', label: '正隆多間', work_type: '清潔' });
    const fromLine = splitLineJobKey(line());
    assert.equal(fromJob, fromLine);
  });

  // ★ 會需要拆帳的那些工正是沒有 property_id 的 —— 所以鍵用代碼字樣
  test('★ 沒有房源也組得出鍵', () => {
    assert.equal(
      splitJobKey({ work_date: '2026-08-14', label: null, work_type: '清潔' }),
      '2026-08-14||清潔',
    );
  });

  test('工作類型不同就是不同份工', () => {
    const a = splitJobKey({ work_date: '2026-08-14', label: '4B3', work_type: '清潔' });
    const b = splitJobKey({ work_date: '2026-08-14', label: '4B3', work_type: '退房' });
    assert.notEqual(a, b);
  });
});

describe('splitExpenseKey —— 冪等鍵不能跟一般工單撞（2026-09-03）', () => {
  /*
   * ★★★ 一般工單的鍵是「日期│房源id│工作類型」。
   *   拆帳照抄的話，同一天同一間如果另有一份正常工單就會組出同一個鍵，
   *   而 hk_job_key 有唯一索引 —— 第二筆被安靜地跳過，帳少一筆。
   */
  test('★★★ 加了前綴，不可能跟「日期|房源|類型」長得一樣', () => {
    const k = splitExpenseKey('9f0c-uuid');
    assert.equal(k, 'split:9f0c-uuid');
    assert.equal(isSplitKey(k), true);
    assert.equal(isSplitKey('2026-08-14|p1|清潔'), false);
  });

  test('取得回 id —— 孤兒偵測要用', () => {
    assert.equal(splitIdOf('split:9f0c'), '9f0c');
    assert.equal(splitIdOf('2026-08-14|p1|清潔'), null);
  });

  test('null 與空字串不會爆', () => {
    assert.equal(isSplitKey(null), false);
    assert.equal(isSplitKey(undefined), false);
    assert.equal(isSplitKey(''), false);
  });
});

describe('indexSplits / splitTotal（2026-09-03）', () => {
  test('照工分組', () => {
    const m = indexSplits([
      line({ id: 'a', property_id: 'p1' }),
      line({ id: 'b', property_id: 'p2' }),
      line({ id: 'c', work_date: '2026-08-20', job_code: '4B3', property_id: 'p3' }),
    ]);
    assert.equal(m.size, 2);
    assert.equal(m.get('2026-08-14|正隆多間|清潔')!.length, 2);
  });

  test('空清單回空 Map', () => {
    assert.equal(indexSplits([]).size, 0);
  });

  // ★ 這個數字是畫面上唯一能判斷「拆對了沒」的依據
  test('合計 —— 三筆 1,500 是 4,500', () => {
    assert.equal(splitTotal([line(), line(), line()]), 4500);
  });

  test('空的合計是 0，不是 NaN', () => {
    assert.equal(splitTotal([]), 0);
  });
});

describe('splitError —— 存之前先講人話（2026-09-03）', () => {
  const ok = [
    { property_id: 'p1', amount: 1500 },
    { property_id: 'p2', amount: 1500 },
    { property_id: 'p3', amount: 1500 },
  ];

  test('三間各 1,500 是合法的', () => {
    assert.equal(splitError(ok), null);
  });

  /*
   * ★★★ 資料庫有唯一索引擋著，但撞上去的訊息是
   *   `duplicate key value violates unique constraint` ——
   *   使用者看到那句只會覺得系統壞了。
   */
  test('★★★ 同一間出現兩次要擋，而且講人話', () => {
    const e = splitError([{ property_id: 'p1', amount: 1 }, { property_id: 'p1', amount: 2 }]);
    assert.match(e!, /只能出現一次/);
  });

  test('沒選房源要擋 —— 拆帳的整個重點就是記到哪一間', () => {
    assert.match(splitError([{ property_id: null, amount: 1500 }])!, /選房源/);
  });

  test('金額留空要擋', () => {
    assert.match(splitError([{ property_id: 'p1', amount: null }])!, /填金額/);
  });

  test('負數要擋', () => {
    assert.match(splitError([{ property_id: 'p1', amount: -1 }])!, /0 以上/);
  });

  // ★ 0 是合法的:那一間這次不用錢，但要留在拆帳上讓人看得到
  test('★ 金額 0 是合法的', () => {
    assert.equal(splitError([{ property_id: 'p1', amount: 0 }]), null);
  });

  test('一列都沒有要擋', () => {
    assert.match(splitError([])!, /至少/);
  });

  /*
   * ★ 不檢查合計。正隆多間沒有單價可查（不在房源主檔），
   *   所以沒有一個「應該是多少」可以比對（使用者決定不擋）。
   */
  test('★ 合計多少都收 —— 沒有基準可比', () => {
    assert.equal(splitError([{ property_id: 'p1', amount: 999999 }]), null);
  });
});

describe('hasSplit（2026-09-03）', () => {
  test('有列就是拆過的', () => {
    assert.equal(hasSplit([line()]), true);
    assert.equal(hasSplit([]), false);
    assert.equal(hasSplit(undefined), false);
    assert.equal(hasSplit(null), false);
  });
});

describe('orphanSplitKeys —— 拆帳刪了但支出還在（2026-09-03）', () => {
  /*
   * ★★ 支出不會跟著刪 —— 錢付了就是付了。所以要列出來讓人決定，
   *   不是自動處理（CLAUDE.md:「建議，不自動」）。
   */
  test('★★ 拆帳列不見了，那筆支出是孤兒', () => {
    const alive = [line({ id: 'a' })];
    const keys = ['split:a', 'split:b', '2026-08-14|p1|清潔'];
    assert.deepEqual(orphanSplitKeys(keys, alive), ['split:b']);
  });

  test('一般工單的鍵不算孤兒 —— 它們不歸這裡管', () => {
    assert.deepEqual(orphanSplitKeys(['2026-08-14|p1|清潔', '202608|est1'], []), []);
  });

  test('null 與空清單不會爆', () => {
    assert.deepEqual(orphanSplitKeys([null, undefined], []), []);
  });

  test('全部都還在就沒有孤兒', () => {
    const alive = [line({ id: 'a' }), line({ id: 'b' })];
    assert.deepEqual(orphanSplitKeys(['split:a', 'split:b'], alive), []);
  });
});
