'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase';
import Receipts, { type ReceiptsHandle } from '@/components/Receipts';
import {
  remainingDep, depPayStatus, checkDepPayment, reconcile,
  DEP_STATUS_LABEL, DEP_STATUS_CLASS, type DepPaymentRow,
} from '@/lib/deposit-payment';
import { METHOD_LABEL, METHOD_OPTS, needsAccount, normalizeMethod, methodText } from '@/lib/pay-method';
import { softDelete } from '@/lib/trash';

/**
 * 押金的收款視窗。
 *
 * ============================================================
 * 【為什麼一筆一列，不是一個日期欄】（2026-08-19 使用者指定）
 *
 * 押金常常分兩次收（先收一半、入住當天補齊）。舊模型是
 * deposits 上一個 received_on —— **記不下第一筆**，
 * 於是「已經收了一半」跟「一毛都沒收」在畫面上長得一模一樣。
 *
 * 短租訂單當初踩過同一個坑（見 OrderPayments 的註解），
 * 那邊的解法是 order_payments 一筆一列。這裡照抄同一套版面 ——
 * 兩個視窗長得一樣，看帳的人不用學兩種。
 *
 * 【合計不在前端算】
 * `deposits.received_amount` 由觸發器維護（migration_147）。
 * 前端只負責新增與刪除。兩邊各算一次就會有對不上的一天，
 * 而那一天你只會看到「明細加起來跟上面的數字不一樣」。
 * 所以還多了一條 reconcile() 主動比對，不一樣就講出來。
 *
 * 【為什麼刪除而不是編輯】
 * 一筆收款是一個事實，記錯了就刪掉重記。
 * 可編輯的話要處理「改金額後合計要重算」「改日期後收滿日要重算」——
 * 觸發器本來就會做，但多一條路就多一種錯法。
 *
 * 【照片分收／退】（2026-08-19 使用者指定）
 * 收款證明掛在**那一筆收款**上（attachments.deposit_payment_id），
 * 退款憑證留在押金上。收兩次就有兩張單據，都掛在押金底下的話
 * 分不出哪張對哪筆 —— 而金額對不上時那正是唯一能查的東西。
 *
 * 既有的圖片原地不動、標成「其他憑證（舊）」——
 * 系統分不出哪張是收款單據哪張是退款水單，那個資訊從來沒存過。
 */

type Dep = {
  id: string;
  amount: number | null;
  received_amount?: number | null;
  received_on: string | null;
  returned_on: string | null;
  currency?: string | null;
  room?: string | null;
  guest_name?: string | null;
  is_manual?: boolean;
  contract_id?: string | null;
};

const fmt = (n: number | null | undefined) => Math.round(Number(n) || 0).toLocaleString('en-US');
const today = () => new Date().toISOString().slice(0, 10);
/** 手機上手指按得到的最小高度。桌機縮回一般大小，免得表單過胖。 */
const CTRL = 'h-11 md:h-9 w-full bg-white rounded-lg border border-mor-line px-2 text-sm';

