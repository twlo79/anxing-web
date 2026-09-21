/**
 * 代墊攤還：一筆錢還進來，從最舊的一筆開始扣（2026-09-21 使用者指定）。
 *
 * ============================================================
 * 【為什麼寫在 `.ts` 而不是頁面裡】
 *
 * 測試執行環境不處理 JSX（CLAUDE.md）—— 寫在 `.tsx` 裡的判斷式測不到。
 * 而這裡每一件事都是**錯了不會報錯**的類型：
 *
 *   · 順序排錯     → 扣到不該扣的那一列，兩邊金額都還是對的
 *   · 零頭算錯     → 差一分錢，而那一分會永遠掛在「部分收回」
 *   · 扣超過欠的   → 收回比代墊多，而那已經不是代墊了
 *
 * ============================================================
 * 【★★★ 使用者 2026-09-21 決定的四件事，三件在這裡】
 *
 *   ① 範圍：**勾了就只扣勾起來的那幾列；一列都沒勾就扣全部待收回的**
 *      —— 勾選框本來就是範圍，不用再多一個模式開關。
 *   ② 順序：**舊的先扣**（出款日小的先），同一天照建立時間。
 *   ③ 名字：攤還到一半叫「**部分收回**」，收不回來認賠的叫「**已結清（被扣）**」。
 *
 * ============================================================
 * 【★★★ 同一天再決定的三條「擋住」規則】
 *
 *   ④ **勾了列** → 還款金額必須**剛好等於**勾起來那幾列的欠款總和，
 *      對不上就擋（使用者：「打勾與還款配不上 就擋住」）。
 *   ⑤ 所以逐筆還一定是**整數筆收完**，不會留零頭。
 *   ⑥ **沒勾** → 自己填金額照順序扣，但**不能超過總欠款**，超過就擋。
 *
 * ★★★ 前一版是「只扣到欠的為止，多的跳個提醒」——**改成擋**。
 *   理由:多匯的那筆錢如果被默默吸收，畫面會顯示「已收回」而帳上
 *   少了一筆收入，兩邊都看起來正常。擋住的話人會去查那筆差額是什麼。
 *
 * ★★ 這跟「系統負責看見，人負責決定」不衝突:這裡不是在替人做決定，
 *   是在說「這個數字我算不出對應的分配」。算不出來就不要猜。
 *
 * ★ ③ 是改名，不是加新意思：「部分收回」四個字本來指的是被扣，
 *   而那個意思搬去「已結清（被扣）」了。兩件事不能同名 ——
 *   同一個詞兩個意思，使用者會以為是同一件事（CLAUDE.md 統一用語）。
 *
 * ============================================================
 * 【★★★ 為什麼「還欠多少」不存成欄位】
 *
 * 還欠 ＝ 代墊金額 − 累計已還。它是**算出來的**，存進欄位的話維護它的
 * 只有前端一段程式，第二個寫入者一出現就永遠是錯的而且不會叫
 * （CLAUDE.md：推導值存成欄位，`bank_transactions.balance` 踩過）。
 */

/** 一列待收回的代墊。欄位名跟 `advance_payments` 一致。 */
export type RepayRow = {
  id: string;
  /** 出款日。排序的第一鍵 —— 沒有出款日的列根本不該進到這裡 */
  paid_on?: string | null;
  /** 建立時間。排序的第二鍵 */
  created_at?: string | null;
  amount: number;
  /**
   * **累計已還**，不是「這次還了多少」。
   *
   * ★★★ 2026-09-21 之後這一欄的意思變了:原本是「收回時實際拿回多少」
   *   （一次填完），現在是「到目前為止一共還了多少」（會長大）。
   *   讀它的地方只有這裡跟 `advance.ts` 的 `statusOf` / `forfeitedOf`。
   */
  refunded_amount?: number | null;
  /**
   * **結清日** —— 有值就代表這一列結束了，不再追。
   *
   * ★★ 還在攤的時候這一欄是**空的**，即使已經還了一部分。
   *   這正是「部分收回」與「已結清（被扣）」的分界:
   *   前者差額是**應收**，後者差額是**被扣**（要記成費用）。
   */
  refunded_on?: string | null;
  category?: string | null;
  counterparty?: string | null;
};

/** 收到分。★ 浮點數相減會漂（7350 - 6000.1 會得到 1349.8999999999996）。 */
const cent = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * 這一列還欠多少。
 *
 * ★ 已經結清的回 0 —— 不管還差多少，那筆差額已經是被扣不是應收了。
 */
export function oweOf(a: RepayRow): number {
  if (a.refunded_on != null) return 0;
  return Math.max(0, cent(Number(a.amount) - Number(a.refunded_amount ?? 0)));
}

/** 還收得回來的（還沒結清而且還欠錢）。 */
export const isOpen = (a: RepayRow) => a.refunded_on == null && oweOf(a) > 0;

