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
import { looksCombined } from './pdf-words.ts';

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

  test('★★ 支出存入判反 → 被擋下來', () => {
    // 餘額現在是我們自己算的,所以判反的徵兆從「餘額接不上」
    // 變成「加總對不上 footer 的總計」—— 但一樣要擋
    const st = clone('70564');
    const t = st.txns[5];
    [t.debit, t.credit] = [t.credit, t.debit];
    const p = validate(st).filter((x) => x.level === 'block');
    assert.ok(p.length > 0, '判反了卻沒擋');
    assert.ok(p.some((x) => x.code.startsWith('total_')), '應該是總計對不上');
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
    assert.notEqual(
      txnKey('acc', { ...base, bankBalance: 46_000 }),
      txnKey('acc', { ...base, bankBalance: 92_000 }),
    );
  });

  test('★★ 鑰匙看的是銀行印的餘額,不是我們算的', () => {
    // 我們算的會跟著「這份對帳單從哪裡起算」跑 ——
    // 拿它當鑰匙的話,期間重疊的第二份 PDF 會整份被當成新的
    const base = S['70564'].txns[0];
    assert.equal(
      txnKey('acc', { ...base, balance: 111 }),
      txnKey('acc', { ...base, balance: 222 }),
    );
  });

  test('不同帳戶的同一筆 → 鑰匙不同', () => {
    const t = S['70564'].txns[0];
    assert.notEqual(txnKey('acc-1', t), txnKey('acc-2', t));
  });
});

// ============================================================
// 備註欄橫跨三行，而且會往左伸出表頭
// ============================================================

/**
 * 【2026-08-18 使用者指出：「也要留票據備註」】
 *
 * 第一版的摘要只讀「下一行去掉時間」，**主列的備註整個掉了**：
 *
 *     3  2026/07/01 匯入匯款 2,280,000 7,232,252  京饌企業有限公司 板信民權
 *     22 2026/07/03 匯出匯款 1,329,688 3,976,587  7月A棟租金
 *     1  2025/01/03 企網付款    79,969    84,473  美商炒飯吧科技股份有限公司台灣分公司
 *
 * 這些是**將來跟訂單對帳最值錢的欄位** —— 而三份舊的對帳單也一樣掉了。
 * 沒有人會發現，因為畫面上那一格本來就常常是空的。
 */
describe('備註與票據號碼', () => {
  test('★★ 主列的備註不可以掉', () => {
    const t1 = S['48088'].txns[0];
    assert.equal(t1.memo, '美商炒飯吧科技股份有限公司台灣分公司');
  });

  test('★★ 備註欄的內容會往左伸出表頭，界線要用餘額欄的右緣', () => {
    // 「京饌企業有限公司」x0=409，而備註表頭 x0=435.1 ——
    // 拿表頭左緣當界的話那個公司名整個掉出去
    const st = parseStatement(load('24145-2607'));
    const t3 = st.txns.find((t) => t.seq === 3);
    assert.match(t3?.memo ?? '', /京饌企業有限公司/);
    assert.match(t3?.memo ?? '', /板信民權/);
  });

  test('★ 三行的備註欄都要收：上一行票據號碼、主列、下一行摘要', () => {
    const t1 = S['70564'].txns[0];
    assert.equal(t1.refNo, '012-0000341168247682'); // 上一行
    assert.equal(t1.memo, '１２月房租');             // 下一行，全形原樣
  });

  test('★★ 票據號碼折成兩行要接回同一欄', () => {
    // 24145 第 1 筆:上一行 7176235030200100、下一行 0374507
    // 靠「在第幾行」分的話，下半段會被當成摘要
    const t1 = S['24145'].txns[0];
    assert.equal(t1.refNo, '7176235030200100 0374507');
    assert.equal(t1.memo, '');
  });

  test('★★ 主列的備註要原樣留，數字不可以被抽走', () => {
    // 「1040077312 代繳市水 08025 112 TPCW」是一句話。
    // 早一版的規則是「純數字就是票據號碼」不分行,結果這句被拆成
    // 「代繳市水 TPCW」—— 沒有掉字,但讀起來不像原本那句了
    const st = parseStatement(load('24145-2607'));
    const t39 = st.txns.find((t) => t.seq === 39);
    assert.equal(t39?.memo, '1040077312 代繳市水 08025 112 TPCW');
  });

  test('★★ 備註欄一個字都不可以掉', () => {
    // 分到 memo 還是 refNo 是次要的,**掉了才是問題** ——
    // 而掉了不會有徵兆,那一格本來就常常是空的
    const words = load('24145-2607');
    const bal = words.find((w) => w.text === '帳面餘額')!;
    // 粗略重算一次備註欄:餘額表頭右緣以右。
    // 排除日期 —— footer 的列印日期也落在這個範圍,但它不屬於任何一筆交易
    const inCol = new Set(
      words
        .filter((w) => w.x0 >= bal.x1 + 2 && w.top > 160 && !/^\d{4}\/\d{2}\/\d{2}$/.test(w.text))
        .map((w) => w.text),
    );
    const st = parseStatement(words);
    const got = new Set(st.txns.flatMap((t) => [...t.memo.split(' '), ...t.refNo.split(' ')]));
    const lost = [...inCol].filter((t) => !got.has(t));
    assert.deepEqual(lost, [], `備註欄掉了 ${lost.length} 個詞`);
  });

  test('★ 摘要真的被讀到了 —— 不是每一筆都空白', () => {
    // 「有讀到欄位」與「欄位剛好都是空的」在畫面上長得一樣
    const st = parseStatement(load('24145-2607'));
    const n = st.txns.filter((t) => t.memo).length;
    assert.ok(n > 50, `只有 ${n} 筆有摘要，太少了`);
  });
});

