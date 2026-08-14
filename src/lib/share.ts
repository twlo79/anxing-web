/**
 * 分享請款單與押金退款（LINE / 系統分享單）。
 *
 * ============================================================
 * 【為什麼兩種單共用一支】
 *
 * 這段原本只寫在請款頁。押金頁也要分享的時候如果複製一份，兩邊的訊息格式
 * 會開始各自演化 —— 收到訊息的人會發現「同一件事怎麼兩種長相」，
 * 而且連結格式一旦有一邊改了、另一邊沒改，點進去就是壞的。
 *
 *
 * ============================================================
 * 【為什麼訊息要跟著狀態改】
 *
 * 改版前不管單子在哪個階段，分享出去都是同一句「前往核可」。
 * 那句話有兩個問題：
 *
 *   1. 已經核可完、甚至已經付款的單，分享出去還在叫人去核可 ——
 *      收到的人會點進去找一顆根本不存在的按鈕。
 *   2. **分享的對象不一定是主管**。轉給申請人、會計、廠商都很常見，
 *      而「前往核可」對他們是一句看不懂的話。
 *
 * 所以：狀態寫在第一行（待核可 / 已核可 / 已付款 / 已駁回），
 * 動作那一行一律是中性的「開啟單據」—— 誰收到都讀得懂。
 *
 * 待核可的單另外補一行「還缺　○○核可」：那比一顆按鈕更有用，
 * 因為它直接說出卡在誰身上。
 */

/* ══════════════════════════════════════════════════════
 * 階段
 * ══════════════════════════════════════════════════════ */

export type ShareStage = 'draft' | 'pending' | 'approved' | 'paid' | 'rejected';

/**
 * 這張單現在在哪個階段。
 *
 * 【為什麼「已付款」要獨立出來】
 * 資料庫裡付過款的單狀態仍然是 approved —— 只是多了一個出款日。
 * 不分開的話，錢已經匯出去的單分享出去會寫「已核可」，
 * 看起來像還在等會計處理。
 */
export function stageOf(status: string | null | undefined, paid: boolean): ShareStage {
  if (paid) return 'paid';
  switch (status) {
    case 'approved': return 'approved';
    case 'rejected': return 'rejected';
    case 'draft':
    case 'none':
    case null:
    case undefined: return 'draft';
    default: return 'pending';
  }
}

export const STAGE_LABEL: Record<ShareStage, string> = {
  draft: '草稿・尚未送審',
  pending: '待核可',
  approved: '已核可・待付款',
  paid: '已付款',
  rejected: '已駁回',
};

/**
 * 待核可時，還缺誰那一票。
 *
 * 【為什麼要講「缺誰」而不是「已經有誰簽了」】
 * 收到訊息的人要判斷的是「這件事卡在我身上嗎」。
 * 列出已簽的人他還要自己反推，列出缺的人他一眼就知道。
 *
 * @returns 沒有缺的（或不需要核可）回空字串
 */
export function missingVotes(mgrAt: string | null, admAt: string | null): string {
  const miss = [!mgrAt && '主管', !admAt && '總經理'].filter(Boolean);
  return miss.length ? `${miss.join('、')}核可` : '';
}

/* ══════════════════════════════════════════════════════
 * 組訊息
 * ══════════════════════════════════════════════════════ */

const money = (n: number | null | undefined) =>
  Math.round(Number(n) || 0).toLocaleString('en-US');

/** 08-20 → 08/20；null → '' */
const md = (d: string | null | undefined) =>
  d ? d.slice(5).replace('-', '/') : '';

/**
 * 標籤補到固定寬度，讓值對齊在同一欄。
 *
 * LINE 是等寬排版，對齊了才讀得快 —— 沒對齊的話四五行標籤長短不一，
 * 眼睛得逐行找值從哪裡開始。
 *
 * 寬度是 5 不是 4：最長的標籤（支出方式、駁回原因）剛好 4 個字，
 * 補到 4 的話它們後面一個空白都沒有，值會直接黏上去變成「支出方式匯款」。
 */
const PAD_W = 5;
const pad = (label: string) => label + '　'.repeat(Math.max(1, PAD_W - label.length));

export type ShareDoc = {
  /** 第一行的圖示與單別 */
  icon: string;
  kind: string;
  stage: ShareStage;
  /** 主識別：請款單是單號，押金是房源・房客 */
  headline: string;
  amount: number;
  /** 明細行。值是空的會自動略過 —— 空欄位比沒有欄位更難讀 */
  rows: [string, string | null | undefined][];
  url: string;
};