/**
 * 扣款順序：**舊的先**（2026-09-21 使用者選 A）。
 *
 * ============================================================
 * 【★★★ 為什麼一定要第二、第三個排序鍵】
 *
 * 清單本來只有 `order('paid_on', desc)` —— **沒有第二鍵**。
 * 愛皮 9/09 那批有 7 列同一天，於是它們的順序是 Postgres 隨便給的，
 * **每次重新整理都可能不一樣**。
 *
 * 「從最前面一筆扣」指著一個會變的東西的話，同一筆還款按兩次
 * 會扣到不同的列 —— 而兩次的總額都對，沒有任何地方會叫。
 *
 * ★ 所以排序鍵要一路排到 `id`:三個鍵之後結果唯一，跑幾次都一樣。
 * ★★ 這支的答案**不可以**依賴畫面的排序（畫面是新的在上面）——
 *   畫面怎麼排是顯示的事，扣款順序是規則的事。
 * ============================================================
 */
export function repayOrder<T extends RepayRow>(rows: readonly T[]): T[] {
  return [...(rows ?? [])].sort((x, y) =>
    String(x.paid_on ?? '').localeCompare(String(y.paid_on ?? ''))
    || String(x.created_at ?? '').localeCompare(String(y.created_at ?? ''))
    || String(x.id).localeCompare(String(y.id)));
}

/** 一列被扣了多少。`rest` 是扣完之後還欠的。 */
export type Alloc = {
  id: string;
  /** 扣之前欠多少 */
  owe: number;
  /** 這一次扣掉多少。0 代表這一列這次沒動到 */
  cut: number;
  /** 扣完還欠多少。0 代表這一列這次收完了 */
  rest: number;
};

export type Plan = {
  /** 每一列的結果，**照扣款順序**。沒扣到的列也會在裡面（cut = 0）*/
  lines: Alloc[];
  /** 這些列一共欠多少 */
  owed: number;
  /** 實際會扣掉多少（＝還款金額，除非還的比欠的多）*/
  used: number;
  /** 還的比欠的多出來的部分。> 0 的話要提醒，那已經不是代墊了 */
  over: number;
  /** 這次收完的列數 */
  cleared: number;
};

/**
 * 把一筆錢照順序扣下去。
 *
 * @param rows 範圍內的列（勾了就是勾的那幾列，沒勾就是全部待收回）
 * @param pay  這次還了多少
 *
 * ★★★ 這支**不看勾選**也不看畫面 —— 範圍由呼叫端決定，
 *   它只負責「給我這幾列跟這個數字，算出每一列扣多少」。
 *   混在一起的話「範圍」這條規則就會同時寫在畫面與這裡兩個地方
 *   （CLAUDE.md：同一條規則在三個地方各寫一次）。
 *
 * ★★ 這支**只算不擋**:超過總欠款時它照樣算得出來（多的放進 `over`），
 *   擋的是 `validateRepay()`。分開是為了讓畫面能**先把超額畫出來**
 *   再說不能存 —— 只丟一句「不能存」而不顯示差在哪，人得自己算。
 */
export function allocate(rows: readonly RepayRow[], pay: number): Plan {
  const ordered = repayOrder((rows ?? []).filter(isOpen));
  const owed = cent(ordered.reduce((n, a) => n + oweOf(a), 0));
  const want = Math.max(0, cent(pay));
  /*
   * ★ 這裡**不需要**先夾到 `owed`:下面每一列的 cut 都被自己的 owe 夾住，
   *   所以扣掉的總和本來就不可能超過 owed。
   *   （2026-09-21 原本寫了 `Math.min(want, owed)`，故意拿掉之後
   *     30 條測試全綠 —— 那一行什麼都沒判斷。一段看起來像規則
   *     但其實是死的程式，比不寫更糟。）
   */
  let left = want;

  const lines: Alloc[] = ordered.map((a) => {
    const owe = oweOf(a);
    const cut = cent(Math.min(left, owe));
    left = cent(left - cut);
    return { id: a.id, owe, cut, rest: cent(owe - cut) };
  });

  return {
    lines,
    owed,
    used: cent(Math.min(want, owed)),
    over: cent(Math.max(0, want - owed)),
    cleared: lines.filter((l) => l.cut > 0 && l.rest === 0).length,
  };
}

/* ══════════════════════════════════════════════════════════
 * 存檔前的檢查
 *
 * ★★★ 這幾條之後要跟資料庫那支 RPC **寫成同一組規則**
 *   （像 `validateBatch` 跟 `recover_advances()` 那樣）。
 *   兩邊都寫是刻意的:資料庫那層擋住任何路徑（含手改資料），
 *   這一層負責在**按下去之前**就講出為什麼。
 *
 * ★★ 一次只回一個錯。全部列出來會變成一段文章，而人只看第一行。
 * ══════════════════════════════════════════════════════════ */

