/**
 * 元大銀行對帳單 PDF 的解析。**只吃座標，不碰 PDF 檔案本身。**
 *
 * ============================================================
 * 【為什麼要有這個檔案】（2026-08-18 帳戶管理）
 *
 * 讀 PDF 這件事本身在瀏覽器做（pdfjs）。但「哪個數字是支出、哪個是存入」
 * 是**純粹的座標算術** —— 那部分寫在這裡，因為:
 *
 *   1. 判錯一筆**不會報錯**,只會讓那一筆之後的餘額全部偏掉兩倍金額,
 *      然後卡片上的數字慢慢跟銀行對不上,而沒有人知道是哪天開始的
 *   2. 寫在元件裡就測不到 —— 測試環境不處理 JSX
 *   3. 後端收到前端送來的 JSON 之後**要用同一份程式碼重驗一次**
 *
 * 測試用的是三份真實對帳單抽出來的座標（`__fixtures__/yuanta-*.tsv`）,
 * 所以測試跑起來不需要 pdfjs,也不需要 PDF 檔。
 *
 *
 * ============================================================
 * 【三個會安靜漏資料的坑】（三份 PDF 實測翻出來的）
 *
 * ① **純文字看不出方向**
 *    「ＡＴＭ轉 台北富邦 17,836 45,943」—— 17,836 是支出還是存入?
 *    兩欄之間的空白在純文字裡消失了。只有 x 座標分得出來。
 *
 * ② **表頭只印在第 1 頁**
 *    48088 有 6 頁,只有 p1 有表頭。「找不到表頭就跳過這一頁」是最自然的
 *    寫法 —— 而那會讓 198 筆只讀到 32 筆,另外 166 筆靜靜消失。
 *
 * ③ **票據號碼在餘額欄的右邊**
 *    「2025/06/05 7176235030200100」—— 只寫「最右邊的數字是餘額」的話,
 *    那串 16 位數會被當成餘額。
 *
 *
 * ============================================================
 * 【x 座標不可以寫死】
 *
 * 三份同一家銀行、同一個系統匯出、同一個查詢期間的對帳單:
 *
 *              70564    48088   24145
 *   支出金額 x0  240.0    240.0   301.9   ← 右移 62pt
 *   存入金額 x0  286.4    286.4   358.4
 *   帳面餘額 x0  330.8    330.8   417.6
 *
 * 欄寬會跟著內容自動撐開。原本規格寫「x 座標超出預期範圍就擋下」——
 * **那條規則會把 24145 整份擋掉。**
 *
 * 所以每一份自己讀表頭,只驗相對順序（支出在存入左邊、存入在餘額左邊）。
 */

// ── 輸入 ──────────────────────────────────────────

/** PDF 上的一個「詞」。pdfjs 與 pdfplumber 都給得出這四個值。 */
export type Word = {
  page: number;
  x0: number;
  /** 右緣。**金額靠右對齊,所以判斷欄位一律看 x1 不看 x0** —— 位數不同時左緣會飄。 */
  x1: number;
  top: number;
  text: string;
};

// ── 輸出 ──────────────────────────────────────────

export type Txn = {
  page: number;
  /** PDF 上的序號。是「本次查詢的流水號」—— **不可拿來當去重鑰匙**,換期間就從 1 重來。 */
  seq: number;
  /** 交易日。人對帳時看這個。 */
  txnDate: string | null;
  /** 帳務日。餘額的順序跟著這個走。 */
  postDate: string;
  txnTime: string | null;
  /** ＡＴＭ轉／企網付款／現金存款／存款息… */
  description: string;
  /** 交易行庫（台北富邦／中國信託…）。沒有就是空字串。 */
  counterparty: string;
  debit: number;
  credit: number;
  balance: number;
  /** 摘要。**全形字原樣保留** —— １２月房租／南５／林思瑜３月租金。 */
  memo: string;
  /** 票據號碼。 */
  refNo: string;
};

export type Statement = {
  /** PDF 上「帳號元大中崙-綜合活期-20992000170564」抽出來的完整帳號。 */
  accountNo: string | null;
  branch: string | null;
  periodFrom: string | null;
  periodTo: string | null;
  /** footer 的「總計 2,085,031 2,138,901」。null 表示這份沒有那一行。 */
  totalDebit: number | null;
  totalCredit: number | null;
  txns: Txn[];
};

