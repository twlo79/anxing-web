import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { filterTxns, hasFilter, sumRows, amountOf, splitTail, splitRef, type BankRow } from './bank-filter.ts';

/**
 * 流水篩選的測試。
 *
 * 篩錯**不會報錯**，只會「查出來比預期少」——
 * 而人只會覺得「那筆好像不見了」，不會想到是條件寫錯。
 */

const r = (o: Partial<BankRow> = {}): BankRow => ({
  post_date: '2026-07-03', description: 'ＡＴＭ轉', counterparty: '國泰世華',
  memo: '', ref_no: '', balance_note: null, debit: 0, credit: 46_000, ...o,
});

const ROWS: BankRow[] = [
  r({ post_date: '2026-07-01', credit: 10_000, memo: '１２月房租' }),
  r({ post_date: '2026-07-15', debit: 46_000, credit: 0, counterparty: '中國信託', memo: '押金' }),
  r({ post_date: '2026-07-31', credit: 100_000, ref_no: '012-0000341168247682' }),
  r({ post_date: '2026-08-05', debit: 806, credit: 0, balance_note: 'PDF 上印 3,976,587，差 806' }),
];

describe('日期', () => {
  test('★★ 起訖都含端點', () => {
    // 不含的話，「7/1 起」會漏掉 7/1 那幾筆 —— 而那正是人最想看的那天
    assert.equal(filterTxns(ROWS, { from: '2026-07-01' }).length, 4);
    assert.equal(filterTxns(ROWS, { to: '2026-07-31' }).length, 3);
    assert.equal(filterTxns(ROWS, { from: '2026-07-15', to: '2026-07-15' }).length, 1);
  });

  test('★★ 日期用字串比，不要轉 Date', () => {
    // new Date('2026-07-01') 是 UTC 午夜 → 台灣時間變成前一天早上八點,
    // 篩「7/1 起」就會少掉 7/1。這一條釘住不能改成 Date 比較。
    const withTime = [r({ post_date: '2026-07-01T00:00:00+08:00' })];
    assert.equal(filterTxns(withTime, { from: '2026-07-01', to: '2026-07-01' }).length, 1);
  });
});

describe('方向', () => {
  test('只看支出／只看存入', () => {
    assert.equal(filterTxns(ROWS, { dir: 'debit' }).length, 2);
    assert.equal(filterTxns(ROWS, { dir: 'credit' }).length, 2);
    assert.equal(filterTxns(ROWS, { dir: '' }).length, 4);
  });
});

describe('金額', () => {
  test('★★ 上下限含端點', () => {
    // 「10,000 以上」不含 10,000 的話,人會以為那筆不見了
    assert.equal(filterTxns(ROWS, { min: 10_000 }).length, 3);
    assert.equal(filterTxns(ROWS, { max: 10_000 }).length, 2); // 10,000 與 806
  });

  test('★ 比的是這一筆的金額，支出存入都算', () => {
    // 只比 credit 的話,支出那幾筆會被當成 0 而永遠落在下限之外
    assert.equal(amountOf(r({ debit: 46_000, credit: 0 })), 46_000);
    assert.equal(filterTxns(ROWS, { min: 46_000, max: 46_000 }).length, 1);
  });

  test('空字串不算條件', () => {
    // 輸入框清空之後是 ''，不可以當成 0 —— 那會把所有東西都篩掉或都留下
    assert.equal(filterTxns(ROWS, { min: '', max: '' }).length, 4);
  });
});

describe('關鍵字', () => {
  test('★★ 摘要、說明、對方、票據號碼、餘額備註都要找得到', () => {
    // 漏掉一個的症狀是「畫面上明明看得到,搜卻搜不到」
    assert.equal(filterTxns(ROWS, { q: '房租' }).length, 1);      // 摘要
    assert.equal(filterTxns(ROWS, { q: 'ＡＴＭ' }).length, 4);     // 說明
    assert.equal(filterTxns(ROWS, { q: '中國信託' }).length, 1);   // 對方
    assert.equal(filterTxns(ROWS, { q: '0000341168' }).length, 1); // 票據號碼
    assert.equal(filterTxns(ROWS, { q: '3,976,587' }).length, 1);  // 餘額備註
  });

  test('★ 金額也搜得到，打不打逗號都行', () => {
    assert.equal(filterTxns(ROWS, { q: '46000' }).length, 1);
    assert.equal(filterTxns(ROWS, { q: '46,000' }).length, 1);
  });

  test('日期也搜得到', () => {
    assert.equal(filterTxns(ROWS, { q: '2026-07-15' }).length, 1);
  });

  test('前後空白不算', () => {
    assert.equal(filterTxns(ROWS, { q: '  ' }).length, 4);
  });
});

describe('只看有餘額備註的', () => {
  test('★ 銀行印錯的那幾筆要找得出來', () => {
    // 那是一年可能只出現一次的東西 —— 沒有篩選就只能一頁一頁翻
    const p = filterTxns(ROWS, { onlyNoted: true });
    assert.equal(p.length, 1);
    assert.match(p[0].balance_note!, /806/);
  });
});

