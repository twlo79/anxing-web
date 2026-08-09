/**
 * 契約每一期「實際要跟房客收多少」。
 *
 * ============================================================
 * 【一期的錢散在三種訂單裡】
 *
 *   月租單      source='longterm'，key LT_{room}_{YYYYMM}，由契約觸發器產生
 *   固定加費    source='oneoff'，imported_via='contract_fee'，key CRC_…
 *               管理費、停車費、設備費 —— 設定一次每期自動長出來
 *   一次性費用  source='oneoff'，imported_via='manual'，key CFEE_…
 *               臨時的電費、修繕費，手動加的
 *   折讓        同上但金額是負數，fee_type='折讓'
 *
 * 使用者要的是**一個應收數字**：房租 ＋ 固定加費 ＋ 一次性費用 − 折讓，
 * 收款按一次全部收齊。
 *
 *
 * ============================================================
 * 【改版前的不一致 —— 這支存在的理由】
 *
 * 應收顯示的是「租金 + 所有加費 − 折讓」，但「確認收款」只標記
 * 月租單與固定加費，**手動加費不碰**（原本的註解寫「那是臨時發生的，
 * 收款時機不一定跟租金同一天」）。
 *
 * 結果是：畫面說這期要收 $113,500，按下確認、整期變綠，
 * 而資料庫裡那筆 $1,500 的電費仍然是未收 —— 判斷「收齊了沒」也沒算它。
 * 那筆錢會靜靜地留在未收清單裡，而畫面上這一期看起來已經結清。
 *
 * 現在統一：**應收算誰，收款就收誰，收齊判斷也看誰**。三個口徑一致。
 */

export type PeriodOrder = {
  id?: string;
  amount: number | null;
  paid?: boolean | null;
  /** 'contract_fee' 固定加費 / 'manual' 手動加費 */
  imported_via?: string | null;
  fee_type?: string | null;
  item_name?: string | null;
};

export type LineKind = 'rent' | 'fixed' | 'oneoff' | 'discount';

export type PeriodLine = {
  kind: LineKind;
  label: string;
  amount: number;
  paid: boolean;
  /** 折讓在畫面上顯示成負數 */
  negative?: boolean;
};

export type PeriodTotal = {
  lines: PeriodLine[];
  rent: number;
  fixed: number;
  oneoff: number;
  discount: number;
  /** 實際要收的淨額 */
  net: number;
  /** 全部都收了（含每一筆加費） */
  allPaid: boolean;
};

const num = (v: unknown) => Math.round(Number(v) || 0);

export const KIND_LABEL: Record<LineKind, string> = {
  rent: '房租', fixed: '固定加費', oneoff: '一次性費用', discount: '折讓',
};

/**
 * 加費那一列要顯示什麼名字。
 *
 * fee_type 是會計科目（管理費、設備費），item_name 是細目（冰箱、洗烘衣機）。
 * 只顯示科目的話，三筆設備費會變成三行一模一樣的「設備費」，
 * 對帳時分不出是冰箱還是電視。
 */
export function feeLabel(o: PeriodOrder): string {
  const t = (o.fee_type ?? '').trim() || '加費';
  const i = (o.item_name ?? '').trim();
  return i ? `${t}－${i}` : t;
}

/**
 * 把一期的月租單與加費整理成明細 + 合計。
 *
 * @param rentOrders 這一期的月租單（季繳會有 3 張）
 * @param feeOrders  這一期的加費與折讓（正負都給進來）
 */
export function periodTotal(rentOrders: PeriodOrder[], feeOrders: PeriodOrder[]): PeriodTotal {
  const rents = rentOrders ?? [];
  const fees = feeOrders ?? [];

  const rent = rents.reduce((a, o) => a + num(o.amount), 0);
  const lines: PeriodLine[] = [];

  /*
   * 月租單就算有好幾張（季繳 3 張）也只列一行。
   * 逐月列出來的話，年繳會變成 12 行一模一樣的房租，
   * 而使用者要看的是「這一期房租多少」，不是「哪一個月」。
   */
  if (rents.length) {
    lines.push({
      kind: 'rent', label: KIND_LABEL.rent, amount: rent,
      paid: rents.every((o) => !!o.paid),
    });
  }

  let fixed = 0, oneoff = 0, discount = 0;
  for (const f of fees) {
    const amt = num(f.amount);
    if (amt === 0) continue;
    if (amt < 0) {
      discount += Math.abs(amt);
      lines.push({
        kind: 'discount', label: feeLabel(f), amount: Math.abs(amt),
        paid: !!f.paid, negative: true,
      });
      continue;
    }
    const isFixed = f.imported_via === 'contract_fee';
    if (isFixed) fixed += amt; else oneoff += amt;
    lines.push({
      kind: isFixed ? 'fixed' : 'oneoff', label: feeLabel(f), amount: amt, paid: !!f.paid,
    });
  }

  // 排序：房租 → 固定加費 → 一次性 → 折讓。折讓永遠在最後,因為它是減項。
  const order: Record<LineKind, number> = { rent: 0, fixed: 1, oneoff: 2, discount: 3 };
  lines.sort((a, b) => order[a.kind] - order[b.kind]);

  return {
    lines, rent, fixed, oneoff, discount,
    net: rent + fixed + oneoff - discount,
    /*
     * 收齊 = **每一行都收了**，包含手動加的一次性費用。
     *
     * 改版前這裡只看月租單與固定加費 —— 手動加費沒收也算整期結清，
     * 那筆錢就靜靜留在未收清單裡而畫面是綠的。
     */
    allPaid: lines.length > 0 && lines.every((l) => l.paid),
  };
}

/*
 * 這裡曾經有一支 confirmText()，把算式排成純文字餵給瀏覽器的 confirm()。
 *
 * 拿掉了，因為**那樣的金額永遠對不齊**：confirm() 用系統的比例字型，
 * 中文佔兩倍寬、數字一倍寬，而 padEnd() 是按字元數補空白的 ——
 * 「設備費－冰箱」那一行必定往左凸出來。
 *
 * 換成頁面自己畫的視窗（contracts 頁的 payAsk），用 <table> 右對齊 +
 * tabular-nums，金額的個位數必定切齊。要對齊就不能用 confirm()。
 */