export type Problem = { code: string; message: string };

// ── 小工具 ────────────────────────────────────────

const AMOUNT = /^-?\d{1,3}(,\d{3})*$|^-?\d+$/;
const DATE = /^(\d{4})\/(\d{2})\/(\d{2})$/;
const TIME = /^\d{2}:\d{2}:\d{2}$/;

function toNum(s: string): number {
  return Number(s.replace(/,/g, ''));
}

function toIso(s: string): string {
  const m = DATE.exec(s);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
}

/**
 * 只留數字。`2099-2000-170564` 與 `20992000170564` 要算同一個帳號。
 */
export function digitsOnly(s: string): string {
  return (s ?? '').replace(/\D/g, '');
}

/**
 * 這份 PDF 是不是這個帳戶的?
 *
 * **完整帳號優先。** 末五碼只是「還沒拿到那個帳戶的 PDF」時的退路 ——
 * 而且不論用哪一種,比的都必須是**解析出來的帳號欄位**,
 * 絕對不可以在整份 PDF 的文字裡搜:票據號碼（012-0000341168247682）
 * 那串數字裡隨時會出現一樣的五碼,撞上就整份記到錯的帳戶。
 */
export function accountMatches(
  parsed: string | null,
  acct: { account_no?: string | null; account_no_tail?: string | null },
): boolean {
  const p = digitsOnly(parsed ?? '');
  if (!p) return false;
  const full = digitsOnly(acct.account_no ?? '');
  if (full) return p === full;
  const tail = digitsOnly(acct.account_no_tail ?? '');
  return tail.length > 0 && p.endsWith(tail);
}

// ── 分行 ──────────────────────────────────────────

/**
 * 依 `top` 把詞分成一行一行。
 *
 * 容差 3pt —— 同一行的詞 top 會有零點幾的差異（字體大小不同）。
 * 太小會把一行切成兩行,太大會把上下兩行併在一起。
 */
function groupRows(words: Word[], tol = 3): Word[][] {
  const byPage = new Map<number, Word[]>();
  for (const w of words) {
    const a = byPage.get(w.page);
    if (a) a.push(w);
    else byPage.set(w.page, [w]);
  }
  const out: Word[][] = [];
  for (const page of [...byPage.keys()].sort((a, b) => a - b)) {
    const bucket = new Map<number, Word[]>();
    for (const w of byPage.get(page)!) {
      const k = Math.round(w.top / tol);
      const a = bucket.get(k);
      if (a) a.push(w);
      else bucket.set(k, [w]);
    }
    for (const k of [...bucket.keys()].sort((a, b) => a - b)) {
      out.push(bucket.get(k)!.sort((a, b) => a.x0 - b.x0));
    }
  }
  return out;
}

// ── 欄位位置 ──────────────────────────────────────

type Cols = {
  /** 支出／存入的分界（兩個表頭右緣的中線）。 */
  debitCredit: number;
  /** 存入／餘額的分界。 */
  creditBalance: number;
  /** 金額區的左界（交易說明的左緣）。 */
  left: number;
  /** 金額區的右界。**再往右是票據號碼,不是金額**（坑③）。 */
  right: number;
  /** 序號欄的右界。 */
  seqRight: number;
};

const HDR = {
  seq: '序號',
  desc: '交易說明',
  debit: '支出金額',
  credit: '存入金額',
  balance: '帳面餘額',
  ref: '備註票據號碼',
} as const;

/**
 * 從表頭那一列算出各欄的分界。找不到表頭回 null。
 *
 * **不檢查絕對座標**（24145 整份右移 62pt，檢查就會把它擋掉）,
 * 只檢查相對順序。
 */
export function readColumns(words: Word[]): Cols | null {
  const find = (t: string) => words.find((w) => w.text === t);
  const seq = find(HDR.seq);
  const desc = find(HDR.desc);
  const d = find(HDR.debit);
  const c = find(HDR.credit);
  const b = find(HDR.balance);
  const ref = find(HDR.ref);
  if (!seq || !desc || !d || !c || !b || !ref) return null;
  // 順序不對就不是這個版面 —— 硬解析出來的東西不值得看
  if (!(desc.x1 < d.x1 && d.x1 < c.x1 && c.x1 < b.x1 && b.x1 < ref.x0)) return null;
  return {
    debitCredit: (d.x1 + c.x1) / 2,
    creditBalance: (c.x1 + b.x1) / 2,
    left: desc.x0,
    right: ref.x0 - 2,
    seqRight: seq.x1 + 4,
  };
}

