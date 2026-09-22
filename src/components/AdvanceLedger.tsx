'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase';
import { ledgerOf, type LedgerAdvance, type RepayLine } from '@/lib/advance-detail';

/**
 * 一筆暫付的「來龍去脈」—— 哪一天付多少、哪一天還多少、之後還欠多少。
 *
 * ============================================================
 * 【★★★ 為什麼要有這個元件】（2026-09-22 使用者指定）
 *
 * `advance_repayments` ＋ `advance_repayment_lines`（migration_286）
 * 從第一天就在寫，**但沒有任何一頁去讀它** —— 抽屜裡只有一個
 * 「已還 6,000」的加總，那 6,000 是哪一天還的、還進哪個帳戶、分幾次還的，
 * 一個字都看不到。
 *
 * ★★ 同一份明細要出現在**兩個抽屜**（暫付頁、其他收支帳），所以做成元件。
 *   各寫一份的話兩邊會慢慢長歪，而「哪一份才對」沒有人答得出來
 *   （CLAUDE.md：同一條規則在三個地方各寫一次）。
 *
 * ============================================================
 * 【為什麼不用 PostgREST 的巢狀 select】
 *
 * `advance_repayments(...)` 要嵌對**外鍵的約束名稱**，而那個名字是資料庫
 * 自動產生的、這個 repo 裡看不到。猜錯的話 PostgREST 回 400，
 * 而畫面上只會是一段空白的明細 —— 使用者會以為這筆沒有還過款。
 * 分成兩次查最多多一個 round trip，換一個不會猜錯的東西
 * （跟 `approve-tab` 撈姓名同一個理由）。
 */

type Props = {
  advanceId: string;
  /**
   * 這一筆暫付本身（金額、出款日、出款帳戶、結清日）。
   *
   * ★ **選填** —— 其他收支帳那一頁手上只有 `expenses.advance_id`，
   *   沒有那一列暫付的欄位。沒給就自己撈一次。
   */
  advance?: LedgerAdvance | null;
  /**
   * 講法。
   *   `advance` 暫付頁 —— 安幸的立場，金額帶正負號
   *   `book`    其他收支帳 —— 對方那本帳的立場，不帶正負號
   */
  variant?: 'advance' | 'book';
  /** 重新整理的觸發器：值變了就重撈（存完款之後用） */
  reloadKey?: unknown;
};

const fmt = (n: number) => Number(n || 0).toLocaleString('en-US');

