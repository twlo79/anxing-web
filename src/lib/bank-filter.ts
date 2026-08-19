/**
 * 銀行流水的篩選。**只算「哪幾筆留下」，不管版面。**
 *
 * ============================================================
 * 【為什麼要獨立出來】
 *
 * 寫在 `.tsx` 裡就測不到 —— 測試環境不處理 JSX。
 *
 * 而篩選錯了**不會報錯**，只會少幾筆:
 *
 *   · 金額比對比錯邊 → 「10,000 以上」漏掉剛好 10,000 的那筆
 *   · 日期用字串比 → 沒問題（YYYY-MM-DD 字典序＝時間序），但寫成 Date 就會有時區
 *   · 關鍵字漏掉某個欄位 → 「押金」查得到摘要卻查不到對方名稱
 *
 * 三個都是「查出來比預期少」，而人只會覺得「那筆好像不見了」。
 */

export type BankRow = {
  post_date: string;
  txn_date?: string | null;
  description?: string | null;
  counterparty?: string | null;
  memo?: string | null;
  ref_no?: string | null;
  balance_note?: string | null;
  debit: number | string;
  credit: number | string;
};

export type BankFilter = {
  /** 帳務日起（含）。 */
  from?: string;
  /** 帳務日迄（含）。 */
  to?: string;
  /** 只看支出／只看存入。 */
  dir?: '' | 'debit' | 'credit';
  /** 金額下限（含）。比的是「這一筆的金額」，支出或存入都算。 */
  min?: string | number;
  /** 金額上限（含）。 */
  max?: string | number;
  /** 關鍵字。摘要、說明、對方、票據號碼、餘額備註都會找。 */
  q?: string;
  /** 只看有餘額備註的（銀行印的跟我們算的不一樣）。 */
  onlyNoted?: boolean;
};

const num = (v: number | string | undefined | null) => {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** 這一筆的金額 —— 支出或存入，其中一個是 0。 */
export function amountOf(r: BankRow): number {
  return Math.max(Number(r.debit) || 0, Number(r.credit) || 0);
}

export function filterTxns<T extends BankRow>(rows: T[], f: BankFilter): T[] {
  const min = num(f.min);
  const max = num(f.max);
  const q = (f.q ?? '').trim().toLowerCase();

  return rows.filter((r) => {
    /*
     * 日期用字串比。
     *
     * `YYYY-MM-DD` 的字典序就是時間序,所以不需要 new Date() ——
     * 而 new Date('2025-01-01') 會被當成 UTC 午夜,在台灣時區
     * 變成前一天早上八點,篩「1 月 1 日起」就會少掉 1 月 1 日那幾筆。
     */
    const d = (r.post_date ?? '').slice(0, 10);
    if (f.from && d < f.from) return false;
    if (f.to && d > f.to) return false;

    if (f.dir === 'debit' && !(Number(r.debit) > 0)) return false;
    if (f.dir === 'credit' && !(Number(r.credit) > 0)) return false;

    // 上下限都是**含端點** —— 「10,000 以上」要包含剛好 10,000 那筆
    const amt = amountOf(r);
    if (min != null && amt < min) return false;
    if (max != null && amt > max) return false;

    if (f.onlyNoted && !r.balance_note) return false;

    if (q) {
      /*
       * 關鍵字要找過所有「人看得到的文字欄位」。
       *
       * 漏掉一個的症狀是「我明明看到畫面上有『押金』,搜卻搜不到」——
       * 而那時人會以為搜尋壞了,不會想到是欄位漏了。
       */
      const hay = [r.description, r.counterparty, r.memo, r.ref_no, r.balance_note, d]
        .map((v) => (v ?? '').toString().toLowerCase())
        .join(' ');
      /*
       * 分隔號不算數。
       *
       * 畫面上的對方帳號是切過的（`013-00000095503-32784`），而資料庫裡
       * 存的是 `013-0000009550332784` —— **使用者複製畫面上看到的去搜就搜不到**,
       * 而那時他會以為那筆不見了,不會想到是分隔號的問題。
       *
       * 先比原文（日期那種帶 `-` 的照舊），比不到再兩邊都拿掉分隔號比一次。
       */
      const flat = q.replace(/-/g, '');
      if (!hay.includes(q) && !hay.replace(/-/g, '').includes(flat)
        && !String(amt).includes(q.replace(/,/g, ''))) return false;
    }
    return true;
  });
}

/** 篩選列上有沒有任何條件 —— 收合時要顯示「正在篩」的提示。 */
export function hasFilter(f: BankFilter): boolean {
  return Boolean(
    f.from || f.to || f.dir || f.min !== '' && f.min != null || f.max !== '' && f.max != null ||
    (f.q ?? '').trim() || f.onlyNoted,
  );
}

/** 篩出來這幾筆的支出／存入合計。 */
export function sumRows(rows: BankRow[]): { debit: number; credit: number } {
  return rows.reduce(
    (a, r) => ({ debit: a.debit + (Number(r.debit) || 0), credit: a.credit + (Number(r.credit) || 0) }),
    { debit: 0, credit: 0 },
  );
}

/**
 * 帳號切出末五碼：`20992000170564` → `209920001-70564`。
 *
 * ============================================================
 * 【為什麼要切】（2026-08-19 使用者指定）
 *
 * 三個帳戶只有末五碼分得出來（70564 / 24145 / 48088），
 * 而 14 位數連在一起時眼睛得逐字比對。加一個分隔號就一眼認得出。
 *
 * **不是遮罩** —— 數字一個都沒少，只是斷開。
 *
 * 位置跟著長度走，不寫死前面幾碼:24145 那個帳戶是 21762 開頭的
 * 另一個號碼系列，將來換銀行長度也會不同。
 */
export function splitTail(no: string | null | undefined, tail = 5): string {
  const s = (no ?? '').replace(/\D/g, '');
  if (!s || s.length <= tail) return s;
  return s.slice(0, -tail) + '-' + s.slice(-tail);
}

/**
 * 對方帳號切出末五碼：`013-0000009550332784` → `013-00000095503-32784`。
 *
 * ============================================================
 * 【為什麼不能直接套 splitTail】（2026-08-19 使用者反映「沒有末五碼切出來」）
 *
 * splitTail 會先把非數字全部去掉 —— 對方帳號前面那三碼是**銀行代號**
 * （013 國泰世華、007 第一銀行、012 台北富邦），跟帳號黏起來之後
 * 會變成 `0130000009550-332784`，切點整個跑掉，而且從此看不出是哪家銀行。
 *
 * 所以第一個 `-` 前面原樣保留，只切後面那段。
 *
 * 沒有代號的（`0021762000024117` 這種）就整串切，
 * 結果 `00217620000-24117` 跟我們自己的帳戶長得一樣 —— 那是刻意的，
 * 對帳時兩邊格式一致才比得動。
 *
 * ★ **一個數字都不會少**，只是斷開。跟 splitTail 同一條規矩。
 */
export function splitRef(ref: string | null | undefined, tail = 5): string {
  const s = (ref ?? '').trim();
  if (!s) return '';
  const i = s.indexOf('-');
  // 代號後面沒東西（`013-`）就原樣回去 —— 硬切會切出一個空段
  if (i < 0) return splitTail(s, tail) || s;
  const head = s.slice(0, i);
  const body = splitTail(s.slice(i + 1), tail);
  return body ? `${head}-${body}` : s;
}