// ============================================================
// 銀行自己把一格餘額印錯
// ============================================================

/**
 * 【2026-08-18 實例】2026/07 的 24145 第 22 筆：
 *
 *     21  匯出匯款    37,756   餘額 5,307,081
 *     22  匯出匯款 1,329,688   餘額 3,976,587   ← 算出來是 3,977,393，差 806
 *     23  匯出匯款 2,657,459   餘額 1,319,934   ← 又接回正確的鏈
 *
 * 而支出加總 15,311,998、存入加總 13,925,207 **跟 footer 一字不差**，
 * 期初 ＋ 存入 − 支出 也剛好等於期末。
 *
 * 兩條獨立的檢查都過 → 一筆都沒漏、金額全讀對 → **是銀行印錯那一格**。
 * 這時整份擋掉是錯的:資料完整，擋掉只會讓會計沒有數字可用，
 * 而下次拿同一份 PDF 還是一樣擋。
 */
describe('★★ 餘額印錯一格：資料完整時只警告，不擋', () => {
  const st = parseStatement(load('24145-2607'));

  /*
   * 【使用者的更正】2026-08-18
   *
   * 我一開始寫成「銀行印的存成備註」—— 那會變成**每一筆都有備註**。
   * 使用者更正:「是銀行若有差異 要備註」。
   *
   * 差別在訊號:132 筆裡只有 1 筆該有備註。
   * 每筆都寫的話那一欄就沒有用了 —— 全部都寫等於全部都不用看。
   */
  test('★★ 只有不一致的那一筆有備註', () => {
    const noted = st.txns.filter((t) => t.balanceNote);
    assert.equal(noted.length, 1, `有備註的筆數應該是 1，實際 ${noted.length}`);
    assert.equal(noted[0].seq, 22);
    assert.match(noted[0].balanceNote!, /3,976,587/); // 銀行印的
    assert.match(noted[0].balanceNote!, /806/);       // 差多少
  });

  test('★★ 一致的那 131 筆備註是 null，不是空字串', () => {
    // 空字串在資料庫裡也是「有值」—— 查「哪幾筆有備註」時會全部撈出來
    const others = st.txns.filter((t) => t.seq !== 22);
    assert.deepEqual([...new Set(others.map((t) => t.balanceNote))], [null]);
  });

  test('三份舊的一筆備註都沒有', () => {
    for (const e of EXPECT) {
      assert.equal(S[e.tail].txns.filter((t) => t.balanceNote).length, 0);
    }
  });

  test('金額全部讀對 —— 加總跟 footer 一字不差', () => {
    const sd = st.txns.reduce((a, t) => a + t.debit, 0);
    const sc = st.txns.reduce((a, t) => a + t.credit, 0);
    assert.equal(st.txns.length, 132);
    assert.equal(sd, 15_311_998);
    assert.equal(sc, 13_925_207);
    assert.equal(st.totalDebit, 15_311_998);
    assert.equal(st.totalCredit, 13_925_207);
  });

  test('期初 ＋ 存入 − 支出 = 期末', () => {
    const sd = st.txns.reduce((a, t) => a + t.debit, 0);
    const sc = st.txns.reduce((a, t) => a + t.credit, 0);
    assert.equal(openingBalance(st.txns)! + sc - sd, st.txns[st.txns.length - 1].balance);
  });

  test('★★ 只有一項 warn，沒有任何 block', () => {
    const p = validate(st);
    assert.deepEqual(p.map((x) => x.code), ['balance_break']);
    assert.equal(p[0].level, 'warn');
    assert.match(p[0].message, /第 22 筆/);
    assert.match(p[0].message, /806/);
  });

  test('★★ 但總計也對不上時就要擋 —— 那代表真的讀錯了', () => {
    const broken: Statement = JSON.parse(JSON.stringify(st));
    broken.totalDebit = 999;
    const p = validate(broken);
    assert.equal(p.find((x) => x.code === 'balance_break')?.level, 'block');
  });

  test('三份舊的仍然一項都不報', () => {
    for (const e of EXPECT) assert.deepEqual(validate(S[e.tail]), []);
  });
});

