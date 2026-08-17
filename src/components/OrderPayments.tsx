'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase';
import Receipts, { type ReceiptsHandle } from '@/components/Receipts';
import {
  payStatus, remaining, isExempt, checkPayment, STATUS_LABEL, STATUS_CLASS,
  type PaymentRow,
} from '@/lib/order-payment';
import { METHOD_LABEL, METHOD_OPTS, needsAccount, normalizeMethod, methodText } from '@/lib/pay-method';
import { softDelete } from '@/lib/trash';

/**
 * 短租訂單的收款視窗。
 *
 * 【為什麼是一筆一列，不是一個勾】
 * 短租常常分次收（訂金 → 尾款）。只有布林的話「收了訂金」跟「完全沒收」
 * 在畫面上一模一樣，催款的人分不出來。
 *
 * 合計與狀態由資料庫的觸發器維護（migration_84），這裡只負責新增與刪除。
 * **前端不自己算 paid_amount 寫回 orders** —— 兩邊各算一次就會有對不上的一天。
 *
 * 【為什麼刪除而不是編輯】
 * 收款記錯了就把那一列刪掉重記。可編輯的話要處理「改金額後合計要重算」、
 * 「改日期後 paid_at 要重算」，而那些觸發器本來就會做 —— 但多一條路就多一種錯法。
 * 一筆收款是一個事實，錯了就是記錯了，刪掉重來語意最清楚。
 *
 * 【收款證明】
 * 每一筆可以附圖，沿用 attachments + receipts bucket（migration_85）。
 * 新增時還沒有收款 id，所以圖先暫存在瀏覽器裡，
 * insert 拿到 id 之後才呼叫 flush() 真的上傳 —— 跟請款單的做法一致。
 *
 * 【手機】
 * 手機上是從底部升起的整頁面板（不是置中小視窗），輸入列全部單欄，
 * 控制項高度 44px 以上。金額用 inputMode="numeric" 叫出數字鍵盤。
 */

type Order = {
  id: string; source: string; amount: number | null;
  paid_amount?: number | null; guest_name?: string | null;
  invoice_required?: boolean; invoice_title?: string | null; invoice_tax_id?: string | null;
  room?: string | null; property_raw?: string | null; checkin?: string | null;
};

type Inv = { id: string; invoice_no: string; invoice_date: string; note: string | null };

/** 發票號碼格式:2 碼英文 + 8 碼數字。跟契約頁同一條規則。 */
const INV_NO_RE = /^[A-Z]{2}[0-9]{8}$/;

const fmt = (n: number | null | undefined) => Math.round(Number(n) || 0).toLocaleString('en-US');
const today = () => new Date().toISOString().slice(0, 10);
/** 手機上手指按得到的最小高度。桌機縮回一般大小,免得表單過胖。 */
const CTRL = 'h-11 md:h-9 w-full bg-white rounded-lg border border-mor-line px-2 text-sm';

