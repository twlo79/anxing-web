'use client';
import { useState } from 'react';
import { createClient } from '@/lib/supabase';
import { METHOD_LABEL } from '@/components/RefundFields';
import {
  planMissing, settleMissing, needsAcct, type RefundDep,
} from '@/lib/deposit-refund';

/**
 * 押金退款的「排匯款」與「確認退款日」視窗。**兩頁共用同一支。**
 *
 * ============================================================
 * 【為什麼抽出來】（2026-08-22 使用者選「抽成共用元件」）
 *
 * 這兩個動作在押金管理頁與請款審核頁都要有。
 * 各寫一份的話，下次改規則（例如現金也要記帳號）
 * 一定會漏改一邊 —— 而**漏改不會報錯**，只會有一頁的行為跟另一頁不同，
 * 等到有人說「我在那邊按得到、這邊按不到」才發現。
 *
 *
 * ============================================================
 * 【錯誤訊息在視窗裡，不用 flash】
 *
 * flash 的提示條渲染在**視窗後面**，而且只顯示幾秒。
 * 使用者按了確認、畫面沒動、訊息閃過去了 ——
 * 看到的是「按了沒反應」而不知道原因
 * （2026-08-19 主管卡了一整天就是這樣）。
 *
 *
 * 【為什麼帳號在兩步都要問】
 * 實務上真正匯出去的戶頭常常跟排定的不同。
 * 只在排匯款問的話，排錯了就再也沒有機會改 —— 請款單踩過同一個坑。
 */

const fmt = (n: number | null | undefined) => Math.round(Number(n) || 0).toLocaleString('en-US');

export type StepMode = 'plan' | 'settle';

type Dep = RefundDep & {
  id: string;
  room?: string | null;
  guest_name?: string | null;
  amount?: number | null;
  /** 送審當下的應退金額（migration_157）。null = 全額。 */
  refund_amount?: number | null;
};