// ============================================================
// 詞的邊界會變 —— 抬頭不可以依賴切法
// ============================================================

/**
 * 【這一組測試是實機踩出來的】2026-08-18
 *
 * 三份 fixture 是 pdfplumber 抽的，它把
 * 「帳號元大中崙-綜合活期-21762000024145」當成**一個詞**。
 *
 * pdfjs 切成好幾塊。接起來變成「帳號 元大中崙-綜合活期-21762000024145」，
 * 而第一版的正規式要求「帳號」後面不能有空白 —— 就讀不到了。
 *
 * 上面那 57 條測試全綠，因為它們全部餵的是 pdfplumber 的切法。
 * **素材只有一種切法，就測不到「換一種切法會怎樣」。**
 *
 * 所以底下把每一個詞再切碎，模擬另一種 PDF 函式庫的行為 ——
 * 表格靠座標所以不受影響，抬頭則必須切法無關。
 */
function shatter(words: Word[]): Word[] {
  const out: Word[] = [];
  for (const w of words) {
    /*
     * **數字與日期不切。**
     *
     * 不是為了讓測試好過 —— 是因為那不是真實會發生的事:
     * 金額在 PDF 裡是一次畫完的一段,任何函式庫都不會把
     * 「2,085,031」拆成「2,08」與「5,031」。
     *
     * 而且真的被拆成那樣的話,**沒有任何辦法還原** ——
     * 「2,08」「5,031」到底是一個數字還是兩個,資訊已經沒了。
     * 那時該做的是停下來報錯,不是猜。
     *
     * 這裡要測的是「文字的斷點會變」,不是「數字會被腰斬」。
     */
    if (/[\d,]{2,}|\d{4}\/\d{2}/.test(w.text)) {
      out.push(w);
      continue;
    }
    // 四個字以上的詞對半切成兩塊,x 也按比例分
    if (w.text.length >= 4) {
      const mid = Math.floor(w.text.length / 2);
      const xm = w.x0 + (w.x1 - w.x0) * (mid / w.text.length);
      out.push({ ...w, text: w.text.slice(0, mid), x1: xm });
      out.push({ ...w, text: w.text.slice(mid), x0: xm });
    } else out.push(w);
  }
  return out;
}

describe('詞的切法換了也要讀得到抬頭', () => {
  for (const e of EXPECT) {
    test(`★★ ${e.tail}：詞被切碎之後，帳號與期間照樣讀得到`, () => {
      const s = parseStatement(shatter(W[e.tail]));
      assert.equal(s.accountNo, e.acct, '帳號讀不到 —— 抬頭比對又依賴切法了');
      assert.equal(s.periodFrom, '2025-01-01');
      assert.equal(s.periodTo, '2025-06-30');
    });
  }

  test('★ 帳號與期間都不可以依賴「詞剛好切在哪裡」', () => {
    // 直接用最極端的切法:整份每個字元一塊
    const chars: Word[] = [];
    for (const w of W['24145']) {
      const per = (w.x1 - w.x0) / w.text.length;
      [...w.text].forEach((c, i) => {
        chars.push({ ...w, text: c, x0: w.x0 + per * i, x1: w.x0 + per * (i + 1) });
      });
    }
    const s = parseStatement(chars);
    assert.equal(s.accountNo, '21762000024145');
    assert.equal(s.periodTo, '2025-06-30');
  });
});

// ============================================================
// 讀不到總計本身就是問題
// ============================================================

