'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase';
import { useProfile } from '@/lib/profile';
import {
  demandProgress, progressText, DEMAND_STATUS_CLASS, ITEM_STATUS_LABEL,
  type DemandItemStatus,
} from '@/lib/purchase-demand';

/**
 * 採購需求（房務管理的第三個分頁）。
 *
 * ============================================================
 * 【提需求的人這一側】
 *
 * 這一頁回答兩個問題，其餘都是次要的:
 *
 *   1. 我要的東西買了沒？
 *   2. 還缺哪幾樣？
 *
 * **不需要有請款單的權限就答得出來** —— 狀態是從自己那張需求單上讀的，
 * 不是去請款頁查。房務連請款頁的選單都沒有,如果要看進度得跑去問會計，
 * 那這個功能就只是換一個地方填 Google 表單而已。
 *
 *
 * ============================================================
 * 【為什麼一張單可以有多個項目】
 *
 * 「這次要買的東西」本來就是一串。拆成五張單的話:
 *   · 填的人要按五次新增
 *   · 會計要看五張單才知道這批要買什麼
 *   · 而它們其實是同一次採購
 *
 * 項目列的操作照請款單的形狀（使用者指定「參考請款單設計」）。
 */

type Item = {
  id?: string;
  item_name: string;
  spec: string;
  qty: number;
  estate_id: string;
  note: string;
  status: DemandItemStatus;
  request_item_id?: string | null;
  /** 這一項被哪張請款單領走。只在讀取時帶進來，存檔不寫 */
  request_no?: string | null;
};

type Demand = {
  id: string;
  demand_no: string | null;
  requester_id: string;
  requester_name?: string | null;
  requested_on: string;
  note: string | null;
  status: 'open' | 'partial' | 'done' | 'cancelled';
  items: Item[];
};

const blankItem = (): Item =>
  ({ item_name: '', spec: '', qty: 1, estate_id: '', note: '', status: 'pending' });

const inp = 'rounded-lg border border-gray-300 px-2 py-1.5 text-sm';