export default function AdvanceLedger({ advanceId, advance, variant = 'advance', reloadKey }: Props) {
  const supabase = useMemo(() => createClient(), []);
  const [lines, setLines] = useState<RepayLine[]>([]);
  const [self, setSelf] = useState<LedgerAdvance | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!advanceId) { setLines([]); setLoading(false); return; }
    setLoading(true); setErr(null);

    if (!advance) {
      const { data: ap, error: e0 } = await supabase.from('advance_payments')
        .select('amount, paid_on, paid_account, refunded_on, counterparty')
        .eq('id', advanceId).maybeSingle();
      if (e0) { setErr(e0.message); setLoading(false); return; }
      setSelf((ap as LedgerAdvance) ?? null);
    }

    const { data: ls, error: e1 } = await supabase
      .from('advance_repayment_lines')
      .select('id, amount, created_at, repayment_id')
      .eq('advance_id', advanceId);
    /*
     * ★★ 錯誤要留在這一段裡，不要丟 flash ——
     *   跳在頁面最上方的訊息，抽屜開著的人看不到（anxing-ui 第二節第 5 條）。
     */
    if (e1) { setErr(e1.message); setLines([]); setLoading(false); return; }

    const ids = Array.from(new Set((ls ?? []).map((l) => l.repayment_id as string)));
    if (!ids.length) { setLines([]); setLoading(false); return; }

    const { data: rs, error: e2 } = await supabase
      .from('advance_repayments')
      .select('id, repaid_on, in_account, out_account, note')
      .in('id', ids);
    if (e2) { setErr(e2.message); setLines([]); setLoading(false); return; }

    const byId = new Map((rs ?? []).map((r) => [r.id as string, r]));
    /*
     * ★ 一張還款單可以同時扣好幾列暫付（愛皮一次匯 20,000 沖掉八筆）。
     *   這裡數的是「那一張還款單一共扣了幾列」—— 只有 > 1 才值得顯示。
     */
    const { data: sib } = await supabase
      .from('advance_repayment_lines').select('repayment_id').in('repayment_id', ids);
    const n = new Map<string, number>();
    for (const s of sib ?? []) {
      const k = s.repayment_id as string;
      n.set(k, (n.get(k) ?? 0) + 1);
    }

    setLines((ls ?? []).map((l) => {
      const r = byId.get(l.repayment_id as string);
      return {
        id: l.id as string,
        amount: Number(l.amount) || 0,
        repayment_id: l.repayment_id as string,
        repaid_on: (r?.repaid_on as string) ?? '',
        in_account: (r?.in_account as string) ?? null,
        out_account: (r?.out_account as string) ?? null,
        note: (r?.note as string) ?? null,
        created_at: (l.created_at as string) ?? null,
        siblings: n.get(l.repayment_id as string) ?? 1,
      };
    }));
    setLoading(false);
  }, [supabase, advanceId, advance]);

  useEffect(() => { load(); }, [load, reloadKey]);

  const adv = advance ?? self;
  const { rows, owe } = useMemo(
    () => ledgerOf(adv ?? { amount: 0 }, lines), [adv, lines]);
  const book = variant === 'book';

  /* ★ 還沒出款就整段不出現 —— 錢還沒出去，沒有來龍去脈可言 */
  if (!loading && !err && !adv?.paid_on) return null;

  /** 一列在畫面上叫什麼。★ 兩本帳的主詞不一樣（CLAUDE.md 統一用語）。 */
  const nameOf = (k: string) => {
    if (k === 'out') return book ? '安幸先付的' : '安幸出款';
    if (k === 'settle') return '結清（被扣）';
    return book ? '還給安幸' : `${adv?.counterparty ?? '對方'}還款`;
  };

  return (
    <div>
      <div className="flex items-baseline gap-2 mb-1">
        <span className="text-xs font-medium text-gray-600">
          {book ? '實支明細' : '這筆錢的來龍去脈'}
        </span>
        {!loading && !err && (
          <span className="text-[11px] text-gray-400">{rows.length} 筆</span>
        )}
      </div>

      {loading ? (
        <div className="py-2 text-xs text-gray-400">載入中⋯</div>
      ) : err ? (
        <div className="py-2 text-xs text-red-600">明細讀不到：{err}</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-[#FAFAF9] text-gray-500">
                <th className="px-2 py-1.5 text-left font-medium whitespace-nowrap">日期</th>
                <th className="px-2 py-1.5 text-left font-medium">發生什麼</th>
                <th className="px-2 py-1.5 text-right font-medium whitespace-nowrap">金額</th>
                <th className="px-2 py-1.5 text-right font-medium whitespace-nowrap">之後還欠</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="border-b border-mor-line/60 last:border-0">
                  <td className={`px-2 py-1.5 whitespace-nowrap ${
                    r.kind === 'in' ? 'text-mor-greendark' : 'text-amber-700'}`}>{r.date}</td>
                  <td className="px-2 py-1.5">
                    <span className={r.kind === 'in' ? 'text-mor-greendark' : 'text-amber-700'}>
                      {nameOf(r.kind)}
                    </span>
                    {(r.from || r.to) && (
                      <div className="text-[11px] text-gray-400">
                        {r.from ?? '—'}
                        {r.to ? ` → ${r.to}` : ' → 付給對方'}
                        {/* ★ 只有那一張還款單扣了兩列以上才標,單筆時它是噪音 */}
                        {(r.siblings ?? 1) > 1 && (
                          <span className="ml-1">・這次一共扣 {r.siblings} 筆</span>
                        )}
                      </div>
                    )}
                    {r.note && <div className="text-[11px] text-gray-400">{r.note}</div>}
                  </td>
                  <td className={`px-2 py-1.5 text-right tabular-nums whitespace-nowrap ${
                    r.kind === 'in' ? 'text-mor-greendark' : 'text-amber-700'}`}>
                    {book ? fmt(r.amount) : `${r.kind === 'in' ? '＋' : '−'}${fmt(r.amount)}`}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap">
                    {fmt(r.rest)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-mor-line font-medium">
                <td className="px-2 py-1.5" colSpan={3}>{book ? '還欠安幸' : '還欠'}</td>
                <td className={`px-2 py-1.5 text-right tabular-nums ${
                  owe > 0 ? 'text-amber-700' : 'text-gray-500'}`}>{fmt(owe)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}