describe('★★ 總計讀不到要報，不可以安靜跳過', () => {
  test('沒有總計 → no_total', () => {
    // 第一版寫 `if (totalDebit != null)` 才比 ——
    // 那表示 footer 讀不到時,最強的那道檢查安靜地不執行,
    // 而畫面上一片綠。「跳過了」跟「通過了」長得一模一樣。
    const st: Statement = JSON.parse(JSON.stringify(S['70564']));
    st.totalDebit = null;
    st.totalCredit = null;
    assert.ok(validate(st).some((p) => p.code === 'no_total'));
  });

  test('三份都讀得到總計', () => {
    for (const e of EXPECT) {
      assert.equal(S[e.tail].totalDebit, e.debit);
      assert.equal(S[e.tail].totalCredit, e.credit);
    }
  });

  test('★ 詞被切碎之後，總計照樣讀得到', () => {
    for (const e of EXPECT) {
      const s = parseStatement(shatter(W[e.tail]));
      assert.equal(s.totalDebit, e.debit, `${e.tail} 支出總計`);
      assert.equal(s.totalCredit, e.credit, `${e.tail} 存入總計`);
    }
  });
});

// ============================================================
// pdfjs 有沒有把整列黏成一塊
// ============================================================

describe('黏成一塊的偵測', () => {
  test('★★ 三份對帳單都沒有「一塊裡裝兩個數字」', () => {
    // 這一條同時是**前提檢查**:整個 x 座標的做法建立在
    // 「一個詞一個座標」上面。哪天不成立了,這裡先紅。
    for (const e of EXPECT) {
      const bad = W[e.tail].filter((w) => /\d[\d,]*\s+\d[\d,]*/.test(w.text));
      assert.deepEqual(bad, [], `${e.tail} 有黏在一起的塊`);
      assert.equal(looksCombined(W[e.tail]), false);
    }
  });

  test('★★ 整列黏成一塊要被抓到', () => {
    // pdfjs 若把整列當成一個 item,那一塊只有一個 x ——
    // 支出與存入就分不出來,而那不會報錯,只會讓解析結果安靜地錯
    const glued: Word[] = [
      { page: 1, x0: 28, x1: 380, top: 200, text: '1 2025/01/02 ＡＴＭ轉 台北富邦 17,836 45,943' },
    ];
    assert.equal(looksCombined(glued), true);
  });

  test('票據號碼那種單一長數字不算黏', () => {
    // 「7176235030200100」是一個數字,不是兩個 —— 誤報的話每份都匯不進去
    const ok: Word[] = [
      { page: 1, x0: 100, x1: 200, top: 100, text: '7176235030200100' },
      { page: 1, x0: 100, x1: 200, top: 110, text: '012-0000341168247682' },
      { page: 1, x0: 100, x1: 200, top: 120, text: '1,000,000' },
    ];
    assert.equal(looksCombined(ok), false);
  });

  /*
   * 【真的踩到的誤報】2026-08-18
   *
   * 第一版的規則是「一塊裡有兩個數字中間隔空白」,而抬頭有這一行:
   *
   *     列印日期時間：2026/08/07 11:53:01
   *                        ↑ 07 空白 11
   *
   * pdfjs 把它當成一塊(本來就該是一塊),於是整份 PDF 被擋掉,
   * 訊息還寫「銀行換了產生對帳單的方式」—— 完全是誤導。
   *
   * 上面那幾條測試沒抓到,因為素材來自 pdfplumber,
   * 它把日期與時間切成兩個詞了。**那些測試證明的是 pdfplumber,不是 pdfjs。**
   */
  test('★★ 抬頭的「列印日期時間」不算黏', () => {
    const header: Word[] = [
      { page: 1, x0: 30, x1: 200, top: 40, text: '列印日期時間：2026/08/07 11:53:01' },
      { page: 1, x0: 30, x1: 200, top: 55, text: '查詢期間2025/01/01~2025/06/30' },
      { page: 1, x0: 30, x1: 200, top: 70, text: '統一編號/戶名83684417 安幸有限公司' },
      { page: 1, x0: 30, x1: 200, top: 85, text: '1. 使用者若未具有餘額查詢權限者' },
      { page: 1, x0: 30, x1: 200, top: 100, text: '2025/01/02 012-0000341168247682' },
    ];
    assert.equal(looksCombined(header), false);
  });

  test('★★ 真的黏成一列（兩個金額）才算', () => {
    const glued: Word[] = [
      { page: 1, x0: 28, x1: 380, top: 200, text: '1 2025/01/02 ＡＴＭ轉 台北富邦 17,836 45,943' },
    ];
    assert.equal(looksCombined(glued), true);
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