// ── 主解析 ────────────────────────────────────────

/**
 * 從整份 PDF 的詞解析出對帳單。
 *
 * **這裡不做任何驗證** —— 驗證在 `validate()`,因為呼叫端要先拿到
 * 解析結果才能把「哪一筆對不上」指給人看。
 */
export function parseStatement(words: Word[]): Statement {
  /*
   * 【抬頭一律用「拿掉所有空白」的版本比對】（2026-08-18 修正）
   *
   * PDF 抽出來的「詞」邊界不是固定的:
   *
   *   pdfplumber  「帳號元大中崙-綜合活期-21762000024145」 一個詞
   *   pdfjs       切成好幾塊,接起來變成「帳號 元大中崙-綜合活期-21762000024145」
   *
   * 第一版的帳號正規式要求「帳號」後面不能有空白 —— pdfjs 那邊就讀不到,
   * 而**期間那一條剛好有先拿掉空白所以讀得到**。
   * 同一份程式碼裡兩種寫法,其中一種碰巧對 —— 那不叫對。
   *
   * 抬頭是連續的一段字,詞怎麼切跟意思無關。所以一律拿掉空白再比。
   * 表格不能這樣做 —— 那裡的空白就是欄位的分界。
   */
  const flat = words.map((w) => w.text).join('').replace(/\s+/g, '');
  const spaced = words.map((w) => w.text).join(' ');

  // 帳號:「帳號元大中崙-綜合活期-20992000170564」
  const mAcct = /帳號(\S+?)-(\S+?)-(\d{6,})/.exec(flat);
  // 期間:「查詢期間2025/01/01~2025/06/30」
  const mPeriod = /查詢期間(\d{4}\/\d{2}\/\d{2})~(\d{4}\/\d{2}\/\d{2})/.exec(flat);

  const rows = groupRows(words);

  /*
   * 【坑②】表頭只印在第 1 頁。
   *
   * `cols` 讀到之後就一直沿用到最後一頁 —— 不重設。
   * 「這一頁沒有表頭就跳過」會讓 48088 的 198 筆只讀到 32 筆,
   * 而且金額判斷全部正確、只是少了 166 筆,總計才對不上。
   */
  let cols: Cols | null = null;
  const txns: Txn[] = [];
  let totals: { debit: number; credit: number } | null = null;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const found = readColumns(row);
    if (found) {
      cols = found;
      continue; // 表頭那一列本身不是資料
    }
    if (!cols) continue; // 表頭之前的抬頭區

    if (row.some((w) => w.text.includes('總計'))) {
      totals = totals ?? pickTotals(row, cols);
      continue;
    }
    const t = pickTxn(row, rows[i - 1], rows[i + 1], cols);
    if (t) txns.push(t);
  }

  // 表格裡讀不到就退回整份文字找 —— 空白多少都吃
  if (!totals) {
    const m = /總計\s*([\d,]+)\s+([\d,]+)/.exec(spaced);
    if (m) totals = { debit: toNum(m[1]), credit: toNum(m[2]) };
  }

  return {
    accountNo: mAcct ? mAcct[3] : null,
    branch: mAcct ? mAcct[1] : null,
    periodFrom: mPeriod ? toIso(mPeriod[1]) : null,
    periodTo: mPeriod ? toIso(mPeriod[2]) : null,
    totalDebit: totals ? totals.debit : null,
    totalCredit: totals ? totals.credit : null,
    txns,
  };
}

/**
 * footer 的「總計 2,085,031 2,138,901」。
 *
 * **用欄位位置讀，不用「總計後面第一個數字」** ——
 * 某一邊是 0 的時候（例如整個期間只有存入沒有支出），
 * PDF 上那一格是空的，靠順序會把存入的金額當成支出。
 */