export default function DemandTab({ onMsg }: { onMsg: (t: string, err?: boolean) => void }) {
  const supabase = useMemo(() => createClient(), []);
  const { profile } = useProfile();
  const role = profile?.role ?? '';
  /** 會計以上看得到全部；其餘只看得到自己提的（RLS 也擋，這裡只是不要白撈） */
  const seesAll = ['accountant', 'manager', 'super_admin'].includes(role);

  const [rows, setRows] = useState<Demand[]>([]);
  const [estates, setEstates] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [edit, setEdit] = useState<{ note: string; items: Item[] } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    supabase.from('estates').select('id, name').eq('active', true).order('sort')
      .then(({ data }) => setEstates(data ?? []));
  }, [supabase]);

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from('purchase_demands')
      .select(`id, demand_no, requester_id, requested_on, note, status,
               profiles(name),
               purchase_demand_items(
                 id, item_name, spec, qty, estate_id, note, status, request_item_id,
                 purchase_request_items(purchase_requests(req_no))
               )`)
      .order('requested_on', { ascending: false })
      .order('demand_no', { ascending: false })
      .limit(200);

    setRows(((data as any[]) ?? []).map((d) => ({
      id: d.id,
      demand_no: d.demand_no,
      requester_id: d.requester_id,
      requester_name: d.profiles?.name ?? null,
      requested_on: d.requested_on,
      note: d.note,
      status: d.status,
      items: (d.purchase_demand_items ?? []).map((i: any) => ({
        id: i.id, item_name: i.item_name, spec: i.spec ?? '', qty: Number(i.qty),
        estate_id: i.estate_id, note: i.note ?? '', status: i.status,
        request_item_id: i.request_item_id,
        request_no: i.purchase_request_items?.purchase_requests?.req_no ?? null,
      })),
    })));
    setLoading(false);
  }, [supabase]);

  useEffect(() => { load(); }, [load]);

  const estateName = useMemo(
    () => Object.fromEntries(estates.map((e) => [e.id, e.name])), [estates]);

  // ── 新增 ───────────────────────────────────────────
  function startNew() {
    setEdit({ note: '', items: [blankItem()] });
  }

  async function save() {
    if (!edit || !profile) return;
    /*
     * 【前端先擋，因為資料庫的錯誤訊息看不懂】
     *
     * `item_name` 與 `estate_id` 是 NOT NULL —— 沒填的話 Supabase 會回
     * 「null value in column "estate_id" violates not-null constraint」，
     * 而填表的人不知道 estate_id 是什麼。
     */
    const items = edit.items.filter((i) => i.item_name.trim() || i.estate_id);
    if (!items.length) return onMsg('至少要填一個項目', true);
    const bad = items.findIndex((i) => !i.item_name.trim() || !i.estate_id || !(i.qty > 0));
    if (bad >= 0) return onMsg(`第 ${bad + 1} 項的品名、數量、用途都要填`, true);

    setSaving(true);
    const { data: d, error } = await supabase.from('purchase_demands')
      .insert({ requester_id: profile.id, note: edit.note.trim() || null })
      .select('id').single();
    if (error || !d) { setSaving(false); return onMsg('建立失敗：' + (error?.message ?? ''), true); }

    const { error: e2 } = await supabase.from('purchase_demand_items').insert(
      items.map((i) => ({
        demand_id: d.id, item_name: i.item_name.trim(), spec: i.spec.trim() || null,
        qty: i.qty, estate_id: i.estate_id, note: i.note.trim() || null,
      })));
    setSaving(false);
    if (e2) {
      /*
       * 項目寫失敗要把單也刪掉 —— 留一張沒有項目的空單在列表上，
       * 而它的狀態會是「尚未採購」，看起來像正常的一筆。
       */
      await supabase.from('purchase_demands').delete().eq('id', d.id);
      return onMsg('項目儲存失敗：' + e2.message, true);
    }
    setEdit(null);
    onMsg('採購需求已送出');
    load();
  }

  const setItem = (idx: number, patch: Partial<Item>) =>
    setEdit((e) => e && ({ ...e, items: e.items.map((it, i) => (i === idx ? { ...it, ...patch } : it)) }));

  // ── 畫面 ───────────────────────────────────────────
  const pendingTotal = rows.reduce((a, d) =>
    a + d.items.filter((i) => i.status === 'pending' || i.status === 'quoted').length, 0);

  return (
    <div className="px-4 md:px-0">
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <div className="text-xs text-gray-400 mr-auto">
          共 {rows.length} 張
          {pendingTotal > 0 && <span className="ml-2 text-amber-700">・{pendingTotal} 項還沒採購</span>}
        </div>
        <button onClick={startNew}
          className="rounded-lg bg-mor-slate text-white px-4 py-2 text-sm font-medium hover:bg-mor-slatedark">
          + 新增採購需求
        </button>
      </div>

      {loading ? (
        <div className="text-center text-gray-400 py-16">載入中…</div>
      ) : !rows.length ? (
        <div className="rounded-xl border border-dashed border-mor-line bg-white px-6 py-16 text-center text-gray-400">
          還沒有採購需求。按右上角新增。
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map((d) => {
            const p = demandProgress(d.items, d.status === 'cancelled');
            const isOpen = open.has(d.id);
            return (
              <div key={d.id} className="rounded-xl glass overflow-hidden">
                {/*
                  整列可點開。摘要那一行已經回答了「買了沒、還缺什麼」——
                  展開只是為了看每一項的細節，不是必要動作。
                */}
                <button onClick={() => setOpen((s) => {
                  const n = new Set(s); n.has(d.id) ? n.delete(d.id) : n.add(d.id); return n;
                })}
                  className="w-full flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-left hover:bg-mor-sand/30">
                  <span className="font-medium text-sm">{d.demand_no ?? '（未編號）'}</span>
                  {seesAll && (
                    <span className="text-xs text-gray-500">{d.requester_name ?? '—'}</span>
                  )}
                  <span className="text-xs text-gray-400">{d.requested_on}</span>
                  <span className={`ml-auto inline-block rounded-md px-2 py-0.5 text-xs font-medium
                                    ${DEMAND_STATUS_CLASS[p.status]}`}>
                    {p.label}
                  </span>
                  <span className="w-full text-xs text-gray-500">{progressText(p)}</span>
                </button>

                {isOpen && (
                  <div className="border-t border-mor-line/60 divide-y divide-mor-line/40">
                    {d.items.map((i) => (
                      <div key={i.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm">
                        <span className="font-medium">{i.item_name}</span>
                        <span className="text-gray-500">×{i.qty}</span>
                        <span className="text-xs rounded bg-mor-sand px-1.5 py-0.5">
                          {estateName[i.estate_id] ?? '—'}
                        </span>
                        {i.spec && <span className="text-xs text-gray-400">{i.spec}</span>}
                        <span className="ml-auto text-xs text-gray-500">
                          {ITEM_STATUS_LABEL[i.status]}
                          {/*
                            買了沒的答案就在這裡 —— 不用去請款頁查。
                            房務連請款頁的選單都沒有。
                          */}
                          {i.request_no && <span className="ml-1 text-mor-slate">{i.request_no}</span>}
                        </span>
                      </div>
                    ))}
                    {d.note && (
                      <div className="px-4 py-2 text-xs text-gray-500">備註：{d.note}</div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ── 新增視窗 ──────────────────────────────── */}
      {edit && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-end md:items-center justify-center"
          onClick={() => !saving && setEdit(null)}>
          <div onClick={(e) => e.stopPropagation()}
            className="bg-white w-full md:w-[720px] md:max-w-[95vw] max-h-[92vh] overflow-auto
                       rounded-t-2xl md:rounded-2xl shadow-xl">
            <div className="sticky top-0 bg-white z-10 flex items-center justify-between px-4 py-3
                            border-b border-mor-line">
              <span className="font-medium">新增採購需求</span>
              <div className="flex gap-2">
                <button onClick={() => setEdit(null)} disabled={saving}
                  className="rounded-lg border border-mor-line px-3 py-1.5 text-sm">取消</button>
                <button onClick={save} disabled={saving}
                  className="rounded-lg bg-mor-slate text-white px-4 py-1.5 text-sm font-medium
                             disabled:opacity-40">
                  {saving ? '送出中…' : '送出'}
                </button>
              </div>
            </div>

            <div className="p-4 space-y-3">
              <p className="text-xs text-gray-400">
                <b className="text-gray-500">不用填金額</b> —— 會計詢價後在轉請款時填。
                用途選<b className="text-gray-500">物業</b>不是房號，採購多半是整棟共用的。
              </p>

              {edit.items.map((it, idx) => (
                <div key={idx} className="rounded-xl border border-mor-line p-3 space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-400 w-8">{idx + 1}.</span>
                    <input value={it.item_name} onChange={(e) => setItem(idx, { item_name: e.target.value })}
                      placeholder="品名（必填）" className={`${inp} flex-1`} />
                    <input type="number" min="1" step="1" value={it.qty}
                      onChange={(e) => setItem(idx, { qty: Number(e.target.value) })}
                      className={`${inp} w-20 text-right`} />
                    {edit.items.length > 1 && (
                      <button onClick={() => setEdit((e) => e && ({ ...e, items: e.items.filter((_, i) => i !== idx) }))}
                        className="text-red-500 hover:text-red-700 text-sm px-1">✕</button>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2 pl-10">
                    <select value={it.estate_id} onChange={(e) => setItem(idx, { estate_id: e.target.value })}
                      className={`${inp} w-32`}>
                      <option value="">用途（必填）</option>
                      {estates.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                    </select>
                    <input value={it.spec} onChange={(e) => setItem(idx, { spec: e.target.value })}
                      placeholder="規格說明" className={`${inp} flex-1 min-w-[8rem]`} />
                    <input value={it.note} onChange={(e) => setItem(idx, { note: e.target.value })}
                      placeholder="備註" className={`${inp} flex-1 min-w-[8rem]`} />
                  </div>
                </div>
              ))}

              <button onClick={() => setEdit((e) => e && ({ ...e, items: [...e.items, blankItem()] }))}
                className="w-full rounded-xl border border-dashed border-mor-line py-2 text-sm
                           text-gray-500 hover:bg-mor-sand/40">
                + 加一個項目
              </button>

              <textarea value={edit.note} onChange={(e) => setEdit((x) => x && ({ ...x, note: e.target.value }))}
                rows={2} placeholder="整張單的備註（選填）"
                className={`${inp} w-full resize-y`} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