export function buildShareText(d: ShareDoc): string {
  const lines = [
    `${d.icon} ${d.kind}・${STAGE_LABEL[d.stage]}`,
    '',
    d.headline,
    `NT$ ${money(d.amount)}`,
    '',
    ...d.rows.filter(([, v]) => v != null && String(v).trim() !== '')
             .map(([k, v]) => `${pad(k)}${v}`),
    '',
    // 中性用語：分享對象不一定是主管，「前往核可」對其他人是看不懂的指令
    '開啟單據',
    d.url,
  ];
  return lines.join('\n');
}

/** 手機用系統分享單（可選 LINE 以外的 App），桌機退回 LINE 的網頁分享網址。 */
export function sendShare(title: string, text: string) {
  if (typeof navigator !== 'undefined' && navigator.share) {
    navigator.share({ title, text }).catch(() => {});
    return;
  }
  window.open('https://line.me/R/msg/text/?' + encodeURIComponent(text),
    '_blank', 'noopener');
}

/* ══════════════════════════════════════════════════════
 * 押金退款
 * ══════════════════════════════════════════════════════ */

export type ShareDep = {
  id: string;
  room: string | null;
  guest_name: string | null;
  amount: number;
  payee_name?: string | null;
  payee_bank_code?: string | null;
  payee_account?: string | null;
  planned_refund_on?: string | null;
  returned_on?: string | null;
  refund_status?: string | null;
  reject_reason?: string | null;
  manager_approved_at?: string | null;
  admin_approved_at?: string | null;
};

/**
 * @param requester 送審的人（refund_requested_by 查出來的名字）。
 *                  這一頁的「請款者」欄位用的是同一個人 —— 兩邊要一致，
 *                  不然訊息裡的名字跟清單上的對不起來。
 */
export function depositShareText(d: ShareDep, origin: string, requester?: string): string {
  const stage = stageOf(d.refund_status, !!d.returned_on);
  return buildShareText({
    icon: '💰', kind: '押金退款', stage,
    headline: `${d.room ?? '—'}　${d.guest_name ?? '—'}`,
    amount: d.amount,
    rows: [
      ['請款者', requester],
      ['收款人', d.payee_name],
      ['帳號', [d.payee_bank_code, d.payee_account].filter(Boolean).join(' ')],
      // 已匯出的看付款日，還沒匯的看預計日 —— 同時出現會讓人不確定哪個才算數
      d.returned_on ? ['匯出日', md(d.returned_on)] as [string, string]
                    : ['預計匯出', md(d.planned_refund_on)] as [string, string],
      ['還缺', stage === 'pending'
        ? missingVotes(d.manager_approved_at ?? null, d.admin_approved_at ?? null) : ''],
      ['駁回原因', stage === 'rejected' ? d.reject_reason : ''],
    ],
    // 核可統一在請款頁的「請款審核」分頁做，主管點進來就能直接投票，
    // 不用先到押金管理頁再自己找那一筆
    url: `${origin}/purchases?dep=${encodeURIComponent(d.id)}`,
  });
}

export function shareDeposit(d: ShareDep, requester?: string) {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  sendShare(`押金退款 ${d.room ?? ''}`, depositShareText(d, origin, requester));
}

/* ══════════════════════════════════════════════════════
 * 請款單
 * ══════════════════════════════════════════════════════ */

export type ShareReq = {
  req_no: string;
  status: string | null;
  total_amount: number;
  purchased_on?: string | null;
  planned_transfer_on?: string | null;
  reject_reason?: string | null;
  manager_approved_at?: string | null;
  admin_approved_at?: string | null;
};

export function requestShareText(
  r: ShareReq, origin: string,
  extra: { requester?: string; items?: string; payment?: string } = {},
): string {
  const stage = stageOf(r.status, !!r.purchased_on);
  return buildShareText({
    icon: '🧾', kind: '請款單', stage,
    headline: r.req_no,
    amount: r.total_amount,
    rows: [
      ['請款者', extra.requester],
      ['項目', extra.items],
      ['支出方式', extra.payment],
      r.purchased_on ? ['付款日', md(r.purchased_on)] as [string, string]
                     : ['預計付款', md(r.planned_transfer_on)] as [string, string],
      ['還缺', stage === 'pending'
        ? missingVotes(r.manager_approved_at ?? null, r.admin_approved_at ?? null) : ''],
      ['駁回原因', stage === 'rejected' ? r.reject_reason : ''],
    ],
    // ?req=單號 —— 對方開啟後會自動跳到那張單並展開抽屜。
    // 只給網址的話對方還要自己找，單號一多就找不到。
    url: `${origin}/purchases?req=${encodeURIComponent(r.req_no)}`,
  });
}

export function shareRequest(
  r: ShareReq, extra: { requester?: string; items?: string; payment?: string } = {},
) {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  sendShare(`請款單 ${r.req_no}`, requestShareText(r, origin, extra));
}
