/**
 * 契約生命週期：結束租約 vs 刪除契約。
 *
 * 【為什麼需要這一支】
 * migration_81 之後 orders.contract_id 是 on delete cascade ——
 * 刪一張契約會連同它所有的月租單（含已收款）、加費、續約，
 * 以及底下的營收認列一起消失，而且不可逆。
 *
 * 在那之前，畫面上的刪除只有一句「刪除契約「X Y」?」。
 * 那句話沒有告訴任何人他正要銷毀四年的收款紀錄。
 *
 * 這裡的規則：
 *
 *   租約結束  → 結束租約（設迄日 + 停用）。已收款的月份原封不動留著。
 *   建錯了    → 刪除。沒收過款的一句確認就好,那才是正常路徑。
 *   有已收款  → 還是可以刪,但要看到數字,而且要打字確認。
 *
 * 不擋 —— 使用者決定要刪就刪得掉。只是不能在不知情的狀況下刪掉。
 */

export type OrderLite = {
  id: string;
  order_key: string;
  checkin: string;
  amount: number | null;
  paid: boolean;
  imported_via: string | null;
};

export type Bucket = { n: number; amt: number; paidN: number; paidAmt: number };
export type Impact = {
  monthly: Bucket;          // imported_via='contract' 自動產生的月租單
  extra: Bucket;            // 加費(manual)、續約(extend)、其他
  total: Bucket;
  from: string | null;      // 最早月份
  to: string | null;        // 最晚月份
};

const empty = (): Bucket => ({ n: 0, amt: 0, paidN: 0, paidAmt: 0 });

function add(b: Bucket, o: OrderLite) {
  const a = Number(o.amount || 0);
  b.n += 1; b.amt += a;
  if (o.paid) { b.paidN += 1; b.paidAmt += a; }
}

/** 把一張契約底下的訂單整理成「刪掉會失去什麼」。 */
export function summarize(rows: OrderLite[]): Impact {
  const im: Impact = { monthly: empty(), extra: empty(), total: empty(), from: null, to: null };
  for (const o of rows) {
    add(o.imported_via === 'contract' ? im.monthly : im.extra, o);
    add(im.total, o);
    if (o.checkin) {
      if (!im.from || o.checkin < im.from) im.from = o.checkin;
      if (!im.to || o.checkin > im.to) im.to = o.checkin;
    }
  }
  return im;
}

/**
 * 有收過款就要打字確認。
 *
 * 「收過款」是這張契約真的發生過的證據 —— 建錯的契約不會有收款紀錄。
 * 所以這條線剛好把「建錯了」跟「歷史」分開,不需要使用者自己判斷。
 */
export const needsTypedConfirm = (im: Impact) => im.total.paidN > 0;

const money = (n: number) => Math.round(n).toLocaleString('en-US');
const ym = (d: string | null) => (d ? `${d.slice(0, 4)}-${d.slice(5, 7)}` : '—');

/**
 * 刪除確認的內文。
 *
 * 重點是**數字**,不是警語。「刪除契約?」跟「38 筆已收款 $47,500 將消失」
 * 是兩件事 —— 看到後者才會停下來想。
 */
export function deleteConfirmText(name: string, im: Impact): string {
  const L: string[] = [`刪除契約「${name}」?`, ''];

  if (im.total.n === 0) {
    L.push('這張契約底下沒有任何訂單,可以安全刪除。');
    return L.join('\n');
  }

  L.push('將一併永久刪除:');
  if (im.monthly.n) {
    L.push(`  月租單 ${im.monthly.n} 筆`
      + (im.monthly.paidN ? `（已收款 ${im.monthly.paidN} 筆,$${money(im.monthly.paidAmt)}）` : '（皆未收款）'));
  }
  if (im.extra.n) {
    L.push(`  加費／續約 ${im.extra.n} 筆`
      + (im.extra.paidN ? `（已收款 ${im.extra.paidN} 筆,$${money(im.extra.paidAmt)}）` : '（皆未收款）'));
  }
  L.push(`  營收認列 $${money(im.total.amt)}`);
  L.push(`  期間 ${ym(im.from)} ～ ${ym(im.to)}`);
  L.push('');

  if (im.total.paidN > 0) {
    L.push(`⚠ 其中 ${im.total.paidN} 筆是「已收款」——那是真的收進來的錢。`);
    L.push('刪除後這些收款紀錄與對應營收都會消失,無法復原。');
    L.push('');
    L.push('若只是租約結束,請關掉這個視窗,改用「結束租約」。');
  } else {
    L.push('此操作無法復原。');
  }
  return L.join('\n');
}

/** 打字確認的提示。要求輸入契約名稱,手滑按不到。 */
export function typedConfirmPrompt(name: string, im: Impact): string {
  return `確認刪除:請輸入契約名稱「${name}」\n\n`
    + `（${im.total.paidN} 筆已收款、$${money(im.total.paidAmt)} 將永久消失）`;
}

/**
 * 租期外但已收款的月租單。
 *
 * 【為什麼要抓這個】
 * gen_contract_orders 清租期外的列時只刪未收款的 —— 錢收了就是既成事實,
 * 不該因為有人改了一個日期就從帳上消失。
 *
 * 代價是:如果那筆其實是「誤標成已收款」,縮短租期之後它會留在營收裡,
 * 而畫面上契約已經看不到那個月了 —— 又是一種看不見的殘留。
 *
 * 所以改完租期要主動把這種列指出來,讓人自己判斷是真的收過還是標錯。
 *
 * end 是「租期迄」,語意跟 gen_contract_orders 一致:checkin >= end 就算租期外。
 */
export function strayPaid(rows: OrderLite[], start: string | null, end: string | null): OrderLite[] {
  return rows.filter((o) => {
    if (!o.paid || o.imported_via !== 'contract' || !o.checkin) return false;
    if (start && o.checkin < monthStart(start)) return true;
    if (end && o.checkin >= end) return true;
    return false;
  });
}

/** 'YYYY-MM-DD' → 當月一號。契約是按月產生的,起日在月中也要含整個月。 */
export function monthStart(d: string): string {
  return `${d.slice(0, 7)}-01`;
}

/**
 * 結束租約時，會被清掉的是哪幾筆。
 *
 * 實際的刪除由 gen_contract_orders 做（改 end_date 就會觸發），
 * 這裡只是先算出來告訴使用者，免得他按下去才發現少了東西。
 *
 * 條件跟資料庫那邊完全一致:imported_via='contract'、未收款、checkin >= 迄日。
 */
export function endLeaseRemoved(rows: OrderLite[], endDate: string): OrderLite[] {
  return rows.filter((o) =>
    o.imported_via === 'contract' && !o.paid && o.checkin && o.checkin >= endDate);
}

export function endLeaseConfirmText(name: string, endDate: string, removed: OrderLite[]): string {
  const amt = removed.reduce((s, o) => s + Number(o.amount || 0), 0);
  const L = [`結束租約「${name}」?`, '', `租期迄設為 ${endDate},契約改為停用。`, ''];
  if (removed.length) {
    L.push(`會清掉 ${endDate} 之後尚未收款的月租單 ${removed.length} 筆（$${money(amt)}）——`);
    L.push('那些是還沒發生的應收,留著會讓營收預估虛高。');
  } else {
    L.push('沒有需要清掉的未來應收。');
  }
  L.push('');
  L.push('已收款的月份一律保留,歷史不會變動。');
  return L.join('\n');
}