export default function DepositRefundStep({
  mode, dep, accounts, onClose, onDone,
}: {
  mode: StepMode;
  dep: Dep;
  accounts: { code: string; name: string }[];
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const supabase = createClient();
  const isPlan = mode === 'plan';
  const [date, setDate] = useState(
    isPlan
      ? (dep.planned_refund_on ?? new Date().toISOString().slice(0, 10))
      // 確認退款預設帶排定的那天 —— 大部分情況就是照排定的匯出去
      : (dep.planned_refund_on ?? new Date().toISOString().slice(0, 10)));
  const [acct, setAcct] = useState(dep.returned_account ?? '');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const needAcct = needsAcct(dep.returned_method);
  const payout = Math.round(Number(dep.refund_amount ?? dep.amount) || 0);
  const hasFee = dep.refund_amount != null
    && Math.round(dep.refund_amount) !== Math.round(Number(dep.amount) || 0);

  async function go() {
    setErr('');
    // 前端已經藏了按鈕，這裡再擋一次 —— 藏按鈕擋不住重新整理後的舊畫面
    if (dep.returned_on) {
      return setErr('這筆已經退款完成了，不能再改。請關掉重新整理確認狀態。');
    }
    const miss = isPlan ? planMissing(dep, date, acct) : settleMissing(dep, date, acct);
    if (miss.length) return setErr(`請填寫：${miss.join('、')}`);

    setBusy(true);
    const patch: Record<string, unknown> = isPlan
      ? { planned_refund_on: date }
      : { returned_on: date };
    if (needAcct) patch.returned_account = acct;

    /*
     * ★★ 要看改到幾列。RLS 擋下的 UPDATE 回成功且影響 0 列 ——
     * 只看 error 的話畫面會說「已完成」而那筆押金一動也沒動。
     */
    const { data, error } = await supabase.from('deposits')
      .update(patch).eq('id', dep.id).select('id');
    setBusy(false);
    if (error) return setErr('儲存失敗：' + error.message);
    if (!data || data.length === 0) {
      return setErr('沒有任何一列被更新，通常是權限或這筆的狀態已經變了。請關掉重新整理後再試一次。');
    }
    onDone(isPlan ? '已排定匯款' : '已完成退款');
  }

  const name = [dep.room, dep.guest_name].filter(Boolean).join('・') || '押金';

  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-[60] p-4"
      onClick={onClose}>
      <div className="bg-white rounded-xl w-[420px] max-w-[92vw] shadow-xl"
        onClick={(e) => e.stopPropagation()}>
        <div className="border-b border-mor-line px-6 py-4">
          <div className="font-bold">{isPlan ? '排匯款' : '確認退款日'}</div>
          <div className="text-xs text-gray-500 mt-0.5">{name}</div>
        </div>

        <div className="p-6 text-sm space-y-3">
          {/*
            ★★ 實際要匯多少，一定要印在按鈕旁邊（migration_157）。
            有加費時押金 310,000 但只退 308,900 ——
            只顯示押金原額的話，按下去的人會照原額匯出去。
          */}
          <div className="rounded-lg bg-mor-sand/40 px-3 py-2">
            <div className="flex justify-between items-baseline">
              <span className="text-xs text-gray-600">{isPlan ? '預計匯出' : '實際匯出金額'}</span>
              <span className="font-bold tabular-nums">NT$ {fmt(payout)}</span>
            </div>
            {hasFee && (
              <div className="text-[11px] text-gray-500 mt-1">
                押金 {fmt(dep.amount)} 扣掉加費 {fmt(Math.round(Number(dep.amount) || 0) - payout)}
                。加費那部分轉成營收，押金這筆會記為全額結清。
              </div>
            )}
          </div>

          {!isPlan && dep.planned_refund_on && (
            <div className="text-xs text-mor-blue">
              預計匯款日 {dep.planned_refund_on} —— 已帶入，實際日期不同請自行修改。
            </div>
          )}

          <label className="block">
            <span className="text-xs text-gray-500">{isPlan ? '預計匯款日' : '實際退款日'}</span>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
              className="mt-1 h-11 md:h-9 w-full bg-white rounded-lg border border-mor-line px-2 text-sm" />
          </label>

          {needAcct && (
            <label className="block">
              <span className="text-xs text-gray-500">
                安幸付款帳號（我方）
                <span className="text-gray-400 ml-1">
                  ・{dep.returned_method ? METHOD_LABEL[dep.returned_method] ?? dep.returned_method : ''}
                </span>
              </span>
              <select value={acct} onChange={(e) => setAcct(e.target.value)}
                className="mt-1 h-11 md:h-9 w-full bg-white rounded-lg border border-mor-line px-2 text-sm">
                <option value="">請選擇</option>
                {accounts.map((a) => <option key={a.code} value={a.code}>{a.name}</option>)}
              </select>
            </label>
          )}

          {/*
            錯誤放在視窗裡而不是 flash —— flash 會渲染在這個視窗**後面**，
            而且幾秒就消失。使用者只會看到「按了沒反應」。
          */}
          {err && (
            <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-700">{err}</div>
          )}

          {!isPlan && (
            <div className="text-[11px] text-gray-400">
              填了實際退款日這筆就算「已退」，之後不能再改內容。
            </div>
          )}
        </div>

        <div className="border-t border-mor-line px-6 py-3 flex gap-2">
          <button onClick={onClose} disabled={busy}
            className="flex-1 h-11 md:h-9 rounded-lg border border-gray-300 text-sm">取消</button>
          <button onClick={go} disabled={busy}
            className={`flex-1 h-11 md:h-9 rounded-lg text-white text-sm font-medium disabled:opacity-40
              ${isPlan ? 'bg-mor-slate' : 'bg-mor-blue'}`}>
            {busy ? '儲存中…' : isPlan ? '排定' : '確認退款'}
          </button>
        </div>
      </div>
    </div>
  );
}
