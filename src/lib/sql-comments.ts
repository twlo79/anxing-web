/**
 * 檢查 .sql 檔的區塊註解有沒有平衡。
 *
 * ============================================================
 * 【為什麼需要這個】（2026-08-24，migration_171 貼進去就炸）
 *
 *     ERROR: 42601: unterminated /* comment at or near "…"
 *     LINE 106: /*
 *
 * 原因是 **Postgres 的區塊註解可以巢狀**:
 *
 *     /* 外層  /* 內層 *\/  還在註解裡 *\/
 *
 * 而我在註解裡寫了 Markdown 的粗體:
 *
 *     *   **只有 pr/** —— exp/ dep/ dp/ 不在裡面
 *                 ^^^
 *                 pr 後面的斜線,碰上粗體的第一個星號 = `/*`
 *
 * 於是那裡開了一層巢狀註解，我的 `*\/` 只關掉內層，外層一路吃到檔尾。
 *
 *
 * ============================================================
 * 【為什麼要自動擋 —— 這個錯的代價不成比例】
 *
 * SQL Editor 把整份腳本包在一個交易裡，parse 失敗就**整份不執行**。
 *
 * 掃過 144 份 migration，中招的有兩份:171（當下就報錯）
 * 與 **158**（訂單加費憑證）。而 158 是三天前「跑過」的 ——
 * 它其實從來沒跑成功過，所以:
 *
 *   · `can_see_receipt` 一直沒有 `of/` 分支（實際查線上定義證實了）
 *   · 管家傳得上加費憑證，卻看不到自己剛傳的照片
 *
 * **一個註解裡的星號，讓一個功能沉默地壞了三天。**
 * 這正是 README 9.6 說的:這個專案的錯誤幾乎都是安靜的。
 *
 * 人不可能每次都記得「前綴後面不要接兩個星號」，所以讓測試記得。
 *
 *
 * ============================================================
 * 【這個掃描是粗略的，而且刻意如此】
 *
 * 沒有處理字串常值與 dollar-quoting 裡的 `/*`
 * （例如 `select '/*'` 會被誤判）。
 *
 * 要精確就得寫一個 SQL lexer —— 而那個 lexer 自己會有 bug，
 * 到時候要查的是 lexer 不是 migration。
 *
 * 誤判的代價是「測試紅了，去看一眼發現是假警報」；
 * 漏判的代價是「功能安靜壞掉三天」。兩邊不對等，所以選寧可誤判。
 */

export type CommentIssue = {
  /** 正數 = 有幾層沒關；負數 = 多關了幾次 */
  depth: number;
  /** 沒關起來的那幾層開在第幾行 */
  openLines: number[];
};

/**
 * 掃一份 SQL 的區塊註解。
 * 回 null 表示平衡（沒問題）。
 */
export function checkBlockComments(sql: string): CommentIssue | null {
  let depth = 0;
  let line = 1;
  const openLines: number[] = [];

  for (let i = 0; i < sql.length; ) {
    if (sql[i] === '\n') { line++; i++; continue; }
    const two = sql.slice(i, i + 2);
    if (two === '/*') { depth++; openLines.push(line); i += 2; continue; }
    if (two === '*/') { depth--; openLines.pop(); i += 2; continue; }
    i++;
  }

  return depth === 0 ? null : { depth, openLines };
}

/**
 * 這一行有沒有「文字裡不小心組出 `/*`」的風險。
 *
 * ★ 只看**不是**行首的 `/*`。真正要寫註解的人會把 `/*` 放在行首；
 *   出現在句子中間的幾乎都是意外 —— 通常是 `xxx/` 後面接 Markdown 粗體。
 */
export function riskyCommentOpeners(lineText: string): number[] {
  const out: number[] = [];
  const indent = lineText.length - lineText.trimStart().length;
  for (let i = 0; i < lineText.length - 1; i++) {
    if (lineText[i] === '/' && lineText[i + 1] === '*') {
      if (i === indent) continue;   // 行首的 /* 是刻意的
      out.push(i);
    }
  }
  return out;
}

/**
 * CTE 清單尾端多了逗號，後面卻直接接 DML。
 *
 * ============================================================
 * 【為什麼加這一支】（2026-08-24，migration_173 第二次貼進去就炸）
 *
 *     ERROR: 42601: syntax error at or near "into"
 *     LINE 148: insert into _chk173
 *
 * 我原本寫了三個 CTE:
 *
 *     with fix_orders as (…),
 *          fix_contracts as (…),
 *          fix_customers as (…)
 *     insert into _chk173 select …
 *
 * 後來拿掉 `fix_customers`（那張表不能直接改），**忘了拿掉前面的逗號**:
 *
 *     with fix_orders as (…),
 *          fix_contracts as (…),      ← 這個逗號說「還有下一個」
 *     insert into _chk173 select …    ← 但下一個是 DML
 *
 * 中間隔著十幾行註解，所以看起來很正常。
 *
 * 這跟註解巢狀是同一類問題:**貼進 SQL Editor 才發現，而整份不執行**。
 * 兩次都是使用者幫我測出來的 —— 那不該是使用者的工作。
 */
export function danglingCteComma(sql: string): number[] {
  const lines: number[] = [];
  /*
   * `)` ＋ 逗號 ＋（只有空白與註解）＋ DML 關鍵字。
   *
   * ★ 只認 DML 關鍵字，不是「任何東西」——
   *   `values (1,2),\n(3,4)` 那種 `),` 後面接的是括號，不會誤報。
   */
  const re = /\)\s*,(?:\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)*\s*\b(insert|update|delete|select)\b/gi;
  for (const m of sql.matchAll(re)) {
    lines.push(sql.slice(0, m.index).split('\n').length);
  }
  return lines;
}