function pickTotals(row: Word[], cols: Cols): { debit: number; credit: number } | null {
  const amts = row.filter(
    (w) => AMOUNT.test(w.text) && w.x1 > cols.left && w.x1 <= cols.right,
  );
  if (amts.length > 0) {
    let debit = 0;
    let credit = 0;
    for (const w of amts) {
      if (w.x1 <= cols.debitCredit) debit = toNum(w.text);
      else if (w.x1 <= cols.creditBalance) credit = toNum(w.text);
    }
    if (debit || credit) return { debit, credit };
  }
  // 整列被黏成一塊時座標救不了,退回讀文字
  const m = /總計\s*([\d,]+)\s+([\d,]+)/.exec(row.map((w) => w.text).join(' '));
  return m ? { debit: toNum(m[1]), credit: toNum(m[2]) } : null;
}

/**
 * 一筆交易佔三行:
 *
 *     2025/01/01 012-0000341168247682        ← 上:交易日 ＋ 票據號碼
 *     1 2025/01/02 ＡＴＭ轉 台北富邦 17,836 45,943   ← 中:序號 帳務日 說明 行庫 金額 餘額
 *     01:06:44 １２月房租                     ← 下:交易時間 ＋ 摘要
 *
 * **中間那一行有序號**,靠它認出哪一行是主列。
 */
function pickTxn(row: Word[], above: Word[] | undefined, below: Word[] | undefined, cols: Cols): Txn | null {
  if (row.some((w) => w.text === '總計')) return null;

  const seqW = row.find((w) => w.x1 <= cols.seqRight && /^\d+$/.test(w.text));
  if (!seqW) return null;

  /*
   * 【坑③】右界。x1 超過「備註票據號碼」表頭左緣的,是票據號碼不是金額 ——
   * 24145 那份的 `7176235030200100`（x1=547）就會被當成餘額。
   */
  const amts = row.filter(
    (w) => AMOUNT.test(w.text) && w.x1 > cols.left && w.x1 <= cols.right,
  );
  if (amts.length === 0) return null;

  const bal = amts[amts.length - 1];
  if (bal.x1 <= cols.creditBalance) return null; // 最右邊那個不在餘額欄 → 版面不對

  /*
   * 【坑①】方向。用右緣 x1 落在哪一段決定支出還是存入。
   *
   * 判錯的話那一筆之後的餘額全部偏掉兩倍金額,而且不報錯。
   */
  let debit = 0;
  let credit = 0;
  for (const w of amts.slice(0, -1)) {
    if (w.x1 <= cols.debitCredit) debit = toNum(w.text);
    else if (w.x1 <= cols.creditBalance) credit = toNum(w.text);
  }

  const dates = row.filter((w) => DATE.test(w.text));
  const postDate = dates.length ? toIso(dates[dates.length - 1].text) : '';
  if (!postDate) return null;

  // 說明與行庫:在金額左邊、不是數字也不是日期的詞
  const words = row.filter(
    (w) =>
      w.x0 >= cols.left - 8 &&
      w.x1 <= cols.debitCredit &&
      !AMOUNT.test(w.text) &&
      !DATE.test(w.text),
  );
  const description = words[0]?.text ?? '';
  const counterparty = words.slice(1).map((w) => w.text).join(' ');

  // 上一行:交易日 ＋ 票據號碼
  const txnDate = above?.find((w) => DATE.test(w.text));
  const refNo = above?.filter((w) => !DATE.test(w.text)).map((w) => w.text).join(' ') ?? '';

  // 下一行:交易時間 ＋ 摘要（全形字原樣保留）
  const timeW = below?.find((w) => TIME.test(w.text));
  const memo = below?.filter((w) => !TIME.test(w.text)).map((w) => w.text).join(' ') ?? '';

  return {
    page: row[0].page,
    seq: Number(seqW.text),
    txnDate: txnDate ? toIso(txnDate.text) : null,
    postDate,
    txnTime: timeW ? timeW.text : null,
    description,
    counterparty,
    debit,
    credit,
    balance: toNum(bal.text),
    memo,
    refNo,
  };
}

// ── 驗證 ──────────────────────────────────────────

/**
 * 期初餘額 —— 第一筆的「餘額 − 存入 + 支出」。
 *
 * **不是人填的。** 人填會填錯,而填錯了整條餘額鏈都對不上,
 * 然後每次匯入都跳警告,最後沒有人再看警告。
 */
export function openingBalance(txns: Txn[]): number | null {
  if (txns.length === 0) return null;
  const f = txns[0];
  return f.balance - f.credit + f.debit;
}

