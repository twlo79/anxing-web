'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase';
import { savedToast, savedText } from '@/lib/saved-feedback';
import { writeError } from '@/lib/write-guard';
import { looksLikeError } from '@/lib/flash-kind';
import { ymShow } from '@/lib/period';

/**
 * 設定 → 發票（migration_307，2026-10-01）
 *
 * 兩個全公司的開關：
 *   · 待開發票從哪個月起算（work_settings.invoice_from_ym）—— 之前的月份不列、不算逾期
 *   · 哪些物業的新契約預設要開發票（estates.invoice_default）—— ★ 只有正隆；其他物業要開才在契約上勾
 * 改了只影響「待開清單列什麼」與「新契約預設勾不勾」。已經開的發票、既有契約的設定都不動。
 */
type Estate = { id: string; name: string; sort: number; invoice_default: boolean };

export default function InvoiceTab() {
  const supabase = useMemo(() => createClient(), []);
  const [fromYm, setFromYm] = useState('');
  const [estates, setEstates] = useState<Estate[]>([]);
  const [msg, setMsg] = useState('');
  const flash = (t: string) => { setMsg(t); if (!looksLikeError(t)) setTimeout(() => setMsg((m) => (m === t ? '' : m)), 4000); };

  const load = useCallback(async () => {
    const [{ data: ws }, { data: es }] = await Promise.all([
      supabase.from('work_settings').select('invoice_from_ym').eq('id', 1).maybeSingle(),
      supabase.from('estates').select('id, name, sort, invoice_default').eq('active', true).order('sort').order('name'),
    ]);
    setFromYm((ws as { invoice_from_ym?: string | null } | null)?.invoice_from_ym ?? '');
    setEstates((es ?? []) as Estate[]);
  }, [supabase]);
  useEffect(() => { load(); }, [load]);

  async function saveFrom(dash: string) {
    // <input type="month"> 給的是 2026-09（ymDash）；資料庫存六碼 ym
    const ym = /^\d{4}-\d{2}$/.test(dash) ? dash.replace('-', '') : null;
    const r = await supabase.from('work_settings').update({ invoice_from_ym: ym }).eq('id', 1).select('id');
    const bad = writeError(r, '儲存起算月'); if (bad) return flash(bad);
    setFromYm(ym ?? '');
    savedToast(savedText('已儲存', ym ? `起算月 ${dash}` : '起算月清空'));
  }
  async function toggleEstate(e: Estate) {
    const r = await supabase.from('estates').update({ invoice_default: !e.invoice_default }).eq('id', e.id).select('id');
    const bad = writeError(r, '儲存'); if (bad) return flash(bad);
    setEstates((es) => es.map((x) => (x.id === e.id ? { ...x, invoice_default: !e.invoice_default } : x)));
    savedToast(savedText(e.invoice_default ? '已取消預設' : '已設為預設開發票', e.name));
  }

  return (
    <div className="max-w-xl space-y-4">
      {msg && <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800">{msg}</div>}

      <section className="rounded-xl border border-mor-line bg-white px-4 py-3">
        <div className="text-xs font-semibold text-gray-500 mb-2">待開發票從哪個月起算</div>
        <input type="month" value={fromYm ? ymShow(fromYm) : ''} onChange={(e) => saveFrom(e.target.value)}
          className="rounded-lg border border-mor-line px-2 py-1.5 text-ui bg-white" />
        <p className="mt-1.5 text-[11px] text-gray-400">之前的月份不列入待開、不算逾期。資料不會被改，把月份調早就回來。</p>
      </section>

      <section className="rounded-xl border border-mor-line bg-white px-4 py-3">
        <div className="text-xs font-semibold text-gray-500 mb-2">新契約預設要開發票的物業</div>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {estates.map((e) => (
            <label key={e.id} className="flex items-center gap-2 text-sm cursor-pointer">
              <input type="checkbox" checked={e.invoice_default} onChange={() => toggleEstate(e)} />
              {e.name}
            </label>
          ))}
          {!estates.length && <span className="text-xs text-gray-400">載入中…</span>}
        </div>
        <p className="mt-1.5 text-[11px] text-gray-400">只影響新增契約時「需要開發票」預設勾不勾。既有契約不動，沒勾的物業要開發票就在契約上勾。</p>
      </section>
    </div>
  );
}
