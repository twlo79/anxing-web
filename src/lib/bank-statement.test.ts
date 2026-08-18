import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  parseStatement, validate, readColumns, openingBalance,
  accountMatches, digitsOnly, txnKey,
  type Word, type Statement,
} from './bank-statement.ts';

/**
 * 對帳單解析器的測試。
 *
 * ============================================================
 * 【測試資料是三份真實對帳單】
 *
 * `__fixtures__/yuanta-*.tsv` 是用 pdfplumber 從真的 PDF 抽出來的
 * 每一個詞的座標（page / x0 / x1 / top / text）。
 *
 * 這樣測試跑起來**不需要 pdfjs、也不需要 PDF 檔** ——
 * 而且釘住的是真實版面,不是我想像中的版面。
 *
 *
 * ============================================================
 * 【這支測試在防什麼】
 *
 * 解析錯**不會當掉,也不會報錯**。三種錯法都是安靜的:
 *
 *   ① 支出／存入判反 → 那一筆之後的餘額全部偏掉兩倍金額
 *   ② 整頁被跳過     → 少 166 筆,金額全對但總計對不上
 *   ③ 票據號碼當餘額 → 那一筆的餘額變成 16 位數
 *
 * 三個都只會讓卡片上的數字慢慢跟銀行對不上,而沒有人知道是哪天開始的。
 * 所以底下釘的不是「解析得出東西」,是**六個具體的數字**。
 */

const HERE = dirname(fileURLToPath(import.meta.url));

function load(tail: string): Word[] {
  const raw = readFileSync(join(HERE, '__fixtures__', `yuanta-${tail}.tsv`), 'utf8');
  return raw
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => {
      const [page, x0, x1, top, ...rest] = l.split('\t');
      return {
        page: Number(page), x0: Number(x0), x1: Number(x1), top: Number(top),
        text: rest.join('\t'),
      };
    });
}

const W: Record<string, Word[]> = {
  '70564': load('70564'), '24145': load('24145'), '48088': load('48088'),
};
const S: Record<string, Statement> = {
  '70564': parseStatement(W['70564']),
  '24145': parseStatement(W['24145']),
  '48088': parseStatement(W['48088']),
};

// ============================================================
// 三份對帳單,每份六個數字
// ============================================================

const EXPECT = [
  { tail: '70564', acct: '20992000170564', n: 47,  debit: 2_085_031, credit: 2_138_901, close: 81_977,  open: 28_107 },
  { tail: '24145', acct: '21762000024145', n: 7,   debit:   993_571, credit: 1_000_161, close:  6_590,  open:      0 },
  { tail: '48088', acct: '20992000148088', n: 198, debit: 4_144_295, credit: 4_402_224, close: 262_433, open:  4_504 },
];

for (const e of EXPECT) {
  describe(`元大 ${e.tail}`, () => {
    const st = S[e.tail];

    test('★ 帳號與期間', () => {
      assert.equal(st.accountNo, e.acct);
      assert.equal(st.branch, '元大中崙');
      assert.equal(st.periodFrom, '2025-01-01');
      assert.equal(st.periodTo, '2025-06-30');
    });

    test('★★ 筆數', () => {
      // 少一筆不會有徵兆 —— 只有這個數字說得出來
      assert.equal(st.txns.length, e.n);
    });

    test('★★ 支出與存入的加總等於 PDF 的「總計」', () => {
      // 這一條同時抓「判反方向」與「漏讀」—— 兩種都會讓加總歪掉
      const sd = st.txns.reduce((a, t) => a + t.debit, 0);
      const sc = st.txns.reduce((a, t) => a + t.credit, 0);
      assert.equal(sd, e.debit);
      assert.equal(sc, e.credit);
      assert.equal(st.totalDebit, e.debit);
      assert.equal(st.totalCredit, e.credit);
    });

    test('★ 逐筆餘額連得起來', () => {
      for (let i = 1; i < st.txns.length; i++) {
        const want = st.txns[i - 1].balance - st.txns[i].debit + st.txns[i].credit;
        assert.equal(want, st.txns[i].balance, `第 ${st.txns[i].seq} 筆接不上`);
      }
    });

    test('★ 序號 1…N 連續', () => {
      assert.deepEqual(
        st.txns.map((t) => t.seq),
        Array.from({ length: e.n }, (_, i) => i + 1),
      );
    });

    test('期末與期初餘額', () => {
      assert.equal(st.txns[st.txns.length - 1].balance, e.close);
      assert.equal(openingBalance(st.txns), e.open);
    });

    test('★★ validate() 一項都不該報', () => {
      assert.deepEqual(validate(st), []);
    });

    test('支出與存入不會同時有值', () => {
      for (const t of st.txns) {
        assert.ok(t.debit === 0 || t.credit === 0, `第 ${t.seq} 筆兩邊都有值`);
      }
    });
  });
}

// ============================================================
// 三個坑,各釘一條
// ============================================================

