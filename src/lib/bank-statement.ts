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
  /**
   * 餘額 —— **我們自己算的**（期初 ＋ 到這一筆為止的存入 − 支出）。
   *
   * 使用者指定（2026-08-18）:「這種數字問題 我們自己算 備註銀行計算的」。
   *
   * 照抄 PDF 的話,銀行印錯的那一格會**永遠壞在資料庫裡** ——
   * 而那一欄會被拿去對帳、被拿去查「那天帳上有多少」。
   * 自己算的整條鏈永遠自洽,銀行印錯只是一個註記。
   */
  balance: number;
  /**
   * PDF 上印的餘額。
   *
   * **這是技術欄位,去重鑰匙用它** —— 我們算的值會跟著
   * 「這份對帳單從哪裡起算」跑,期間重疊的兩份算出來可能不同,
   * 那樣同一筆會被匯兩次。銀行印的不管在哪一份 PDF 都一樣。
   *
   * **給人看的是 `balanceNote`,而那個只有不一致時才有值。**
   */
  bankBalance: number;
  /**
   * 餘額備註 —— **只有銀行印的跟我們算的不一樣時才有值**（2026-08-18 使用者指定）。
   *
   * 「銀行若有差異 要備註」。
   *
   * 每一筆都寫「銀行印 X」的話，這一欄就沒有訊號了 ——
   * 132 筆裡只有 1 筆該有備註，那 1 筆才是要人看的。
   * 全部都寫等於全部都不用看。
   */
  balanceNote: string | null;
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

/**
 * `block` 一項都不能有，有就整份不匯。
 * `warn` 是「PDF 本身有問題但資料是完整的」—— 人看過之後可以匯，會記進 `warnings`。
 */
