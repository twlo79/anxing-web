/**
 * 發票「哪些月份要開」—— 基本清單、例外（不開／額外）、狀態。（migration_307，2026-10-01）
 *
 * ============================================================
 * 【為什麼要有這一支】
 *
 * 2026-10-01 之前：首頁的待開清單以「月」提醒、收租視窗的開發票以「期」開。
 * 年繳約每月被提醒一次，但只能開一張（掛第一個月）—— 其餘 11 個月永遠逾期，
 * 而且畫面上沒有任何一顆鈕可以開它們。使用者：「一期是年但依照月開發票要怎麼存？」
 *
 * 現在：契約有「怎麼開」（`invoice_every`：month／period），
 * 兩個地方都走這一支算出同一份清單。
 *
 * ============================================================
 * 【三件事分三層，互不碰】
 *
 *   基本清單  照租期與 invoice_every **算出來**，不存。租期改了自己跟著變。
 *   例外      `contract_invoice_adjust`：skip（這個月不開）、extra（額外加一張）。
 *   已開      `invoices`。★★★ 這一支只「讀」它來標已開，**永遠不改它**（使用者 2026-10-01：已經寫進去的不要動到）。
 *
 * ============================================================
 * 【月份怎麼切】
 *
 * 照契約起租日切，不是自然月：8/17 起租 → 8/17、9/17 … 到 end_date 為止。
 * 8/17～8/16 的約是 12 個月，用「碰到的自然月」會數成 13。
 * 這跟 migration_306 的固定加費、298 的月租單同一條線 —— 三者的 ym 才對得上。
 */

export type InvoiceEvery = 'month' | 'period';
export type Cadence = 'monthly' | 'quarterly' | 'halfyear' | 'yearly' | string;

export type PlanContract = {
  start_date: string | null;
  end_date: string | null;
  cadence: Cadence;
  invoice_every?: InvoiceEvery | null;
};

export type InvAdjust = {
  id: string;
  ym: string;
  kind: 'skip' | 'extra';
  amount?: number | null;
  note?: string | null;
};

/** 一列＝一張該開（或不開）的發票 */
export type InvSlot = {
  ym: string;
  /** auto＝規則長的；extra＝手動加的 */
  kind: 'auto' | 'extra';
  /** 應開金額（auto 用算的；extra 用填的） */
  due: number;
  /** 不開（只有 auto 會有） */
  skipped?: boolean;
  skipId?: string;
  skipNote?: string | null;
  /** extra 那一條例外的 id／備註 */
  extraId?: string;
  note?: string | null;
};

const CAD_STEP: Record<string, number> = { monthly: 1, quarterly: 3, halfyear: 6, yearly: 12 };
export const cadenceStepOf = (c: Cadence): number => CAD_STEP[c] ?? 1;

