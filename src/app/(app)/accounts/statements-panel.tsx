'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase';

/**
 * 匯入紀錄 —— 每次上傳一列，可以整批撤銷。
 *
 * ============================================================
 * 【為什麼撤銷的單位是「一份對帳單」】（2026-08-18 使用者確認）
 *
 * 「整批資料區間 可以刪掉重匯」。
 *
 * 單筆刪除不做，兩個理由:
 *
 *   1. 刪一筆會讓餘額鏈斷掉 —— 而餘額是我們自己算的，
 *      少一筆之後那一筆以後的每一個數字都錯，且不會報錯。
 *   2. **下次重傳同一份 PDF，它又會回來。**
 *      人會以為系統壞了，然後再刪一次。
 *
 * 整批撤銷沒有這兩個問題:那一批的流水一起走，
 * 而重傳整份就是它原本該有的樣子。
 *
 *
 * ============================================================
 * 【期間重疊時，撤銷只會刪掉「這一批新增的」】
 *
 * 假設先匯 1–6 月，再匯 4–9 月。4–6 月那幾筆在第二次匯入時
 * 被判定為重複而跳過 —— 它們掛在**第一批**的名下。
 *
 * 所以撤銷第二批只會刪掉 7–9 月那些。這是對的，
 * 但畫面上要講清楚，不然人會以為「撤銷了卻沒刪乾淨」。
 */

type Row = {
  id: string;
  account_id: string;
  period_from: string;
  period_to: string;
  closing_balance: number | null;
  parsed_count: number;
  inserted_count: number;
  skipped_count: number;
  warnings: string[] | null;
  file_name: string | null;
  uploaded_at: string;
  note: string | null;
};

const money = (n: number | null) =>
  n == null ? '—' : '$' + Math.round(n).toLocaleString('en-US');
const when = (s: string) =>
  new Date(s).toLocaleString('zh-TW', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

export default function StatementsPanel({
  accountId,
  onChanged,
  onError,
}: {
  accountId: string;
  onChanged: (text: string) => void | Promise<void>;
  onError: (text: string) => void;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [confirming, setConfirming] = useState<Row | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    const { data, error } = await supabase
      .from('bank_statements')
      .select('*')
      .eq('account_id', accountId)
      .order('uploaded_at', { ascending: false });
    if (error) onError(`讀取匯入紀錄失敗：${error.message}`);
    setRows((data ?? []) as Row[]);
    setLoading(false);
  }, [supabase, accountId, onError]);

  useEffect(() => { load(); }, [load]);

  const undo = useCallback(async (r: Row) => {
    setBusy(true);
    try {
      /*
       * **一定要 .select('id') 看回傳幾列。**
       *
       * RLS 擋下的 DELETE 回成功且影響 0 列 —— 沒檢查的話,
       * 畫面會顯示「已撤銷」而資料一筆都沒少。
       */
      const { data: gone, error } = await supabase
        .from('bank_transactions')
        .delete()
        .eq('statement_id', r.id)
        .select('id');
      if (error) { onError(`撤銷失敗：${error.message}`); return; }

      const { data: s, error: e2 } = await supabase
        .from('bank_statements')
        .delete()
        .eq('id', r.id)
        .select('id');
      if (e2) { onError(`流水已刪，但對帳單紀錄刪不掉：${e2.message}`); return; }
      if (!s || s.length === 0) {
        onError('沒有刪掉任何東西 —— 可能是權限不足（要會計以上）');
        return;
      }

      const n = gone?.length ?? 0;
      await onChanged(
        `已撤銷：${r.period_from} ~ ${r.period_to}，刪掉 ${n} 筆` +
          // 當初「新增」的筆數跟實際刪掉的不同時要講 ——
          // 多半是後來又匯了重疊的期間，那幾筆已經改掛在別批名下
          (n !== r.inserted_count ? `（當初匯入時是 ${r.inserted_count} 筆）` : ''),
      );
      setConfirming(null);
      await load();
    } finally {
      setBusy(false);
    }
  }, [supabase, onChanged, onError, load]);

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 text-xs text-gray-600">
          <tr>
            <th className="px-3 py-2 text-left font-medium">期間</th>
            <th className="px-3 py-2 text-left font-medium">檔名</th>
            <th className="px-3 py-2 text-right font-medium">新增</th>
            <th className="px-3 py-2 text-right font-medium">重複</th>
            <th className="px-3 py-2 text-right font-medium">期末餘額</th>
            <th className="px-3 py-2 text-left font-medium">上傳</th>
            <th className="px-3 py-2" />
          </tr>
        </thead>
        <tbody>
          {loading && (
            <tr><td colSpan={7} className="px-3 py-8 text-center text-gray-400">載入中⋯</td></tr>
          )}
          {!loading && rows.length === 0 && (
            <tr><td colSpan={7} className="px-3 py-8 text-center text-gray-400">
              這個帳戶還沒有匯入過對帳單
            </td></tr>
          )}
          {rows.map((r) => (
            <tr key={r.id} className="border-t align-top hover:bg-gray-50">
              <td className="whitespace-nowrap px-3 py-2 tabular-nums">
                {r.period_from} ~ {r.period_to}
              </td>
              <td className="px-3 py-2 text-gray-600">
                <div className="max-w-[16rem] truncate" title={r.file_name ?? ''}>
                  {r.file_name ?? '—'}
                </div>
                {/* 匯入時放行的警告要一直看得見 —— 它是「當初就知道有這件事」的唯一紀錄 */}
                {r.warnings?.map((w, i) => (
                  <div key={i} className="mt-0.5 text-[11px] text-amber-700">⚠ {w}</div>
                ))}
                {r.note && <div className="mt-0.5 text-[11px] text-red-600">{r.note}</div>}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">{r.inserted_count}</td>
              <td className="px-3 py-2 text-right tabular-nums text-gray-500">
                {r.skipped_count || ''}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">{money(r.closing_balance)}</td>
              <td className="whitespace-nowrap px-3 py-2 text-gray-500">{when(r.uploaded_at)}</td>
              <td className="px-3 py-2 text-right">
                <button
                  onClick={() => setConfirming(r)}
                  className="rounded border border-red-200 px-2 py-1 text-xs text-red-600 hover:bg-red-50"
                >
                  撤銷這一批
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {confirming && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-lg bg-white p-4 shadow-xl">
            <h3 className="font-semibold">撤銷這一批匯入？</h3>
            <div className="mt-2 rounded bg-gray-50 px-3 py-2 text-sm">
              <div>{confirming.period_from} ~ {confirming.period_to}</div>
              <div className="text-gray-600">{confirming.file_name ?? '（沒記檔名）'}</div>
              <div className="mt-1">當初新增 <b>{confirming.inserted_count}</b> 筆</div>
            </div>
            <p className="mt-3 text-sm text-gray-600">
              這一批的流水會全部刪掉。
              <b>重新拖同一份 PDF 進來就回來了</b> —— 去重是靠內容，不會重複。
            </p>
            {confirming.skipped_count > 0 && (
              <p className="mt-2 text-xs text-amber-700">
                ⚠ 這次匯入時有 {confirming.skipped_count} 筆被判定為重複而跳過 ——
                那幾筆屬於更早的批次，<b>不會被這次撤銷刪掉</b>。
              </p>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setConfirming(null)}
                className="rounded-md border px-3 py-1.5 text-sm hover:bg-gray-50"
              >
                取消
              </button>
              <button
                onClick={() => undo(confirming)}
                disabled={busy}
                className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:bg-gray-300"
              >
                {busy ? '撤銷中⋯' : '確定撤銷'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
