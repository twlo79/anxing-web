/**
 * 關帳（純函式）。
 *
 * ============================================================
 * 【規則】（2026-09-07 使用者逐項確認）
 *
 *   判定    `orders.checkout` 落在哪個月
 *   範圍    **只鎖短租訂單**。契約產的月租單放行
 *   時機    每月 5 號自動關上個月；會計也可以手動關／開
 *   鎖什麼  整張訂單改不動、刪不掉。收款、支出、押金不鎖
 *
 * 資料庫那一半在 `migration_223`（觸發器 ＋ `close_due_periods()`）。
 * 這一支是**畫面要用的同一套判斷** —— 讓使用者在按下去之前就知道
 * 會被擋，而不是送出之後收到一句 SQL 例外。
 *
 * ★★ 兩邊都要有，但**資料庫那一邊才是真的**。
 *   前端這一份是為了「早一點講」，不是為了取代守門 ——
 *   前端擋不住的東西（別的分頁、API、SQL）還是要撞到觸發器。
 */

/** 六碼 `YYYYMM`。跟全站的 `Ym` 同一種格式 —— 不要另外發明一種 */
export type Ym = string;

/** 每個月幾號自動關上個月（使用者指定 5 號）。 */
export const CLOSE_DAY = 5;

const pad = (n: number) => String(n).padStart(2, '0');

/** `2026-08-20` → `202608`。空的或格式不對回空字串 */
export function ymOf(dateStr: string | null | undefined): Ym {
  const d = (dateStr ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}/.test(d) ? d.slice(0, 4) + d.slice(5, 7) : '';
}

/** `202608` → `2026-08`。給畫面用 */
export function ymLabel(ym: Ym): string {
  return /^\d{6}$/.test(ym ?? '') ? `${ym.slice(0, 4)}-${ym.slice(4, 6)}` : '—';
}

/** 上一個月。`202601` → `202512` */
export function prevYm(ym: Ym): Ym {
  if (!/^\d{6}$/.test(ym ?? '')) return '';
  const y = Number(ym.slice(0, 4));
  const m = Number(ym.slice(4, 6));
  return m === 1 ? `${y - 1}12` : `${y}${pad(m - 1)}`;
}

/** 下一個月。`202612` → `202701` */
export function nextYm(ym: Ym): Ym {
  if (!/^\d{6}$/.test(ym ?? '')) return '';
  const y = Number(ym.slice(0, 4));
  const m = Number(ym.slice(4, 6));
  return m === 12 ? `${y + 1}01` : `${y}${pad(m + 1)}`;
}

/**
 * 這個月會在**哪個月的 5 號**被自動關。
 *
 * ★ 就是下一個月 —— 八月的帳 9/5 關。
 *   畫面上要講出來，不然使用者不知道「未關」還要等多久。
 */
export const nextCloseYm = (ym: Ym): Ym => nextYm(ym);

/** 從一個日期算出「上個月」的 ym。`2026-09-07` → `202608` */
export function prevYmOf(today: string): Ym {
  return prevYm(ymOf(today));
}

/** 一張訂單（只取判定要用的欄位）。 */
export type OrderLike = {
  checkout?: string | null;
  /** `'contract'` = 契約產的月租單 —— **不鎖** */
  imported_via?: string | null;
};

/**
 * 這張訂單**會不會**被關帳鎖到（不看那個月關了沒）。
 *
 * ★ 月租單永遠回 false。它會隨契約重算 —— 鎖了的話
 *   「改契約金額」會在舊月份上失敗，而訊息跟契約完全無關。
 */
export function lockable(o: OrderLike): boolean {
  return (o.imported_via ?? '') !== 'contract' && !!ymOf(o.checkout);
}

/**
 * 這張訂單現在改不改得動。
 *
 * @param lockedYms 已關帳的月份
 */
export function isLocked(o: OrderLike, lockedYms: Iterable<Ym>): boolean {
  if (!lockable(o)) return false;
  return new Set(lockedYms).has(ymOf(o.checkout));
}

/**
 * 擋阻訊息。`null` = 可以改。
 *
 * ★ 要講**哪個月**跟**去哪裡開** —— 只說「已關帳」的話，
 *   使用者知道被擋了但不知道下一步該做什麼
 *   （CLAUDE.md:訊息要出現在動作發生的地方，而且要能行動）。
 */