export default function OrderPayments({
  order, accounts, canEdit, onClose, onChanged,
}: {
  order: Order;
  accounts: { code: string; name: string }[];
  canEdit: boolean;
  onClose: () => void;
  /** 收款有變動時通知母頁重新載入 —— 列表上的狀態標籤要跟著變 */
  onChanged: () => void;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [rows, setRows] = useState<PaymentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  // 合計以資料庫回來的為準,不用前端的 rows 加總 —— 兩邊算法不一致時要看得出來
  const [paidAmount, setPaidAmount] = useState(Number(order.paid_amount) || 0);
  /** 展開中的那一筆(看/加照片)。一次只開一筆,免得手機上捲不完。 */
  const [openId, setOpenId] = useState<string | null>(null);

  const [draftOn, setDraftOn] = useState(today());
  const [draftAmt, setDraftAmt] = useState('');
  const [draftMethod, setDraftMethod] = useState('transfer');
  const [draftAcct, setDraftAcct] = useState('');
  const [draftNote, setDraftNote] = useState('');
  const receiptsRef = useRef<ReceiptsHandle>(null);

  /*
   * 發票。訂單勾了「需開立發票」才會出現。
   *
   * 存進 invoices 表(跟契約共用),contract_id 留空、order_id 指到這張訂單。
   * migration_87 的 inv_order_once_idx 保證一張短租訂單只會有一張已開立的發票。
   */
  const [inv, setInv] = useState<Inv | null>(null);
  const [invNo, setInvNo] = useState('');
  const [invDate, setInvDate] = useState(today());

  const due = Math.round(Number(order.amount) || 0);
  const cur = { source: order.source, amount: order.amount, paid_amount: paidAmount };
  const rest = remaining(cur);
  const status = payStatus(cur);

  function flash(t: string) { setMsg(t); setTimeout(() => setMsg(''), 4000); }

  const load = useCallback(async () => {
    const [{ data: ps }, { data: od }] = await Promise.all([
      supabase.from('order_payments')
        .select('id, paid_on, amount, method, account, note')
        .eq('order_id', order.id).order('paid_on').order('created_at'),
      supabase.from('orders').select('paid_amount').eq('id', order.id).single(),
    ]);
    setRows((ps ?? []) as PaymentRow[]);
    setPaidAmount(Number(od?.paid_amount) || 0);

    if (order.invoice_required) {
      const { data: iv } = await supabase.from('invoices')
        .select('id, invoice_no, invoice_date, note')
        .eq('order_id', order.id).is('contract_id', null).eq('status', 'issued').maybeSingle();
      setInv((iv as Inv) ?? null);
      if (iv) { setInvNo(iv.invoice_no); setInvDate(iv.invoice_date); }
    }
    setLoading(false);
  }, [supabase, order.id, order.invoice_required]);
  useEffect(() => { load(); }, [load]);

  // 尚欠金額當預設 —— 大部分情況是一次收清，少打幾個字。
  // 已經收滿就留空，避免手滑直接送出一筆重複的。
  useEffect(() => { if (!loading) setDraftAmt(rest > 0 ? String(rest) : ''); }, [loading, rest]);

  async function add() {
    const amt = Number(draftAmt);
    const chk = checkPayment(amt, rest, due);
    if (!chk.ok) return flash(chk.error);
    if (!draftOn) return flash('請選收款日');
    if (chk.confirm && !confirm(chk.confirm)) return;

    setBusy(true);
    const { data: { user } } = await supabase.auth.getUser();
    // 非匯款一律不帶帳號 —— 資料庫的 op_account_chk 也會擋,
    // 但約束擋下來的訊息是約束名稱,沒人看得懂,所以前端先對齊。
    const { method, account } = normalizeMethod(draftMethod, draftAcct);
    const { data, error } = await supabase.from('order_payments').insert({
      order_id: order.id, paid_on: draftOn, amount: Math.round(amt),
      method, account, note: draftNote.trim() || null,
      created_by: user?.id ?? null,
    }).select('id').single();

    if (error || !data) { setBusy(false); return flash('存不進去:' + (error?.message ?? '')); }

    // 收款已經寫進去了 —— 照片上傳失敗不該讓整筆消失，只提示。
    const upErr = await receiptsRef.current?.flush(data.id);
    setBusy(false);
    if (upErr) flash('收款已存,但照片上傳失敗:' + upErr);

    setDraftNote('');
    await load();
    onChanged();
  }

  async function del(r: PaymentRow) {
    if (!confirm(
      `刪除這筆收款?\n\n${r.paid_on}　$${fmt(r.amount)}\n\n`
      + `這筆的收款證明照片會一起刪除，合計與收款狀態會重算。\n\n`
      + `會移到回收桶，可以復原。`
    )) return;
    setBusy(true);
    const res = await softDelete(supabase, 'order_payments', r.id);
    setBusy(false);
    if (!res.ok) return flash(res.message);
    flash(res.message);
    if (openId === r.id) setOpenId(null);
    await load();
    onChanged();
  }

  /**
   * 存發票號碼。
   *
   * 【為什麼不用 upsert】
   * 已經有一張時走 update,沒有才 insert —— upsert 需要指定衝突目標,
   * 而 inv_order_once_idx 是帶 where 的部分索引,推斷條件寫錯就會靜靜地
   * 變成插入第二張。分開寫意圖最清楚。
   */
  async function saveInv() {
    const no = invNo.trim().toUpperCase();
    if (!INV_NO_RE.test(no)) return flash('發票號碼格式應為 2 碼英文 + 8 碼數字,例 AB12345678');
    if (!invDate) return flash('請填開票日期');
    setBusy(true);
    const payload = {
      order_id: order.id, contract_id: null,
      room: order.room ?? order.property_raw ?? null,
      ym: (order.checkin ?? today()).slice(0, 7).replace('-', ''),
      amount: Math.round(Number(order.amount) || 0) || null,
      invoice_no: no, invoice_date: invDate,
      title: order.invoice_title || order.guest_name || null,
      tax_id: order.invoice_tax_id || null,
      status: 'issued',
    };
    const { error } = inv
      ? await supabase.from('invoices').update(payload).eq('id', inv.id)
      : await supabase.from('invoices').insert(payload);
    setBusy(false);
    if (error) {
      return flash(error.code === '23505'
        ? '這張訂單已經有一張已開立的發票,請重新整理確認。'
        : '儲存失敗:' + error.message);
    }
    flash('已記錄發票');
    await load();
  }

  async function delInv() {
    if (!inv) return;
    if (!confirm(`刪除發票紀錄 ${inv.invoice_no}?\n\n（不會影響已在平台開立的發票）\n\n會移到回收桶，可以復原。`)) return;
    setBusy(true);
    const res = await softDelete(supabase, 'invoices', inv.id);
    setBusy(false);
    if (!res.ok) return flash(res.message);
    setInv(null); setInvNo('');
    flash('已移到回收桶');
    await load();
  }

  const acctName = useMemo(
    () => Object.fromEntries(accounts.map((a) => [a.code, a.name])), [accounts]);

  const exempt = isExempt(order);

  return (
    // 手機:貼底的整頁面板。置中小視窗在手機上鍵盤一跳出來就被推到看不見。
    <div className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/40" />
      <div onClick={(e) => e.stopPropagation()}
        className="relative bg-white w-full sm:max-w-lg rounded-t-2xl sm:rounded-2xl shadow-xl
                   max-h-[92vh] sm:max-h-[85vh] overflow-y-auto">

        <div className="sticky top-0 z-10 bg-white border-b border-mor-line px-5 py-3.5 flex items-start justify-between">
          <div className="min-w-0">
            <div className="font-bold">收款</div>
            <div className="text-xs text-gray-500 mt-0.5 truncate">{order.guest_name ?? '—'}</div>
          </div>
          <button onClick={onClose} aria-label="關閉"
            className="-mr-1 -mt-1 h-9 w-9 shrink-0 text-gray-400 hover:text-gray-600 text-xl leading-none">✕</button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {msg && <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-sm text-amber-800">{msg}</div>}

          {exempt ? (
            <div className="rounded-lg bg-gray-50 border border-mor-line px-3 py-3 text-sm text-gray-500">
              這個來源是平台代收，不需要記收款。
            </div>
          ) : (
            <>
              {/* 三個數字擺最上面 —— 打開視窗第一眼要回答的就是「還差多少」 */}
              <div className="grid grid-cols-3 gap-2 text-center">
                <div className="rounded-lg bg-mor-sand/60 py-2">
                  <div className="text-[11px] text-gray-500">應收</div>
                  <div className="font-bold text-sm">${fmt(due)}</div>
                </div>
                <div className="rounded-lg bg-mor-greenlight py-2">
                  <div className="text-[11px] text-mor-green">已收</div>
                  <div className="font-bold text-sm text-mor-green">${fmt(paidAmount)}</div>
                </div>
                <div className={`rounded-lg py-2 ${rest > 0 ? 'bg-red-50' : 'bg-gray-100'}`}>
                  <div className={`text-[11px] ${rest > 0 ? 'text-red-600' : 'text-gray-400'}`}>尚欠</div>
                  <div className={`font-bold text-sm ${rest > 0 ? 'text-red-600' : 'text-gray-400'}`}>${fmt(rest)}</div>
                </div>
              </div>
              <div className="text-center">
                <span className={`inline-block rounded-md px-2 py-0.5 text-xs font-medium ${STATUS_CLASS[status]}`}>
                  {STATUS_LABEL[status]}
                </span>
                {paidAmount > due && due > 0 && (
                  <span className="ml-2 text-xs text-amber-600">超收 ${fmt(paidAmount - due)}</span>
                )}
              </div>

              {/*
                發票。放在金額摘要底下、收款明細上面 ——
                「收到錢」跟「開發票」是同一次動作的兩件事,擺在一起才不會漏。
              */}
              {order.invoice_required && (
                <div className={`rounded-lg border p-3 ${inv ? 'border-mor-line' : 'border-amber-300 bg-amber-50/40'}`}>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs text-gray-500">發票</span>
                    {inv
                      ? <span className="text-[11px] rounded bg-mor-greenlight text-mor-green px-1.5 py-0.5">已開立</span>
                      : <span className="text-[11px] text-amber-700">尚未開立</span>}
                  </div>
                  {canEdit ? (
                    <>
                      <div className="grid grid-cols-2 gap-2">
                        <label className="flex flex-col gap-1">
                          <span className="text-[11px] text-gray-400">發票號碼</span>
                          <input value={invNo} maxLength={10} placeholder="AB12345678"
                            onChange={(e) => setInvNo(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
                            className={`${CTRL} uppercase tracking-wide`} />
                        </label>
                        <label className="flex flex-col gap-1">
                          <span className="text-[11px] text-gray-400">開票日</span>
                          <input type="date" value={invDate} onChange={(e) => setInvDate(e.target.value)} className={CTRL} />
                        </label>
                      </div>
                      <div className="flex gap-2 mt-2">
                        <button onClick={saveInv} disabled={busy}
                          className="flex-1 h-11 md:h-9 rounded-lg border border-mor-slate text-mor-slate text-sm font-medium disabled:opacity-40">
                          {inv ? '更新發票' : '記錄發票'}
                        </button>
                        {inv && (
                          <button onClick={delInv} disabled={busy}
                            className="h-11 md:h-9 px-3 rounded-lg text-xs text-red-400 hover:text-red-600 disabled:opacity-40">刪除</button>
                        )}
                      </div>
                      <div className="text-[11px] text-gray-400 mt-1.5">
                        抬頭 {order.invoice_title || order.guest_name || '—'}
                        {order.invoice_tax_id ? `・統編 ${order.invoice_tax_id}` : ''}
                        ・號碼格式 2 碼英文 + 8 碼數字
                      </div>
                    </>
                  ) : (
                    <div className="text-sm">{inv ? `${inv.invoice_no}・${inv.invoice_date}` : '—'}</div>
                  )}
                </div>
              )}

              {/* 已收明細 */}
              <div>
                <div className="flex items-baseline justify-between mb-1.5">
                  <span className="text-xs text-gray-500">收款明細</span>
                  {rows.length > 0 && <span className="text-[11px] text-gray-400">{rows.length} 筆・點一筆可看收款證明</span>}
                </div>
                {loading ? (
                  <div className="text-sm text-gray-400 py-3 text-center">載入中…</div>
                ) : rows.length === 0 ? (
                  <div className="text-sm text-gray-400 py-4 text-center border border-dashed border-mor-line rounded-lg">
                    尚未有收款紀錄<div className="text-[11px] mt-1">收款可以分多次記，下面新增一筆就好</div>
                  </div>
                ) : (
                  <div className="border border-mor-line rounded-lg divide-y divide-mor-line/60">
                    {rows.map((r) => (
                      <div key={r.id}>
                        <div className="flex items-center gap-2 px-3 py-2.5 text-sm cursor-pointer hover:bg-mor-sand/30"
                          onClick={() => setOpenId(openId === r.id ? null : r.id)}>
                          <span className="text-gray-300 text-xs w-3 shrink-0">{openId === r.id ? '▾' : '▸'}</span>
                          <div className="min-w-0 flex-1">
                            <div className="font-medium">${fmt(r.amount)}</div>
                            <div className="text-[11px] text-gray-500 truncate">
                              {r.paid_on}・{methodText(r.method, r.account, acctName)}
                              {r.note ? `・${r.note}` : ''}
                            </div>
                          </div>
                          {canEdit && (
                            <button onClick={(e) => { e.stopPropagation(); del(r); }} disabled={busy}
                              className="shrink-0 h-9 px-2 text-xs text-red-400 hover:text-red-600 disabled:opacity-40">刪除</button>
                          )}
                        </div>
                        {openId === r.id && (
                          <div className="px-3 pb-3 bg-mor-sand/20">
                            <Receipts kind="op" parentId={r.id} canEdit={canEdit} label="收款證明" />
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* 新增一筆。收滿之後仍然開著 —— 超收要問一聲,但不擋。 */}
              {canEdit && (
                <div className="rounded-lg border border-mor-line p-3 space-y-2.5">
                  <div className="text-xs text-gray-500">新增收款</div>

                  <div className="grid grid-cols-2 gap-2">
                    <label className="flex flex-col gap-1">
                      <span className="text-[11px] text-gray-400">收款日</span>
                      <input type="date" value={draftOn} onChange={(e) => setDraftOn(e.target.value)} className={CTRL} />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="text-[11px] text-gray-400">金額（台幣）</span>
                      {/* inputMode=numeric 讓手機直接跳數字鍵盤 */}
                      <input type="number" inputMode="numeric" min={0}
                        value={draftAmt} onChange={(e) => setDraftAmt(e.target.value)}
                        placeholder="0" className={`${CTRL} text-right`} />
                    </label>
                  </div>

                  {/*
                    收款方式與帳號。只有「匯款」對得到我方帳戶 ——
                    現金當面收、信用卡走收單行、加密貨幣走錢包，
                    那三種指定元大某個帳號只會讓對帳的人以為錢真的進了那個戶頭。
                  */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <label className="flex flex-col gap-1">
                      <span className="text-[11px] text-gray-400">收款方式</span>
                      <select value={draftMethod}
                        onChange={(e) => setDraftMethod(e.target.value)} className={CTRL}>
                        {METHOD_OPTS.map((m) => <option key={m} value={m}>{METHOD_LABEL[m]}</option>)}
                      </select>
                    </label>
                    {needsAccount(draftMethod) && (
                      <label className="flex flex-col gap-1">
                        <span className="text-[11px] text-gray-400">安幸收款帳號</span>
                        <select value={draftAcct} onChange={(e) => setDraftAcct(e.target.value)} className={CTRL}>
                          <option value="">未指定</option>
                          {accounts.map((a) => <option key={a.code} value={a.code}>{a.name}</option>)}
                        </select>
                      </label>
                    )}
                  </div>

                  <label className="flex flex-col gap-1">
                    <span className="text-[11px] text-gray-400">備註（選填）</span>
                    <input value={draftNote} onChange={(e) => setDraftNote(e.target.value)} className={CTRL} />
                  </label>

                  {/*
                    收款證明。這時還沒有收款 id，Receipts 會先把檔案留在瀏覽器裡，
                    insert 拿到 id 之後由 flush() 真正上傳。
                    手機拍的照片會自動壓到長邊 1600px 再傳（見 Receipts）。
                  */}
                  <Receipts ref={receiptsRef} kind="op" parentId={null} canEdit label="收款證明（選填）" />

                  <button onClick={add} disabled={busy}
                    className="w-full h-12 rounded-lg bg-mor-green text-white text-sm font-medium hover:opacity-90 disabled:opacity-40">
                    {busy ? '處理中…' : '確認收款'}
                  </button>
                  <div className="text-[11px] text-gray-400 text-center">
                    可以分多次收款，每按一次就多一筆紀錄
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        <div className="sticky bottom-0 bg-white border-t border-mor-line px-5 py-3"
          style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}>
          <button onClick={onClose}
            className="w-full h-12 rounded-lg border border-gray-300 text-sm font-medium hover:bg-mor-sand/50">關閉</button>
        </div>
      </div>
    </div>
  );
}