export default function DepositPayments({
  dep, accounts, canEdit, onClose, onChanged,
}: {
  dep: Dep;
  accounts: { code: string; name: string }[];
  canEdit: boolean;
  onClose: () => void;
  /** 收款有變動時通知母頁重新載入 —— 列表上的狀態標籤要跟著變 */
  onChanged: () => void;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [rows, setRows] = useState<DepPaymentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  // 合計以資料庫回來的為準,不用前端的 rows 加總 —— 兩邊算法不一致時要看得出來
  const [received, setReceived] = useState(Number(dep.received_amount) || 0);
  const [returnedOn, setReturnedOn] = useState<string | null>(dep.returned_on);
  /** 展開中的那一筆（看／加照片）。一次只開一筆，免得手機上捲不完。 */
  const [openId, setOpenId] = useState<string | null>(null);

  const [draftOn, setDraftOn] = useState(today());
  const [draftAmt, setDraftAmt] = useState('');
  const [draftMethod, setDraftMethod] = useState('transfer');
  const [draftAcct, setDraftAcct] = useState('');
  const [draftNote, setDraftNote] = useState('');
  const receiptsRef = useRef<ReceiptsHandle>(null);

  const due = Math.round(Number(dep.amount) || 0);
  const cur = { amount: dep.amount, received_amount: received, returned_on: returnedOn };
  const rest = remainingDep(cur);
  const status = depPayStatus(cur);
  const acctName = useMemo(
    () => Object.fromEntries(accounts.map((a) => [a.code, a.name])), [accounts]);

  function flash(t: string) { setMsg(t); setTimeout(() => setMsg(''), 4000); }

  const load = useCallback(async () => {
    const [{ data: ps }, { data: dd }] = await Promise.all([
      supabase.from('deposit_payments')
        .select('id, paid_on, amount, method, account, note')
        .eq('deposit_id', dep.id).is('deleted_at', null)
        .order('paid_on').order('created_at'),
      supabase.from('deposits')
        .select('received_amount, received_on, returned_on').eq('id', dep.id).single(),
    ]);
    setRows((ps ?? []) as DepPaymentRow[]);
    setReceived(Number(dd?.received_amount) || 0);
    setReturnedOn((dd?.returned_on as string) ?? null);
    setLoading(false);
  }, [supabase, dep.id]);

  useEffect(() => { load(); }, [load]);

  /**
   * 新增一筆收款。
   *
   * 照片先暫存在瀏覽器裡 —— 這時候還沒有收款 id 可以掛。
   * insert 拿到 id 之後才呼叫 flush() 真的上傳，跟訂單收款一致。
   */
  async function add() {
    const amt = Math.round(Number(draftAmt) || 0);
    const chk = checkDepPayment(amt, rest, due);
    if (!chk.ok) return flash(chk.error);
    if (chk.confirm && !confirm(chk.confirm)) return;
    if (!draftOn) return flash('請填收款日');

    setBusy(true);
    const { method, account } = normalizeMethod(draftMethod, draftAcct);
    const { data, error } = await supabase.from('deposit_payments').insert({
      deposit_id: dep.id, paid_on: draftOn, amount: amt,
      method, account, note: draftNote.trim() || null,
    }).select('id').single();

    if (error || !data) { setBusy(false); return flash('存不進去：' + (error?.message ?? '')); }

    // 收款已經寫進去了 —— 照片上傳失敗不該讓整筆消失，只提示
    const upErr = await receiptsRef.current?.flush(data.id);
    setBusy(false);
    if (upErr) flash('收款已存，但照片上傳失敗：' + upErr);

    setDraftAmt(''); setDraftNote('');
    await load();
    onChanged();
  }

  async function del(r: DepPaymentRow) {
    if (!confirm(
      `刪除這筆收款？\n\n${r.paid_on}　$${fmt(r.amount)}\n\n`
      + `這筆的收款證明照片會一起刪除，實收合計與狀態會重算。\n\n`
      + `會移到回收桶，可以復原。`
    )) return;
    setBusy(true);
    const res = await softDelete(supabase, 'deposit_payments', r.id);
    setBusy(false);
    if (!res.ok) return flash(res.message);
    flash(res.message);
    if (openId === r.id) setOpenId(null);
    await load();
    onChanged();
  }

  const gap = reconcile(rows, received);
  const name = (dep.room ?? '').trim() || (dep.guest_name ?? '').trim() || '押金';

  return (
    <div className="fixed inset-0 bg-black/30 flex items-stretch md:items-center justify-center overflow-auto md:py-10 z-50"
      onClick={onClose}>
      <div className="bg-white w-full md:w-[560px] md:max-w-[95vw] md:rounded-xl shadow-xl min-h-full md:min-h-0 flex flex-col"
        onClick={(e) => e.stopPropagation()}>

        <div className="sticky top-0 bg-white border-b border-mor-line px-4 md:px-6 py-4 flex items-start justify-between z-10"
          style={{ paddingTop: 'max(1rem, env(safe-area-inset-top))' }}>
          <div className="min-w-0">
            <div className="font-bold">收押金</div>
            <div className="text-xs text-gray-500 mt-0.5 truncate">
              {name}{dep.guest_name && dep.room ? `・${dep.guest_name}` : ''}
            </div>
          </div>
          <button onClick={onClose} aria-label="關閉"
            className="w-10 h-10 -mr-2 flex items-center justify-center text-gray-400 hover:text-gray-600 text-xl">✕</button>
        </div>

        <div className="flex-1 p-4 md:p-6 space-y-4 text-sm">
          {msg && (
            <div className="rounded-lg bg-mor-sand px-3 py-2 text-xs text-gray-700">{msg}</div>
          )}

          {/* 應收／已收／尚欠。三格並排 —— 缺一個就得靠人心算 */}
          <div className="grid grid-cols-3 gap-2">
            <div className="rounded-lg bg-mor-sand px-3 py-2">
              <div className="text-[11px] text-gray-500">應收</div>
              <div className="text-lg font-semibold tabular-nums">${fmt(due)}</div>
            </div>
            <div className="rounded-lg bg-mor-greenlight px-3 py-2">
              <div className="text-[11px] text-mor-green">已收</div>
              <div className="text-lg font-semibold tabular-nums text-mor-green">${fmt(received)}</div>
            </div>
            <div className="rounded-lg bg-amber-50 px-3 py-2">
              <div className="text-[11px] text-amber-700">尚欠</div>
              <div className="text-lg font-semibold tabular-nums text-amber-700">${fmt(rest)}</div>
            </div>
          </div>

          <div className="text-center">
            <span className={`inline-block rounded-full px-2.5 py-0.5 text-[11px] font-medium ${DEP_STATUS_CLASS[status]}`}>
              {DEP_STATUS_LABEL[status]}
            </span>
          </div>

          {/*
            ★ 明細加起來跟資料庫的合計對不上時要講出來。
            兩個數字各自看都很正常，只有放在一起才看得出不對。
          */}
          {gap && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              ⚠ {gap}
            </div>
          )}

          {/*
            金額不在這裡改。押金金額是契約條件的一部分，
            來源在訂單／契約，由觸發器同步過來（migration_56）。
          */}
          {!dep.is_manual && (
            <div className="rounded-lg bg-mor-sand/60 text-gray-500 px-3 py-2 text-[11px]">
              押金金額不在這裡改 —— 請到{dep.contract_id ? '契約' : '短租訂單'}頁修改，這裡會自動同步。
            </div>
          )}

          <div>
            <div className="text-xs text-gray-500 mb-1.5">收款明細</div>
            {loading ? (
              <div className="rounded-lg border border-dashed border-mor-line py-8 text-center text-xs text-gray-400">
                載入中⋯
              </div>
            ) : rows.length === 0 ? (
              <div className="rounded-lg border border-dashed border-mor-line py-8 text-center text-sm text-gray-400">
                尚未有收款紀錄
                <div className="text-[11px] mt-1">收款可以分多次記，下面新增一筆就好</div>
              </div>
            ) : (
              <div className="border border-mor-line rounded-lg divide-y divide-mor-line/60">
                {rows.map((r) => (
                  <div key={r.id}>
                    {/*
                      點整列展開看照片 —— 不另外彈視窗。
                      這個視窗本身已經是彈窗，再疊一層在手機上會捲不完。
                    */}
                    <div className="flex items-center gap-2 px-3 py-2.5 text-sm cursor-pointer hover:bg-mor-sand/30"
                      onClick={() => setOpenId(openId === r.id ? null : r.id)}>
                      <span className="text-gray-300 text-xs w-3 shrink-0">{openId === r.id ? '▾' : '▸'}</span>
                      <div className="min-w-0 flex-1">
                        <div className="font-medium tabular-nums">${fmt(r.amount)}</div>
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
                        <Receipts kind="dp" parentId={r.id} canEdit={canEdit} label="收款證明" />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 新增一筆。收滿之後仍然開著 —— 超收要問一聲，但不擋 */}
          {canEdit && !returnedOn && (
            <div className="rounded-lg border border-mor-line p-3 space-y-2.5">
              <div className="text-xs text-gray-500">新增收款</div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                <label className="flex flex-col gap-1">
                  <span className="text-[11px] text-gray-400">收款日</span>
                  <input type="date" value={draftOn} onChange={(e) => setDraftOn(e.target.value)}
                    className={CTRL} />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[11px] text-gray-400">金額（台幣）</span>
                  {/*
                    不預先帶入尚欠金額。帶了的話最常見的操作變成「直接按送出」,
                    而分次收的第一筆本來就不是全額 —— 預設值會讓人不假思索地記錯。
                    placeholder 提示尚欠多少就夠了。
                  */}
                  <input type="number" inputMode="numeric" value={draftAmt}
                    onChange={(e) => setDraftAmt(e.target.value)}
                    placeholder={rest > 0 ? `尚欠 ${fmt(rest)}` : '0'}
                    className={`${CTRL} text-right tabular-nums`} />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[11px] text-gray-400">收款方式</span>
                  <select value={draftMethod} onChange={(e) => setDraftMethod(e.target.value)}
                    className={CTRL}>
                    {METHOD_OPTS.map((m) => <option key={m} value={m}>{METHOD_LABEL[m]}</option>)}
                  </select>
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[11px] text-gray-400">安幸收款帳號</span>
                  {/* 只有匯款對得到帳戶。現金／信用卡／加密貨幣硬指定一個帳號,
                      只會讓對帳的人以為錢真的進了那個戶頭（見 lib/pay-method） */}
                  <select value={draftAcct} onChange={(e) => setDraftAcct(e.target.value)}
                    disabled={!needsAccount(draftMethod)}
                    className={`${CTRL} disabled:bg-gray-50 disabled:text-gray-400`}>
                    <option value="">未指定</option>
                    {accounts.map((a) => <option key={a.code} value={a.code}>{a.name}</option>)}
                  </select>
                </label>
              </div>

              <label className="flex flex-col gap-1">
                <span className="text-[11px] text-gray-400">備註（選填）</span>
                <input value={draftNote} onChange={(e) => setDraftNote(e.target.value)}
                  placeholder="訂金、尾款⋯" className={CTRL} />
              </label>

              {/* 還沒有收款 id，照片先暫存在瀏覽器裡，insert 之後才 flush */}
              <Receipts ref={receiptsRef} kind="dp" parentId={null} canEdit label="收款證明（選填）" />

              <button onClick={add} disabled={busy}
                className="w-full h-11 md:h-10 rounded-lg bg-mor-slate text-white text-sm font-medium
                  hover:bg-mor-slatedark disabled:opacity-50">
                新增這筆收款
              </button>
            </div>
          )}

          {/*
            ══════════ 退押金 ══════════

            這裡只放憑證與說明。**退款流程（送審／核可／實際匯出）留在押金詳情頁** ——
            那是兩票審核的地方，搬過來會變成兩個入口各做一半。
          */}
          <div className="pt-3 border-t border-mor-line space-y-2">
            <div className="text-xs text-gray-500">退押金</div>
            {returnedOn ? (
              <div className="rounded-lg bg-mor-sand/60 px-3 py-2 text-xs text-gray-600">
                已於 {returnedOn} 退款。收款明細保留不動 —— 那是錢曾經進來過的紀錄。
              </div>
            ) : rest > 0 ? (
              <div className="rounded-lg bg-mor-sand/60 px-3 py-2 text-xs text-gray-500">
                還沒收滿（尚欠 ${fmt(rest)}），收齊之後才能申請退款。
              </div>
            ) : (
              <div className="rounded-lg bg-mor-sand/60 px-3 py-2 text-xs text-gray-500">
                退款申請在押金詳情裡送出（要主管與總經理各一票）。
              </div>
            )}
            <Receipts kind="dep" parentId={dep.id} canEdit={canEdit} label="退款憑證" />
          </div>
        </div>

        <div className="sticky bottom-0 bg-white border-t border-mor-line px-4 md:px-6 py-3"
          style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}>
          <button onClick={onClose} className="w-full h-11 rounded-lg border border-gray-300 text-sm">關閉</button>
        </div>
      </div>
    </div>
  );
}
