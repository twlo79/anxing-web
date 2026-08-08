/**
 * 分享到 LINE。押金管理頁與請款頁共用。
 *
 * 【為什麼抽出來】
 * 這段原本只寫在請款頁。押金頁也要分享的時候如果複製一份,兩邊的訊息格式
 * 會開始各自演化 —— 收到訊息的主管會發現「同一件事怎麼兩種長相」,
 * 而且連結格式一旦有一邊改了、另一邊沒改,點進去就是壞的。
 *
 * 【連結為什麼指向請款頁】
 * 核可統一在請款頁的「待核可」分頁做。主管點進來就能直接投票,
 * 不用先到押金管理頁再自己找那一筆。
 */

export type ShareDep = {
  id: string;
  room: string | null;
  guest_name: string | null;
  amount: number;
  payee_name?: string | null;
  payee_bank_code?: string | null;
  payee_account?: string | null;
  planned_refund_on?: string | null;
  refund_status?: string | null;
};

const money = (n: number) => Math.round(Number(n) || 0).toLocaleString('en-US');

export function shareDeposit(d: ShareDep) {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const url = `${origin}/purchases?dep=${encodeURIComponent(d.id)}`;
  const text = [
    d.refund_status === 'pending' ? '💰 押金退款待核可' : '💰 押金退款',
    '',
    `${d.room ?? '—'}　${d.guest_name ?? '—'}`,
    `NT$ ${money(d.amount)}`,
    '',
    `房客收款帳號　${d.payee_name ?? '—'}`,
    `　　　　　${d.payee_bank_code ?? ''} ${d.payee_account ?? '—'}`,
    `預計匯款　${d.planned_refund_on ?? '—'}`,
    '',
    '前往核可',
    url,
  ].join('\n');

  // 手機上用系統分享單,可以直接選 LINE 以外的 App;
  // 桌機沒有 navigator.share,退回開 LINE 的網頁分享網址。
  if (typeof navigator !== 'undefined' && navigator.share) {
    navigator.share({ title: `押金退款 ${d.room ?? ''}`, text }).catch(() => {});
    return;
  }
  window.open('https://line.me/R/msg/text/?' + encodeURIComponent(text), '_blank', 'noopener');
}