export type Problem = { code: string; message: string; level: 'block' | 'warn' };

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
  /**
   * 金額區的右界 —— **貼著帳面餘額表頭的右緣**，不是貼著備註表頭的左緣。
   *
   * 兩者差很多，而且中間會有東西:
   *
   *     1,872,877    x1=351.0   ← 餘額（表頭 x1=346.3，只超出 4.7）
   *     1040077312   x1=431.0   ← **水費戶號**，坐在兩欄中間
   *     代繳市水      x0=435.1   ← 備註表頭
   *
   * 用備註表頭當界的話，那個 10 位數戶號會被當成餘額 ——
   * 於是那一筆的餘額變成十億，而且**不會報錯**，
   * 只會讓後面每一筆的「PDF 印的 vs 我們算的」全部對不上。
   *
   * 金額靠右對齊，所以右緣一定貼著自己欄位的表頭（實測超出 4–7pt）。
   */
  right: number;
  /** 序號欄的右界。 */
  seqRight: number;
  /**
   * 備註／摘要欄的左界。
   *
   * **用「帳面餘額表頭的右緣」而不是「備註表頭的左緣」** ——
   * 備註欄的內容會往左伸出表頭:
   *
   *     備註表頭 x0=435.1，而「京饌企業有限公司」x0=409
   *
   * 拿表頭左緣當界的話,那個公司名整個掉出去。
   */
  memoLeft: number;
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
    /*
     * 餘額欄右緣與備註欄左緣的**中線**。
     *
     * 不用固定的 pt 數 —— 四份實測的超出量從 4.0 到 13.1 都有,
     * 挑一個數字要嘛太緊(擋掉正常的餘額)要嘛太鬆(放進戶號)。
     * 中線是版面自己給的界線,跟著欄寬一起變。
     */
    right: (b.x1 + ref.x0) / 2,
    seqRight: seq.x1 + 4,
    memoLeft: b.x1 + 2,
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

  /*
   * 【餘額改成自己算】（2026-08-18 使用者指定）
   *
   * 期初只能從第一筆的「PDF 餘額 − 存入 + 支出」推 —— 那是唯一的錨點。
   * 從那裡開始一路加減,每一筆的 balance 就是我們算的。
   *
   * 2026/07 的 24145 實例:第 22 筆銀行印 3,976,587、我們算 3,977,393,
   * 而第 23 筆之後兩邊又一致 —— 所以只有那一格是銀行印錯的。
   */
  if (txns.length > 0) {
    let run = txns[0].bankBalance - txns[0].credit + txns[0].debit; // 期初
    for (const t of txns) {
      run = run - t.debit + t.credit;
      t.balance = run;
      // **只有不一樣才備註** —— 每一筆都寫的話這一欄就沒有訊號了
      const gap = t.balance - t.bankBalance;
      t.balanceNote =
        Math.abs(gap) > 0.005
          ? `PDF 上印 ${t.bankBalance.toLocaleString()}，差 ${Math.abs(gap).toLocaleString()}`
          : null;
    }
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

  const txnDate = above?.find((w) => DATE.test(w.text));
  const timeW = below?.find((w) => TIME.test(w.text));

  /*
   * 【備註欄橫跨三行,而且要靠 x 座標抓】（2026-08-18 修正）
   *
   * 第一版只讀「下一行去掉時間」當摘要,結果**主列的備註整個掉了**:
   *
   *     3  2026/07/01 匯入匯款  2,280,000  7,232,252  京饌企業有限公司 板信民權
   *     22 2026/07/03 匯出匯款  1,329,688  3,976,587  7月A棟租金
   *
   * 「京饌企業有限公司」「7月A棟租金」「電視」「家具」全部沒進資料庫 ——
   * **而那是將來跟訂單對帳最值錢的欄位**。三份舊的對帳單也一樣掉了。
   *
   * 正確的做法是看 x 座標:備註欄的東西可能出現在上一行(票據號碼)、
   * 主列(對方名稱／用途)、下一行(摘要),三行都要收。
   */
  /*
   * 【備註欄橫跨三行，逐行判斷是「帳號」還是「說明」】
   *
   * 備註票據號碼那一欄裡混著兩種東西:
   *
   *     013-0000009550332784        ← 對方帳號／票據號碼
   *     開封街二段６６之２號１樓        ← 說明
   *     1040077312 代繳市水 08025 112 TPCW   ← 一整句話（含數字）
   *     京饌企業有限公司 板信民權       ← 對方名稱
   *
   * **規則:每一行,開頭連續的「長數字串」是號碼,其餘全部是說明。**
   *
   *     013-0000009550332784        → 全部是號碼
   *     1040077312 代繳市水 08025 112 TPCW
   *       ↑ 戶號                ↑ 這些留在說明裡
   *     京饌企業有限公司 板信民權     → 開頭不是數字,整行都是說明
   *
   * 兩個細節，兩個都是踩出來的:
   *
   *   · **只看行首。** 「08025」「112」是代繳單位的代號，是那句話的一部分。
   *     逐 token 抽數字的話,「代繳市水 08025 112 TPCW」會變成「代繳市水 TPCW」,
   *     讀起來不像原本那句了。
   *
   *   · **要夠長（7 碼以上）。** 帳號與戶號都是 7 碼以上;
   *     而摘要真的可能以短數字開頭（「12月房租」的半形寫法）——
   *     沒有長度門檻的話那個「12」會被抽走,只剩「月房租」。
   *
   * 為什麼戶號算「號碼」:同一天 14 筆媒體轉帳,戶號每筆都不同
   * （1040077312 / 1040077750 / …）而「代繳市水 08025 112 TPCW」完全相同 ——
   * 那是 14 個水錶各自的識別號,跟對方帳號同一種東西。
   */
  const inMemoCol = (r: Word[] | undefined) =>
    (r ?? []).filter((w) => w.x0 >= cols.memoLeft).map((w) => w.text);
  /** 7 碼以上的純數字／連字號 —— 帳號、票據號碼、代繳戶號都長這樣。 */
  const isRefLike = (t: string) => /^[\d-]{7,}$/.test(t) && /\d/.test(t);

  const refParts: string[] = [];
  const memoParts: string[] = [];
  for (const line of [inMemoCol(above), inMemoCol(row), inMemoCol(below)]) {
    let i = 0;
    while (i < line.length && isRefLike(line[i])) refParts.push(line[i++]);
    memoParts.push(...line.slice(i));
  }
  const refNo = refParts.join(' ');
  const memo = memoParts.join(' ');

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
    // 這裡先放 PDF 上的值,parseStatement 收尾時再算出我們自己的
    balance: toNum(bal.text),
    bankBalance: toNum(bal.text),
    balanceNote: null,
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
    p.push({ code: 'no_account', level: 'block', message: '這份 PDF 找不到帳號 —— 是元大的對帳單嗎？' });
  }
  if (t.length === 0) {
    p.push({ code: 'empty', level: 'block', message: '解析不出任何交易 —— 版面可能改了' });
    return p; // 沒有資料,後面幾項驗了也沒意義
  }

  /*
   * 【整份對不對得起來】
   *
   * 期初 ＋ 所有存入 − 所有支出 = 最後一筆的餘額。
   *
   * 這一條加上「加總等於 footer 的總計」,兩條同時成立就表示
   * **一筆都沒漏、每一筆金額都讀對了**。
   *
   * 有了它,單一格餘額對不上的意義就變了 —— 見下面 balance_break。
   */
  const sumD = t.reduce((a, x) => a + x.debit, 0);
  const sumC = t.reduce((a, x) => a + x.credit, 0);
  const totalsMatch =
    st.totalDebit != null && st.totalCredit != null &&
    Math.abs(sumD - st.totalDebit) <= 0.005 && Math.abs(sumC - st.totalCredit) <= 0.005;
  const opening = t[0].balance - t[0].credit + t[0].debit;
  const endToEnd = Math.abs(opening + sumC - sumD - t[t.length - 1].balance) <= 0.005;
  const complete = totalsMatch && endToEnd;

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
        level: 'block',
        message: `序號在第 ${i + 1} 筆斷掉（讀到 ${t[i].seq}）—— 有列沒讀到`,
      });
      break;
    }
  }

  /*
   * 【PDF 印的餘額 vs 我們算的】
   *
   * ============================================================
   * 餘額欄現在是**我們自己算的**（使用者指定 2026-08-18），
   * 所以這一條不再是「我們的鏈斷了」，而是
   * **「銀行印的跟我們算的不一樣」**。
   *
   * 2026/07 那份 24145 的第 22 筆:
   *
   *     21  匯出匯款    37,756   銀行印 5,307,081
   *     22  匯出匯款 1,329,688   銀行印 3,976,587   ← 我們算 3,977,393，差 806
   *     23  匯出匯款 2,657,459   銀行印 1,319,934   ← 又跟我們一致
   *
   * 而同一份的支出加總 15,311,998、存入加總 13,925,207
   * **跟 footer 的總計一字不差**，期初 ＋ 存入 − 支出 也剛好等於期末。
   *
   * 兩條獨立的檢查都過 → 一筆都沒漏、金額全部讀對 → **是銀行印錯那一格**。
   *
   * 這時候整份擋掉是錯的:資料是完整的，擋掉只會讓會計沒有數字可用，
   * 而下次拿到同一份 PDF 還是一樣擋。
   *
   * 反過來，**總計對不上時同樣的現象代表我們真的讀錯了** —— 那要擋。
   */
  const off = t.filter((x) => Math.abs(x.balance - x.bankBalance) > 0.005);
  if (off.length > 0) {
    const f = off[0];
    p.push({
      code: 'balance_break',
      level: complete ? 'warn' : 'block',
      message: complete
        ? `第 ${f.seq} 筆（${f.postDate}）PDF 上印 ${f.bankBalance.toLocaleString()}，` +
          `依交易金額推算是 ${f.balance.toLocaleString()}（差 ` +
          `${Math.abs(f.balance - f.bankBalance).toLocaleString()}）` +
          (off.length > 1 ? `，另有 ${off.length - 1} 筆也不一致` : '') +
          '。整份的支出、存入加總與期初期末都對得起來 —— ' +
          '交易一筆都沒漏，是銀行那一格印得不一致。**餘額以我們算的為準，銀行印的存成備註。**'
        : `第 ${f.seq} 筆（${f.postDate}）PDF 印 ${f.bankBalance.toLocaleString()}、` +
          `推算 ${f.balance.toLocaleString()}，而且總計也對不上 —— 代表解析可能有誤`,
    });
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
      level: 'block',
      message: 'PDF 上讀不到「總計」那一行 —— 少了它就無法確認有沒有漏讀交易',
    });
  }

  if (st.totalDebit != null && Math.abs(sumD - st.totalDebit) > 0.005) {
    p.push({
      code: 'total_debit',
      level: 'block',
      message: `支出加總 ${sumD.toLocaleString()} 對不上 PDF 的總計 ${st.totalDebit.toLocaleString()}`,
    });
  }
  if (st.totalCredit != null && Math.abs(sumC - st.totalCredit) > 0.005) {
    p.push({
      code: 'total_credit',
      level: 'block',
      message: `存入加總 ${sumC.toLocaleString()} 對不上 PDF 的總計 ${st.totalCredit.toLocaleString()}`,
    });
  }

  return p;
}

/**
 * 去重鑰匙:`帳號 + 帳務日 + **銀行印的**餘額 + 交易時間`。
 *
 * **用 bankBalance 不用 balance**（migration_143）——
 * balance 是我們算的,會跟著「這份對帳單從哪裡起算」跑,
 * 期間重疊的兩份算出來可能不同,那樣同一筆會被匯兩次。
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
  return `${accountId}|${t.postDate}|${t.bankBalance}|${t.txnTime ?? '00:00:00'}`;
}