const pad = (n: number) => String(n).padStart(2, '0');
const ymOfDate = (d: Date) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}`;

/**
 * 加一個月，日期超過那個月的天數就夾到月底 —— 跟 Postgres 的 `+ interval '1 month'` 一樣
 * （1/31 → 2/28）。累加的話會往前漂（2/28 → 3/28），Postgres 也一樣漂，所以兩邊對得上。
 */
function addMonthClamped(d: Date): Date {
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1, day = d.getUTCDate();
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();   // 下個月有幾天
  return new Date(Date.UTC(y, m, Math.min(day, last)));
}

/**
 * 租期裡每一個「月」的起日對應的 ym，照起租日切；end_date 含當日。
 * 8/17～8/16 → 202608 … 202707（12 個）。沒租期回空陣列。
 */
export function leaseMonthStarts(start: string | null, end: string | null): string[] {
  if (!start || !end) return [];
  const s = new Date(`${start}T00:00:00Z`);
  const e = new Date(`${end}T00:00:00Z`);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime()) || e < s) return [];
  const leaseEnd = new Date(e.getTime() + 86400_000);   // 排他
  const out: string[] = [];
  let cur = s;
  for (let i = 0; cur < leaseEnd && i < 600; i++) {
    out.push(ymOfDate(cur));
    cur = addMonthClamped(cur);
  }
  return out;
}

/** 基本清單的月份：每月開 ＝ 每個月；一期一張 ＝ 每期第一個月 */
export function baseInvoiceYms(c: PlanContract): string[] {
  const months = leaseMonthStarts(c.start_date, c.end_date);
  if ((c.invoice_every ?? 'month') === 'month') return months;
  const step = cadenceStepOf(c.cadence);
  return months.filter((_, i) => i % step === 0);
}

/**
 * 基本清單 ＋ 例外 → 一列一張。
 * @param dueOf 這個月的應開金額（每月開＝那月月租單＋固定加費；一期一張＝整期應收）
 */
export function buildInvoiceSlots(
  c: PlanContract, adjusts: readonly InvAdjust[], dueOf: (ym: string) => number,
): InvSlot[] {
  const skips = new Map(adjusts.filter((a) => a.kind === 'skip').map((a) => [a.ym, a]));
  const slots: InvSlot[] = baseInvoiceYms(c).map((ym) => {
    const sk = skips.get(ym);
    return { ym, kind: 'auto', due: dueOf(ym), skipped: !!sk, skipId: sk?.id, skipNote: sk?.note ?? null };
  });
  for (const a of adjusts) {
    if (a.kind !== 'extra') continue;
    slots.push({ ym: a.ym, kind: 'extra', due: Number(a.amount) || 0, extraId: a.id, note: a.note ?? null });
  }
  // 同一個月 auto 在前、extra 在後 —— 已開的發票照這個順序配
  return slots.sort((x, y) => (x.ym < y.ym ? -1 : x.ym > y.ym ? 1 : x.kind === y.kind ? 0 : x.kind === 'auto' ? -1 : 1));
}

export type IssuedLike = { id: string; ym: string; invoice_no?: string | null; amount?: number | null; invoice_date?: string | null };

/**
 * 把已開的發票配到列上：同一個月有幾張就配前幾列（auto 先、extra 後）。
 * ★ 只讀 invoices，不改。多出來的發票（比列還多）掛在那個月最後一列的 `more` 裡，不會消失。
 */
export function attachIssued<T extends InvSlot>(
  slots: T[], issued: readonly IssuedLike[],
): (T & { invoice?: IssuedLike; more?: IssuedLike[] })[] {
  const byYm = new Map<string, IssuedLike[]>();
  for (const v of issued) byYm.set(v.ym, [...(byYm.get(v.ym) ?? []), v]);
  const out = slots.map((s) => ({ ...s }) as T & { invoice?: IssuedLike; more?: IssuedLike[] });
  for (const [ym, list] of byYm) {
    const mine = out.filter((s) => s.ym === ym && !s.skipped);
    list.forEach((v, i) => {
      if (i < mine.length) mine[i].invoice = v;
      else if (mine.length) (mine[mine.length - 1].more ??= []).push(v);
      else {
        // 這個月沒有列（例如被標不開、或規則是一期一張）—— 發票照樣要看得到
        out.push({ ym, kind: 'auto', due: 0, invoice: v } as T & { invoice?: IssuedLike });
      }
    });
  }
  return out.sort((x, y) => (x.ym < y.ym ? -1 : x.ym > y.ym ? 1 : 0));
}

export type SlotStatus = 'issued' | 'skipped' | 'overdue' | 'due' | 'future' | 'before';

/**
 * 一列的狀態。
 *   before   起算月之前 → 不列、不算
 *   future   還沒到的月份 → 收起來
 *   overdue  月份過了，或本月已過開票日
 *   due      本月、還沒過開票日（或沒填開票日）
 * 沒有「尚未入帳」—— 收費後開拿掉了（2026-10-01）。
 */
export function slotStatus(
  s: { ym: string; skipped?: boolean; invoice?: unknown },
  opts: { fromYm: string; curYm: string; todayDay: number; invoiceDay?: number | null },
): SlotStatus {
  if (s.invoice) return 'issued';
  if (s.skipped) return 'skipped';
  if (s.ym < opts.fromYm) return 'before';
  if (s.ym > opts.curYm) return 'future';
  if (s.ym < opts.curYm) return 'overdue';
  if (opts.invoiceDay && opts.todayDay > opts.invoiceDay) return 'overdue';
  return 'due';
}

/** 下拉第二個選項的字跟著繳別：年繳「每年開」、季繳「每季開」 */
export function invoiceEveryLabel(cadence: Cadence): string {
  return cadence === 'yearly' ? '每年開' : cadence === 'quarterly' ? '每季開' : cadence === 'halfyear' ? '每半年開' : '每月開';
}
export function invoiceEveryOptions(cadence: Cadence): { value: InvoiceEvery; label: string }[] {
  return [{ value: 'month', label: '每月開' }, { value: 'period', label: invoiceEveryLabel(cadence) }];
}

/** 一句話講這張契約怎麼開（契約卡片、收租視窗頂端用） */
export function invoiceEveryText(c: { cadence: Cadence; invoice_every?: InvoiceEvery | null }): string {
  if ((c.invoice_every ?? 'month') === 'month' || cadenceStepOf(c.cadence) === 1) return '每月開';
  return invoiceEveryLabel(c.cadence);
}