describe('條件疊加', () => {
  test('★ 多個條件是「而且」不是「或者」', () => {
    assert.equal(filterTxns(ROWS, { dir: 'debit', min: 1_000 }).length, 1);
    assert.equal(filterTxns(ROWS, { from: '2026-07-01', to: '2026-07-31', dir: 'credit' }).length, 2);
  });

  test('沒有任何條件就全部留下', () => {
    assert.equal(filterTxns(ROWS, {}).length, 4);
  });
});

describe('有沒有在篩', () => {
  test('★ 收合時要看得出來正在篩 —— 不然「為什麼只有 3 筆」查不到原因', () => {
    assert.equal(hasFilter({}), false);
    assert.equal(hasFilter({ min: '', max: '', q: '  ', dir: '' }), false);
    assert.equal(hasFilter({ from: '2026-07-01' }), true);
    assert.equal(hasFilter({ q: '房租' }), true);
    assert.equal(hasFilter({ onlyNoted: true }), true);
    assert.equal(hasFilter({ min: 0 }), true); // 0 是有效條件,不是「沒填」
  });
});

describe('合計', () => {
  test('合計算的是篩出來的那幾筆', () => {
    const s = sumRows(filterTxns(ROWS, { dir: 'credit' }));
    assert.equal(s.credit, 110_000);
    assert.equal(s.debit, 0);
  });
});

describe('帳號切出末五碼', () => {
  test('★ 末五碼前面加分隔號 —— 三個帳戶只有那裡分得出來', () => {
    assert.equal(splitTail('20992000170564'), '209920001-70564');
    assert.equal(splitTail('21762000024145'), '217620000-24145');
    assert.equal(splitTail('20992000148088'), '209920001-48088');
  });

  test('★★ 是切開不是遮罩 —— 數字一個都不能少', () => {
    // 遮掉的話對帳時要看完整帳號就得回資料庫查
    assert.equal(splitTail('20992000170564').replace('-', ''), '20992000170564');
  });

  test('★ 位置跟著長度走，不寫死前面幾碼', () => {
    // 換銀行帳號長度就不同
    assert.equal(splitTail('1234567890'), '12345-67890');
    assert.equal(splitTail('123456'), '1-23456');
  });

  test('比末五碼還短就原樣顯示', () => {
    assert.equal(splitTail('12345'), '12345');
    assert.equal(splitTail('123'), '123');
  });

  test('帶分隔號的先去掉非數字，不要切出兩個橫線', () => {
    assert.equal(splitTail('2099-2000-170564'), '209920001-70564');
  });

  test('沒有帳號回空字串', () => {
    assert.equal(splitTail(null), '');
    assert.equal(splitTail(''), '');
  });
});

describe('對方帳號切出末五碼', () => {
  test('★★ 銀行代號要留在原地，不可以跟帳號黏起來', () => {
    /*
     * 前三碼是銀行代號（013 國泰世華、007 第一銀行、012 台北富邦）。
     * 直接套 splitTail 的話會先把 `-` 去掉,變成
     * `0130000009550-332784` —— 切點跑掉,而且看不出是哪家銀行。
     */
    assert.equal(splitRef('013-0000009550332784'), '013-00000095503-32784');
    assert.equal(splitRef('007-0000024568165555'), '007-00000245681-65555');
    assert.equal(splitRef('012-0000630102023211'), '012-00006301020-23211');
  });

  test('★ 沒有代號的整串切 —— 要跟我們自己的帳戶同一個格式', () => {
    // 兩邊格式一致才對得動:我們的是 217620000-24145
    assert.equal(splitRef('0021762000024117'), '00217620000-24117');
    assert.equal(splitRef('7099230070650103'), '70992300706-50103');
  });

  test('★★ 一個數字都不能少 —— 是切開不是遮罩', () => {
    assert.equal(splitRef('013-0000009550332784').replace(/-/g, ''), '0130000009550332784');
  });

  test('代號後面沒東西就原樣回去，不要切出空段', () => {
    assert.equal(splitRef('013-'), '013-');
  });

  test('比末五碼還短的原樣顯示', () => {
    assert.equal(splitRef('013-123'), '013-123');
    assert.equal(splitRef('12345'), '12345');
  });

  test('沒有帳號回空字串', () => {
    assert.equal(splitRef(null), '');
    assert.equal(splitRef(''), '');
    assert.equal(splitRef('   '), '');
  });
});

describe('搜對方帳號', () => {
  const R = [
    r({ ref_no: '013-0000009550332784' }),
    r({ ref_no: '0021762000024117' }),
  ];

  test('★★ 複製畫面上切過的字串也要搜得到', () => {
    /*
     * 畫面顯示 `013-00000095503-32784`，資料庫存 `013-0000009550332784`。
     * 使用者一定是複製畫面上那串去搜的 —— 搜不到的時候他會以為那筆不見了,
     * 不會想到是分隔號的問題。
     */
    assert.equal(filterTxns(R, { q: '013-00000095503-32784' }).length, 1);
    assert.equal(filterTxns(R, { q: '00217620000-24117' }).length, 1);
  });

  test('原本的搜法不能壞', () => {
    assert.equal(filterTxns(R, { q: '013-0000009550332784' }).length, 1);
    assert.equal(filterTxns(R, { q: '32784' }).length, 1);
    assert.equal(filterTxns(R, { q: '2026-07-03' }).length, 2);  // 日期帶 - 照舊
  });
});