describe('坑① 支出／存入靠 x 座標分,不是靠順序', () => {
  test('★★ 70564 第 1 筆 17,836 是存入不是支出', () => {
    // 純文字是「ＡＴＭ轉 台北富邦 17,836 45,943」—— 看不出方向。
    // 判反的話 45,943 這個餘額就接不上,而且不會報錯。
    const t = S['70564'].txns[0];
    assert.equal(t.credit, 17_836);
    assert.equal(t.debit, 0);
    assert.equal(t.balance, 45_943);
  });

  test('★★ 支出欄的數字要進 debit', () => {
    const t = S['70564'].txns.find((x) => x.debit === 217_575);
    assert.ok(t, '找不到那筆 217,575 的支出');
    assert.equal(t.credit, 0);
  });

  test('存入與支出的筆數都不是 0 —— 全判成同一邊會讓總計剛好對不上一半', () => {
    for (const e of EXPECT) {
      const st = S[e.tail];
      assert.ok(st.txns.some((t) => t.debit > 0), `${e.tail} 一筆支出都沒有`);
      assert.ok(st.txns.some((t) => t.credit > 0), `${e.tail} 一筆存入都沒有`);
    }
  });
});

describe('坑② 表頭只印在第 1 頁', () => {
  test('★★ 48088 有 6 頁,每一頁都要讀到', () => {
    // 「找不到表頭就跳過這一頁」會讓 198 筆只剩 32 筆 ——
    // 而且金額判斷全部正確,只是少了 166 筆。
    const pages = new Set(S['48088'].txns.map((t) => t.page));
    assert.deepEqual([...pages].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6]);
  });

  test('★★ 只有第 1 頁找得到表頭 —— 這是前提,不是假設', () => {
    const withHdr = new Set<number>();
    for (let p = 1; p <= 6; p++) {
      const rows = W['48088'].filter((w) => w.page === p);
      // 整頁的詞丟進去,找得到表頭才算
      if (readColumns(rows)) withHdr.add(p);
    }
    assert.deepEqual([...withHdr], [1], '版面變了：表頭出現在別的頁');
  });

  test('第 2 頁以後也解析得出交易', () => {
    const p6 = S['48088'].txns.filter((t) => t.page === 6);
    assert.ok(p6.length > 0);
  });
});

describe('坑③ 票據號碼在餘額欄右邊', () => {
  test('★★ 7176235030200100 不可以被當成餘額', () => {
    // 24145 那份的票據號碼是 16 位數,x1=547 在餘額欄右邊。
    // 「最右邊的數字是餘額」的寫法會把它抓進來。
    for (const t of S['24145'].txns) {
      assert.ok(t.balance < 10_000_000, `第 ${t.seq} 筆餘額 ${t.balance} 太大,抓到票據號碼了`);
    }
    assert.equal(S['24145'].txns[0].balance, 1_000_000);
  });

  test('票據號碼有被收進 refNo', () => {
    const t = S['24145'].txns[0];
    assert.match(t.refNo, /7176235030200100/);
  });
});

// ============================================================
// x 座標不可以寫死
// ============================================================

describe('★★ 欄位座標三份不一樣,不能寫死', () => {
  test('24145 的欄位比另外兩份右移約 62pt', () => {
    // 這一條是**反向測試** —— 它證明「x 座標要在固定範圍」那條規則是錯的。
    // 同一家銀行、同一個系統匯出、同一個查詢期間,欄寬還是會跟著內容撐開。
    const col = (tail: string) => {
      const c = readColumns(W[tail].filter((w) => w.page === 1));
      assert.ok(c, `${tail} 讀不到表頭`);
      return c;
    };
    const a = col('70564');
    const b = col('48088');
    const c = col('24145');

    assert.equal(a.debitCredit, b.debitCredit);            // 這兩份一樣
    assert.ok(c.debitCredit - a.debitCredit > 50, '24145 應該明顯右移');
    // 而三份都解析得出正確的數字 —— 那才是重點
  });

  test('表頭順序不對就不認這個版面', () => {
    const hdr = W['70564'].filter((w) => w.page === 1);
    // 把「存入金額」搬到最右邊 → 順序壞掉
    const broken = hdr.map((w) =>
      w.text === '存入金額' ? { ...w, x0: 900, x1: 940 } : w,
    );
    assert.equal(readColumns(broken), null);
  });

  test('少一個表頭就不認', () => {
    const hdr = W['70564'].filter((w) => w.page === 1 && w.text !== '帳面餘額');
    assert.equal(readColumns(hdr), null);
  });
});

// ============================================================
// 帳號比對
// ============================================================