/**
 * 三道驗證。**全部都是「擋」,沒有警告。**
 *
 * 三份真實對帳單全部一次通過 —— 所以沒過就代表解析器真的錯了,
 * 不是資料本身有瑕疵。放行只會讓錯的流水進資料庫,
 * 而餘額歪掉是「慢慢地、不報錯地」發生。
 */
export function validate(st: Statement): Problem[] {
  const p: Problem[] = [];
  const t = st.txns;

  if (!st.accountNo) {
    p.push({ code: 'no_account', message: '這份 PDF 找不到帳號 —— 是元大的對帳單嗎？' });
  }
  if (t.length === 0) {
    p.push({ code: 'empty', message: '解析不出任何交易 —— 版面可能改了' });
    return p; // 沒有資料,後面幾項驗了也沒意義
  }

  /*
   * 【序號連續】免費的第三道驗證。
   *
   * 序號是「本次查詢的流水號」,不能拿來去重 ——
   * 但拿來檢查「有沒有整頁被漏讀」剛剛好（坑②一斷就抓到）。
   */
  for (let i = 0; i < t.length; i++) {
    if (t[i].seq !== i + 1) {
      p.push({
        code: 'seq_gap',
        message: `序號在第 ${i + 1} 筆斷掉（讀到 ${t[i].seq}）—— 有列沒讀到`,
      });
      break;
    }
  }

  /* 【餘額連續】前一筆餘額 − 支出 + 存入 = 這一筆餘額 */
  for (let i = 1; i < t.length; i++) {
    const want = t[i - 1].balance - t[i].debit + t[i].credit;
    if (Math.abs(want - t[i].balance) > 0.005) {
      p.push({
        code: 'balance_break',
        message:
          `第 ${t[i].seq} 筆（${t[i].postDate}）餘額接不上：` +
          `算出來是 ${want.toLocaleString()}，PDF 上寫 ${t[i].balance.toLocaleString()}`,
      });
      break;
    }
  }

  /*
   * 【總計相符】對 footer 那一行。
   *
   * **讀不到總計本身就是問題。**（2026-08-18 補）
   *
   * 第一版寫 `if (st.totalDebit != null)` 才比 —— 那表示 footer 讀不到時,
   * 這道最強的檢查會**安靜地不執行**,而畫面上一片綠。
   *
   * 「檢查跳過了」跟「檢查通過了」在畫面上長得一模一樣,
   * 那是所有沉默錯誤裡最貴的一種。
   */
  if (st.totalDebit == null || st.totalCredit == null) {
    p.push({
      code: 'no_total',
      message: 'PDF 上讀不到「總計」那一行 —— 少了它就無法確認有沒有漏讀交易',
    });
  }

  const sd = t.reduce((a, x) => a + x.debit, 0);
  const sc = t.reduce((a, x) => a + x.credit, 0);
  if (st.totalDebit != null && Math.abs(sd - st.totalDebit) > 0.005) {
    p.push({
      code: 'total_debit',
      message: `支出加總 ${sd.toLocaleString()} 對不上 PDF 的總計 ${st.totalDebit.toLocaleString()}`,
    });
  }
  if (st.totalCredit != null && Math.abs(sc - st.totalCredit) > 0.005) {
    p.push({
      code: 'total_credit',
      message: `存入加總 ${sc.toLocaleString()} 對不上 PDF 的總計 ${st.totalCredit.toLocaleString()}`,
    });
  }

  return p;
}

/**
 * 去重鑰匙:`帳號 + 帳務日 + 餘額 + 交易時間`。
 *
 * **不用序號** —— 那是本次查詢的流水號,換期間就從 1 重來。
 *
 * **餘額比金額可靠** —— 同一天收兩筆一樣的房租（都 46,000）金額會撞,
 * 但第一筆進來之後餘額就變了,第二筆的餘額必然不同。
 *
 * 交易時間要 `?? '00:00:00'`,對齊資料庫的唯一索引
 * （null 在唯一索引裡互不相等,不收斂的話沒印時間的兩筆會重複匯入）。
 */
export function txnKey(accountId: string, t: Txn): string {
  return `${accountId}|${t.postDate}|${t.balance}|${t.txnTime ?? '00:00:00'}`;
}