export function lockedMsg(o: OrderLike, lockedYms: Iterable<Ym>): string | null {
  if (!isLocked(o, lockedYms)) return null;
  return `${ymLabel(ymOf(o.checkout))} 已經關帳，這張訂單改不動。`
    + '要改的話請到權限管理 → 關帳，把那個月打開。';
}

/**
 * 排程今天該不該關上個月 —— 跟 `close_due_periods()` 同一套判斷。
 *
 * ★★ **被人手動打開過的不自動關回去**。不然會計打開七月正在改，
 *   隔天清晨又被鎖起來 —— 而他不會知道是排程做的，只會覺得系統壞了。
 *   他改完自己關（那時 `auto` 是 false）。
 */
export type LockRow = {
  ym: Ym;
  locked: boolean;
  auto?: boolean;
  locked_at?: string | null;
  reopened_at?: string | null;
};

export function autoCloseDecision(
  today: string, rows: LockRow[],
): { ym: Ym; close: boolean; why: string } {
  const ym = prevYmOf(today);
  const day = Number((today ?? '').slice(8, 10));
  if (!ym) return { ym: '', close: false, why: '日期看不懂' };
  if (day < CLOSE_DAY) return { ym, close: false, why: `還沒到 ${CLOSE_DAY} 號，不關` };

  const row = (rows ?? []).find((r) => r.ym === ym);
  if (row?.locked) return { ym, close: false, why: '已經關過了' };
  if (row && !row.locked && row.reopened_at) {
    return { ym, close: false, why: '被手動打開過，不自動關回去' };
  }
  return { ym, close: true, why: '該關了' };
}

/**
 * 畫面上要列出來的月份（由新到舊）。
 *
 * ★ 含**這個月** —— 使用者可能提早結完想馬上鎖起來。
 *   只列已經過去的月份的話，那個需求就沒有入口。
 */
export function ymOptions(today: string, back = 12): Ym[] {
  const out: Ym[] = [];
  let ym = ymOf(today);
  for (let i = 0; i <= back && ym; i++) { out.push(ym); ym = prevYm(ym); }
  return out;
}

/**
 * 重新打開之前要讓人看到的一句話。
 *
 * ★★ 打開的代價要講:那個月的數字會**再度可以改動**，
 *   而報表、儀錶板、稅務申報可能已經拿它出去用過了。
 */
export function reopenConfirm(ym: Ym, orderCount: number): string {
  return `把 ${ymLabel(ym)} 重新打開？\n\n`
    + `那個月有 ${orderCount} 張短租訂單會變成可以改。\n\n`
    + '★ 如果這個月的數字已經報過稅或給過老闆，改動之後兩邊就對不起來了。\n'
    + '　 改完記得回來關回去 —— 排程**不會**幫你自動關回去。';
}

/** 關帳前的確認。★ 講清楚不是永久的 —— 不然使用者不敢按 */
export function closeConfirm(ym: Ym, orderCount: number): string {
  return `關 ${ymLabel(ym)} 的帳？\n\n`
    + `那個月有 ${orderCount} 張短租訂單會被鎖住，改不動也刪不掉。\n\n`
    + '★ 契約的月租單不受影響。\n'
    + '★ 隨時可以再打開 —— 這不是永久的。';
}

/**
 * 同步被擋下來的那一筆，畫面上怎麼講。
 *
 * @param changes `{欄位: [舊值, 新值]}`，或刪除時的 `{_刪除: 整列}`
 */
export const FIELD_LABEL: Record<string, string> = {
  amount: '金額', checkin: '入住', checkout: '退房', nights: '晚數',
  guest_name: '客人', paid: '收款', paid_at: '收款日', property_raw: '房源',
  deposit: '押金', note: '備註', source: '來源',
};

export function pendingLines(changes: Record<string, unknown>): string[] {
  const c = changes ?? {};
  if ('_刪除' in c) return ['同步想**刪掉**這張訂單'];
  return Object.entries(c)
    .filter(([, v]) => Array.isArray(v) && v.length === 2)
    .map(([k, v]) => {
      const [a, b] = v as [unknown, unknown];
      const show = (x: unknown) => (x === null || x === undefined || x === '' ? '（空）' : String(x));
      return `${FIELD_LABEL[k] ?? k}　${show(a)} → ${show(b)}`;
    });
}