export type RepayForm = {
  /** 還款日 */
  on?: string | null;
  /** 還了多少 */
  pay?: number | string | null;
  /** 還入哪個帳戶（安幸的） */
  inAccount?: string | null;
  /** 從哪個帳戶出去的（愛皮／洪鯊的） */
  outAccount?: string | null;
  /**
   * 這幾列是**勾出來的**嗎（true），還是「全部待收回」（false）。
   *
   * ★★★ 兩條路的規則不一樣，而且**只差這一個布林**:
   *     勾了 → 金額必須剛好等於這幾列的欠款總和
   *     沒勾 → 金額自己填，不能超過總欠款
   *   所以不能靠「rows 是不是全部」去推 —— 剛好把全部都勾起來時
   *   那兩條路會給出不同的答案，而推出來的那個是錯的。
   */
  picked?: boolean;
};

export function validateRepay(rows: readonly RepayRow[], f: RepayForm): string | null {
  const open = (rows ?? []).filter(isOpen);
  if (!open.length) return '這些列都已經收回了 —— 沒有東西可以扣';

  /* ★ 只收代墊。押金與保證金被扣時要選會計科目，攤還這條路問不了。 */
  const notLent = open.find((a) => (a.category ?? '') !== '代墊');
  if (notLent) return '攤還只處理代墊 —— 押金與保證金請一列一列開抽屜收回';

  /* ★ 一次還款是一筆錢進來。愛皮跟洪鯊各還各的，混在同一次裡的話
       還款日與兩個帳戶就同時代表兩筆匯款，銀行對帳對不回來。 */
  const party = open[0].counterparty ?? '';
  const other = open.find((a) => (a.counterparty ?? '') !== party);
  if (other) {
    return `一次只能收同一個對象（選到了${party || '（沒填）'}和${other.counterparty || '（沒填）'}）`;
  }

  if (!f.on) return '要填還款日';

  const early = repayOrder(open).find((a) => a.paid_on && f.on! < a.paid_on);
  if (early) return `還款日 ${f.on} 早於出款日 ${early.paid_on}`;

  /*
   * ★★ 空字串與 0 是兩件事，但**都不能存**:
   *   空字串是「還沒填」，0 是「還了 0 元」—— 後者不是一筆還款。
   *   `Number('')` 是 0，所以不能只用 Number 判（會把沒填當成填了 0）。
   */
  if (f.pay == null || String(f.pay).trim() === '') return '要填還款金額';
  const pay = Number(f.pay);
  if (!Number.isFinite(pay)) return '還款金額只能填數字';
  if (pay <= 0) return '還款金額要大於 0';
  if (cent(pay) !== pay) return '還款金額最多到小數點後兩位';

  /*
   * ★★★ 金額要跟範圍對得起來（2026-09-21 使用者指定）。
   *
   *   勾了 → **必須剛好等於**這幾列的欠款總和。多一塊少一塊都擋。
   *   沒勾 → **不能超過**總欠款。
   *
   * ★★ 訊息要把兩個數字都寫出來。只說「對不上」的話，
   *   人得自己去把那幾列加一遍才知道差多少。
   */
  const owed = allocate(open, pay).owed;
  if (f.picked) {
    if (pay !== owed) {
      return pay > owed
        ? `還款 ${pay} 比勾起來這 ${open.length} 列的欠款 ${owed} 多 ${cent(pay - owed)}`
          + ' —— 逐筆還要剛好還完，多的那部分不知道要記到哪一列'
        : `還款 ${pay} 比勾起來這 ${open.length} 列的欠款 ${owed} 少 ${cent(owed - pay)}`
          + ' —— 不想剛好還完的話，把勾選全部取消再填金額';
    }
  } else if (pay > owed) {
    return `還款 ${pay} 比總欠款 ${owed} 多 ${cent(pay - owed)}`
      + ' —— 多出來的不是代墊的收回，要另外記一筆收入';
  }

  if (!f.inAccount?.trim()) return '要選還入哪個帳戶（安幸的）';
  if (!f.outAccount?.trim()) return '要選從哪個帳戶出去（對方的）';
  if (f.inAccount.trim() === f.outAccount.trim()) {
    return '還入與出帳是同一個帳戶 —— 那樣這筆錢沒有移動過';
  }

  return null;
}

/**
 * 這幾列一共還欠多少 —— **剩餘款**（2026-09-21 使用者：「也要能看出剩餘款」）。
 *
 * 同一個數字在畫面上有三個用處，所以只算這一份：
 *
 *   · 統計卡的「待收回」金額 —— ★★★ 是**剩餘款**不是代墊總額。
 *     還了一半還印原價的話，那張卡會一直說欠 13,209（CLAUDE.md：
 *     推導值要算出來，而且同一個數字不要兩個算法）
 *   · 勾選之後金額欄的預設值 —— 人就不用自己把那幾列加一遍
 *   · 「配不上就擋」那條檢查拿來比對的基準
 *
 * ★ 已結清的列算 0（`oweOf` 負責），所以認賠的那筆零頭不會
 *   一直掛在「還沒收回」裡面。
 */
export const owedTotal = (rows: readonly RepayRow[]): number => allocate(rows, 0).owed;
