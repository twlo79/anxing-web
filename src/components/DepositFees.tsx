'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase';
// 每一筆加費各自的憑證（migration_158）—— 掛在那一列，不是掛在押金底下
import Receipts, { type ReceiptsHandle } from '@/components/Receipts';
import { ONEOFF_PRESETS, presetOf, feeLabel } from '@/lib/fee-types';
import {
  feesTotal, refundable, checkFee, defaultFeeDate, approvalDrift,
  type DepFee,
} from '@/lib/deposit-fee';

/**
 * 押金裡的「加費」區塊。
 *
 * ============================================================
 * 【要做什麼】（2026-08-22 使用者指定）
 *
 *     押金        10,000
 *     加費 清潔費   −100
 *     ──────────────────
 *     應退          9,900   ← 用這個金額送退款審核
 *
 * 退款完成後押金記「已退 10,000」（全額結清），
 * 其中 9,900 退現金、100 轉成營收。
 *
 *
 * ============================================================
 * 【為什麼加費就是 orders 的子單】
 *
 * 訂單的一次性收入本來就是 orders（source='oneoff'）。
 * 從押金扣只是多一個 deposit_id，**不是另一種東西**:
 *
 *   押金頁   列 deposit_id = 這筆押金 → 就是下面的清單
 *   訂單頁   本來就看得到那張子單，多顯示「從押金扣除」
 *   營收     完全不用改 —— oneoff 本來就進營收報表
 *
 * 另外開一張 deposit_deductions 表的話，兩邊各記一次，
 * 總有一天對不起來 —— 而那天你只會看到
 * 「押金明細加起來跟營收不一樣」，兩邊都說自己是對的。
 *
 *
 * 【paid 一律 true】
 * 錢已經在我們手上（就是押金那筆），不是應收。
 * 留 false 的話這筆會出現在欠款清單裡，而它根本收過了。
 */

type Dep = {
  id: string;
  amount: number | null;
  returned_on: string | null;
  planned_refund_on?: string | null;
  order_id?: string | null;
  contract_id?: string | null;
  estate_id?: string | null;
  property_id?: string | null;
  room?: string | null;
  guest_name?: string | null;
  /** 送審當下核可的金額。用來偵測核可之後又被改動。 */
  approved_amount?: number | null;
};

const fmt = (n: number | null | undefined) => Math.round(Number(n) || 0).toLocaleString('en-US');
const today = () => new Date().toISOString().slice(0, 10);
const CTRL = 'h-11 md:h-9 w-full bg-white rounded-lg border border-mor-line px-2 text-sm disabled:bg-gray-50';

type Row = DepFee & { id: string };