describe('帳號比對', () => {
  test('去掉非數字之後比', () => {
    assert.equal(digitsOnly('2099-2000-170564'), '20992000170564');
  });

  test('★ 有完整帳號就比完整的', () => {
    const acct = { account_no: '20992000170564', account_no_tail: '70564' };
    assert.equal(accountMatches('20992000170564', acct), true);
    assert.equal(accountMatches('21762000024145', acct), false);
  });

  test('★★ 完整帳號不同但末五碼相同,要判定不符', () => {
    // 24145 的號碼是 21762 開頭,另外兩個是 20992 ——
    // 「前面幾碼一樣就好」或「末五碼就夠」在這裡都會出錯
    const acct = { account_no: '20992000170564', account_no_tail: '70564' };
    assert.equal(accountMatches('99999999970564', acct), false);
  });

  test('沒有完整帳號時退回比末五碼', () => {
    const acct = { account_no: null, account_no_tail: '24145' };
    assert.equal(accountMatches('21762000024145', acct), true);
    assert.equal(accountMatches('20992000148088', acct), false);
  });

  test('解析不出帳號一律不符 —— 不要當成「隨便哪個都行」', () => {
    assert.equal(accountMatches(null, { account_no: '20992000170564' }), false);
    assert.equal(accountMatches('', { account_no_tail: '70564' }), false);
  });

  test('★ 三份 PDF 各自認得出自己的帳戶', () => {
    const accts = EXPECT.map((e) => ({ account_no: e.acct, account_no_tail: e.tail }));
    for (const e of EXPECT) {
      const hit = accts.filter((a) => accountMatches(S[e.tail].accountNo, a));
      assert.equal(hit.length, 1, `${e.tail} 對到 ${hit.length} 個帳戶`);
      assert.equal(hit[0].account_no, e.acct);
    }
  });
});

// ============================================================
// validate 真的抓得到問題
// ============================================================

describe('validate 抓得到問題', () => {
  const clone = (tail: string): Statement =>
    JSON.parse(JSON.stringify(S[tail])) as Statement;

  test('★★ 支出存入判反 → 餘額接不上', () => {
    const st = clone('70564');
    const t = st.txns[5];
    [t.debit, t.credit] = [t.credit, t.debit];
    const p = validate(st);
    assert.ok(p.some((x) => x.code === 'balance_break'), '判反了卻沒報');
  });

  test('★★ 漏掉一筆 → 序號斷掉', () => {
    const st = clone('70564');
    st.txns.splice(10, 1);
    const p = validate(st);
    assert.ok(p.some((x) => x.code === 'seq_gap'));
  });

  test('★★ 少了一整頁 → 總計對不上', () => {
    const st = clone('48088');
    st.txns = st.txns.filter((t) => t.page === 1);
    // 序號從第 33 筆起就斷了,所以兩種都會報
    const codes = validate(st).map((x) => x.code);
    assert.ok(codes.includes('seq_gap') || codes.includes('total_debit'));
  });

  test('解析不出帳號要報', () => {
    const st = clone('70564');
    st.accountNo = null;
    assert.ok(validate(st).some((x) => x.code === 'no_account'));
  });

  test('一筆都沒有要報,而且不要再報餘額', () => {
    const st = clone('70564');
    st.txns = [];
    const codes = validate(st).map((x) => x.code);
    assert.ok(codes.includes('empty'));
    assert.ok(!codes.includes('balance_break'));
  });
});

// ============================================================
// 去重鑰匙
// ============================================================

describe('去重鑰匙', () => {
  test('★★ 同一份 PDF 裡的鑰匙全部相異', () => {
    // 撞了的話第二次上傳會少匯那幾筆,而畫面只會說「重複」
    for (const e of EXPECT) {
      const keys = S[e.tail].txns.map((t) => txnKey('acc', t));
      assert.equal(new Set(keys).size, keys.length, `${e.tail} 有鑰匙撞在一起`);
    }
  });

  test('★★ 沒印時間的兩筆要收斂成 00:00:00', () => {
    // null 在資料庫的唯一索引裡互不相等 —— 不收斂的話會重複匯入
    const base = S['70564'].txns[0];
    const a = txnKey('acc', { ...base, txnTime: null });
    const b = txnKey('acc', { ...base, txnTime: null });
    assert.equal(a, b);
    assert.match(a, /00:00:00$/);
  });

  test('同日同額但餘額不同 → 鑰匙不同', () => {
    // 同一天收兩筆一樣的房租,金額會撞,餘額不會
    const base = S['70564'].txns[0];
    const a = txnKey('acc', { ...base, balance: 46_000 });
    const b = txnKey('acc', { ...base, balance: 92_000 });
    assert.notEqual(a, b);
  });

  test('不同帳戶的同一筆 → 鑰匙不同', () => {
    const t = S['70564'].txns[0];
    assert.notEqual(txnKey('acc-1', t), txnKey('acc-2', t));
  });
});

// ============================================================
// 摘要
// ============================================================

describe('摘要', () => {
  test('★ 全形字原樣保留,不要轉半形', () => {
    // 「１２月房租」轉成「12月房租」之後跟 PDF 對不起來,
    // 而人核對時看的是 PDF
    const memos = S['70564'].txns.map((t) => t.memo).join('|');
    assert.ok(/[０-９]/.test(memos), '全形數字被轉掉了');
  });

  test('交易日與帳務日不一定相同,兩個都要留', () => {
    const st = S['70564'];
    assert.ok(
      st.txns.some((t) => t.txnDate && t.txnDate !== t.postDate),
      '沒有任何一筆的交易日與帳務日不同 —— 上一行沒讀到?',
    );
  });
});