export default function DepositFees({
  dep, canEdit, onChanged,
}: {
  dep: Dep;
  canEdit: boolean;
  /** 金額變了要通知母層 —— 送審的金額是應退小計，不是押金原額 */
  onChanged?: (refund: number) => void;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [draft, setDraft] = useState<(DepFee & { label: string }) | null>(null);
  /** 新增時照片先暫存在這裡 —— 那時候還沒有 id 可以掛。 */
  const receiptsRef = useRef<ReceiptsHandle>(null);

  const locked = !!dep.returned_on;

  const load = useCallback(async () => {
    if (!dep.id) return;
    const { data } = await supabase.from('orders')
      .select('id, checkin, amount, fee_type, item_name, note')
      .eq('deposit_id', dep.id).order('checkin');
    setRows(((data ?? []) as Record<string, unknown>[]).map((o) => ({
      id: String(o.id), date: (o.checkin as string) ?? null,
      amount: Number(o.amount) || 0,
      fee_type: (o.fee_type as string) ?? null,
      item_name: (o.item_name as string) ?? null,
      note: (o.note as string) ?? null,
    })));
  }, [supabase, dep.id]);

  useEffect(() => { load(); }, [load]);

  const total = feesTotal(rows);
  const refund = refundable(dep, rows);
  const drift = approvalDrift(dep, rows);

  // 母層要拿應退小計去送審 —— 押金原額送出去就多退了
  useEffect(() => { onChanged?.(refund); /* eslint-disable-next-line */ }, [refund]);

  function openNew() {
    const p = ONEOFF_PRESETS[0];
    setErr('');
    setDraft({
      label: p.label, date: defaultFeeDate(dep, today()), amount: 0, note: null,
    });
  }

  async function save() {
    if (!draft) return;
    setErr('');
    const chk = checkFee(dep, rows, draft);
    if (!chk.ok) return setErr(chk.error);

    setBusy(true);
    const preset = presetOf(draft.label) ?? { fee_type: draft.label, item_name: null };
    const row = {
      source: 'oneoff',
      estate_id: dep.estate_id ?? null,
      property_id: dep.property_id ?? null,
      property_raw: dep.room ?? null,
      guest_name: dep.guest_name ?? null,
      // 子單的入住＝退房＝費用日期。營收報表按這天分月。
      checkin: draft.date, checkout: draft.date, nights: 0,
      amount: Math.round(Number(draft.amount) || 0),
      ...preset,
      note: draft.note || null,
      // ★ 母訂單掛得上才掛 —— 契約來的押金沒有 order_id，掛 null 是對的
      parent_order_id: dep.order_id ?? null,
      contract_id: dep.contract_id ?? null,
      deposit_id: dep.id,
      paid: true,               // 錢已經在我們手上（就是押金那筆）
    };

    /*
     * ★★ 要看改到幾列。RLS 或觸發器擋下的寫入回成功且影響 0 列 ——
     * 只看 error 的話畫面會說「已儲存」而那筆加費根本沒進去。
     */
    const res = draft.id
      ? await supabase.from('orders').update(row).eq('id', draft.id).select('id')
      : await supabase.from('orders').insert({
        ...row, imported_via: 'manual',
        order_key: `DFEE_${dep.id.slice(0, 8)}_${Date.now()}${Math.floor(Math.random() * 1000)}`,
      }).select('id');

    setBusy(false);
    if (res.error) return setErr('存不進去：' + res.error.message);
    if (!res.data || res.data.length === 0) {
      return setErr('沒有任何一列被寫入，通常是權限或這筆押金的狀態已經變了。請重新整理後再試。');
    }
    /*
     * 加費已經寫進去了 —— 照片上傳失敗不該讓整筆消失，只提示。
     * 反過來（先傳照片再寫資料）的話，寫入失敗會留下一張沒有主人的圖。
     */
    if (!draft.id) {
      const upErr = await receiptsRef.current?.flush(res.data[0].id);
      if (upErr) setErr('加費已存，但照片上傳失敗：' + upErr);
    }
    setDraft(null);
    await load();
  }

  async function del(r: Row) {
    if (!confirm(
      `刪除這筆加費？\n\n${feeLabel(r.fee_type ?? null, r.item_name ?? null)}　$${fmt(r.amount)}\n\n`
      + `這筆同時是訂單裡的一次性收入，刪掉營收也會少這筆。\n`
      + `應退金額會變回 ${fmt(refund + Math.round(r.amount))}。`
    )) return;
    setBusy(true);
    const { error } = await supabase.from('orders').delete().eq('id', r.id);
    setBusy(false);
    if (error) return setErr('刪不掉：' + error.message);
    await load();
  }

  return (
    <div className="border-t border-mor-line pt-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-semibold text-gray-500">
          加費<span className="ml-1.5 font-normal text-gray-400">從押金扣除</span>
        </span>
        {canEdit && !locked && !draft && dep.id && (
          <button type="button" onClick={openNew} className="text-xs text-mor-blue underline">＋ 新增加費</button>
        )}
      </div>

      {err && (
        <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-700 mb-2">{err}</div>
      )}

      {!dep.id && <div className="text-[11px] text-gray-400">先存檔，才能加費。</div>}

      {rows.map((r) => (
        <div key={r.id} className="rounded-lg border border-mor-line px-3 py-2 text-sm mb-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium">{feeLabel(r.fee_type ?? null, r.item_name ?? null)}</span>
            <span className="flex items-center gap-3 shrink-0">
              <span className="tabular-nums text-red-600">−{fmt(r.amount)}</span>
              {canEdit && !locked && (
                <>
                  <button onClick={() => { setErr(''); setDraft({ ...r, label: feeLabel(r.fee_type ?? null, r.item_name ?? null) }); }}
                    disabled={busy} className="text-xs text-mor-slate underline">編輯</button>
                  <button onClick={() => del(r)} disabled={busy}
                    className="text-xs text-red-400 hover:text-red-600 underline">刪除</button>
                </>
              )}
            </span>
          </div>
          <div className="text-[11px] text-gray-400 mt-0.5">
            {r.date}{r.note ? `・${r.note}` : ''}・已建立訂單子單
          </div>

          {/*
            這一筆加費的憑證:收據、壞掉的東西的照片（migration_158）。

            ★ 掛在**這一筆**（attachments.order_id），不是掛在押金底下。
              一筆押金可以扣好幾筆加費 —— 都掛在押金上的話分不出
              哪張對哪筆，而房客問「憑什麼扣 800」時那是唯一能拿出來的東西。

            ★ 押金退掉之後改成唯讀（canEdit=false）——
              錢都匯出去了，證據不該再被換掉。
          */}
          <div className="mt-2">
            <Receipts kind="of" parentId={r.id} canEdit={canEdit && !locked} label="憑證" />
          </div>
        </div>
      ))}

      {draft && (
        <div className="rounded-lg border border-mor-slate bg-mor-sand/20 p-3 space-y-2 mb-1.5">
          <div className="flex flex-col md:flex-row gap-2">
            <select value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })}
              className={CTRL + ' md:flex-1'}>
              {ONEOFF_PRESETS.map((p) => <option key={p.label} value={p.label}>{p.label}</option>)}
            </select>
            {/*
              日期決定**營收落在哪個月**。預設帶退款日,但一定要能改 ——
              帶錯不會報錯,只會讓這筆錢落在別的月份。
            */}
            <input type="date" value={draft.date ?? ''}
              onChange={(e) => setDraft({ ...draft, date: e.target.value })}
              className={CTRL + ' md:w-40'} />
            <input type="number" inputMode="numeric" min="0" placeholder="金額"
              value={draft.amount ? draft.amount : ''}
              onChange={(e) => setDraft({ ...draft, amount: e.target.value === '' ? 0 : Number(e.target.value) })}
              className={CTRL + ' md:w-28 text-right'} />
          </div>
          <input value={draft.note ?? ''} placeholder="備註（選填）"
            onChange={(e) => setDraft({ ...draft, note: e.target.value })} className={CTRL} />
          {/*
            新增時還沒有 id 可以掛照片 —— 先暫存在瀏覽器裡，
            insert 拿到 id 之後才 flush() 真的上傳。跟收款視窗同一套。
          */}
          {!draft.id && (
            <Receipts ref={receiptsRef} kind="of" parentId={null} canEdit label="憑證（選填）" />
          )}
          <div className="flex gap-2">
            <button onClick={save} disabled={busy}
              className="flex-1 h-11 md:h-9 rounded-lg bg-mor-slate text-white text-sm font-medium">儲存</button>
            <button onClick={() => { setDraft(null); setErr(''); }}
              className="flex-1 h-11 md:h-9 rounded-lg border border-gray-300 text-sm">取消</button>
          </div>
        </div>
      )}

      {/*
        小計。**押金與應退都要印出來** ——
        只印應退的話,看的人不知道原本是多少、扣了什麼。
      */}
      <div className="rounded-lg bg-mor-sand/30 px-3 py-2.5 mt-2 text-sm">
        <div className="flex justify-between text-gray-600">
          <span>押金</span><span className="tabular-nums">{fmt(dep.amount)}</span>
        </div>
        {/*
          ★ 一筆一列，印出**科目名稱**（2026-08-22 使用者:「明細要看得出麼費用」）。

          原本印的是「加費 1 筆 −1,100」—— 數字對，但看的人不知道
          那 1,100 是管理費還是賠償金。而這張小計正是房客會問的那張:
          「為什麼只退我 308,900」。答不出來的摘要等於沒有摘要。
        */}
        {rows.map((r) => (
          <div key={r.id} className="flex justify-between text-red-600 mt-1 gap-2">
            <span className="truncate">{feeLabel(r.fee_type ?? null, r.item_name ?? null)}</span>
            <span className="tabular-nums shrink-0">−{fmt(r.amount)}</span>
          </div>
        ))}
        <div className="flex justify-between font-medium mt-1.5 pt-1.5 border-t border-mor-line">
          <span>應退</span>
          <span className={`tabular-nums ${refund < 0 ? 'text-red-600' : ''}`}>{fmt(refund)}</span>
        </div>
        {refund < 0 && (
          <div className="text-[11px] text-red-600 mt-1">
            加費超過押金了。應退不能是負數 —— 請調整加費金額。
          </div>
        )}
      </div>

      {/*
        送審之後加費被改動的提醒（2026-08-22 使用者選「確認退款前都能改」）。

        ★ 不擋,只講出來。系統負責看見,人負責決定。
          擋掉的話會計改一個字就要重跑一輪核可;不講的話,
          主管核的 9,900 跟實際退的 9,800 不一樣而沒有人知道。
      */}
      {drift && (
        <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800 mt-2">
          ⚠ {drift}　—— 核可之後加費有變動，確認退款前請再看一次。
        </div>
      )}

      {locked && (
        <div className="text-[11px] text-gray-400 mt-2">
          押金已於 {dep.returned_on} 退還，加費不能再改。
        </div>
      )}
    </div>
  );
}
