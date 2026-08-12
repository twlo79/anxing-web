'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase';
import { fetchAll } from '@/lib/fetch-all';
import { TABLE_LABEL, trashAge, fieldRows } from '@/lib/trash';

/**
 * 刪除紀錄（回收桶）。
 *
 * 【刪除 = 搬到這裡，原表真的 delete】
 * 所以已刪的訂單**不會**算進營收與支出 —— 那是這個設計的重點。
 * 復原就是把整列塞回去，觸發器會重新產生營收認列，數字自己回來。
 *
 * 【永久刪除只有總經理，而且留墓碑】
 * 內容清空，但「誰在什麼時候刪掉了什麼」那一列留著 ——
 * 不留的話，回收桶本身就變成一個可以湮滅紀錄的地方。
 */

const CARD = 'rounded-xl glass';

type Trash = {
  id: string; table_name: string; record_id: string;
  label: string | null;
  payload: Record<string, unknown> | null;
  children: { table: string; rows: Record<string, unknown>[] }[];
  child_count: number;
  reason: string | null;
  deleted_by: string | null; deleted_at: string;
  restored_at: string | null; restored_by: string | null;
  purged_at: string | null; purged_by: string | null;
};

type Filter = 'open' | 'restored' | 'purged' | 'all';
const FILTER_LABEL: Record<Filter, string> = {
  open: '可復原', restored: '已復原', purged: '已永久刪除', all: '全部',
};

const fmtAt = (s: string) => s.slice(0, 16).replace('T', ' ');

/**
 * @param initialTable 從網址帶進來的表格篩選。
 *   各列表頁的 🗑️ 入口會帶自己的表格 —— 從訂單頁點進來就只看訂單的刪除紀錄。
 *   不帶的話會落在「全部」，而全部裡面訂單只佔一小段,等於還要再篩一次。
 */
export default function TrashTab({ initialTable = '' }: { initialTable?: string }) {
  const supabase = useMemo(() => createClient(), []);
  const [rows, setRows] = useState<Trash[]>([]);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [role, setRole] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('open');
  const [table, setTable] = useState(initialTable);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState<{ t: string; err?: boolean } | null>(null);
  const [loading, setLoading] = useState(true);

  function ok(t: string) { setMsg({ t }); setTimeout(() => setMsg(null), 4000); }
  function fail(t: string) { setMsg({ t, err: true }); }

  const load = useCallback(async () => {
    const [{ data: { user } }, pf] = await Promise.all([
      supabase.auth.getUser(),
      supabase.from('profiles').select('id, name'),
    ]);
    if (user) {
      const { data: me } = await supabase.from('profiles').select('role').eq('id', user.id).single();
      setRole(me?.role ?? null);
    }
    setNames(new Map((pf.data ?? []).map((p) => [p.id as string, p.name as string])));

    // fetchAll：回收桶會一直長大，而「少了一截」在這一頁等於「東西不見了」
    const { rows: t, error } = await fetchAll<Trash>((f, to) =>
      supabase.from('trash').select('*').order('deleted_at', { ascending: false }).range(f, to));
    if (error) fail('讀取失敗：' + error);
    setRows(t);
    setLoading(false);
  }, [supabase]);

  useEffect(() => { load(); }, [load]);

  /** 把這筆（含子資料）裡所有 attachments 的實體檔案從 storage 移除 */
  async function purgeFiles(r: Trash) {
    const paths: string[] = [];
    const collect = (table: string, row: Record<string, unknown> | null) => {
      if (table !== 'attachments' || !row) return;
      const p = row.path;
      if (typeof p === 'string' && p) paths.push(p);
    };
    collect(r.table_name, r.payload);
    for (const c of r.children ?? []) for (const row of c.rows ?? []) collect(c.table, row);
    if (paths.length) await supabase.storage.from('receipts').remove(paths);
  }

  async function act(kind: 'restore' | 'purge', r: Trash) {
    if (kind === 'purge' && !confirm(
      `永久刪除「${r.label || TABLE_LABEL[r.table_name] || r.table_name}」？\n\n`
      + `內容會被清空，**救不回來**。\n`
      + (r.child_count ? `連同 ${r.child_count} 筆相關資料一起消失。\n` : '')
      + `\n「誰在什麼時候刪掉了什麼」這筆紀錄會留著。`
    )) return;

    setBusy(r.id);
    const { data, error } = await supabase.rpc(
      kind === 'restore' ? 'restore_trash' : 'purge_trash', { p_trash: r.id });
    if (error) { setBusy(''); return fail('失敗：' + error.message); }
    const res = data as { ok: boolean; message: string };
    if (!res?.ok) { setBusy(''); return fail(res?.message ?? '失敗'); }

    /*
     * 憑證的實體檔案要在這裡清。
     *
     * 刪除時**不刪檔案** —— 因為隨時可能復原，檔案沒了就會救回一張破圖。
     * 所以檔案一路留到「永久刪除」才清，也就是這裡。SQL 碰不到 storage，
     * 只能由前端做；失敗了也不擋，那筆已經永久刪除了，
     * 剩下的只是一個沒有人指向的孤兒檔案，不會影響任何畫面。
     */
    if (kind === 'purge') await purgeFiles(r);

    setBusy('');
    ok(res.message);
    load();
  }

  const tables = useMemo(
    () => [...new Set(rows.map((r) => r.table_name))].sort(), [rows]);

  const shown = useMemo(() => {
    const kw = q.trim().toLowerCase();
    return rows.filter((r) => {
      const state = r.purged_at ? 'purged' : r.restored_at ? 'restored' : 'open';
      if (filter !== 'all' && state !== filter) return false;
      if (table && r.table_name !== table) return false;
      if (!kw) return true;
      return [r.label, TABLE_LABEL[r.table_name], r.reason, names.get(r.deleted_by ?? '')]
        .some((v) => (v ?? '').toLowerCase().includes(kw));
    });
  }, [rows, filter, table, q, names]);

  const openCount = rows.filter((r) => !r.restored_at && !r.purged_at).length;
  const isBoss = role === 'super_admin';

  return (
    <div className="max-w-[1100px]">
      <p className="text-xs text-gray-400 mb-3">
        刪掉的東西會先放在這裡。<b>已刪除的不會算進營收與支出</b>，復原之後才會重新計入。
      </p>

      <div className="flex flex-wrap items-center gap-2 mb-3">
        <div className="inline-flex gap-1 p-1 rounded-xl bg-white/45 backdrop-blur border border-white/60">
          {(Object.keys(FILTER_LABEL) as Filter[]).map((k) => (
            <button key={k} onClick={() => setFilter(k)}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                filter === k ? 'bg-white text-mor-slate shadow-[0_2px_8px_-2px_rgba(46,56,64,0.25)]'
                             : 'text-gray-500 hover:text-gray-700'}`}>
              {FILTER_LABEL[k]}
              {k === 'open' && openCount > 0 && (
                <span className="ml-1.5 rounded-full bg-amber-100 text-amber-700 px-1.5 text-[11px]">
                  {openCount}
                </span>
              )}
            </button>
          ))}
        </div>
        <select value={table} onChange={(e) => setTable(e.target.value)}
          className="rounded-lg border border-mor-line px-3 py-2 text-sm">
          <option value="">全部類型</option>
          {tables.map((t) => <option key={t} value={t}>{TABLE_LABEL[t] ?? t}</option>)}
        </select>
        <input placeholder="搜尋內容、原因、刪除的人…" value={q} onChange={(e) => setQ(e.target.value)}
          className="rounded-lg border border-mor-line px-3 py-2 text-sm w-56" />
        <span className="text-xs text-gray-400">{shown.length} 筆</span>
      </div>

      {msg && (
        <div className={`mb-3 rounded-lg px-4 py-3 text-sm flex items-start gap-2 ${
          msg.err ? 'bg-red-50 border border-red-200 text-red-700' : 'bg-mor-greenlight text-mor-green'}`}>
          <span className="shrink-0">{msg.err ? '⚠' : '✓'}</span>
          <span className="flex-1 whitespace-pre-line leading-relaxed">{msg.t}</span>
          {msg.err && (
            <button onClick={() => setMsg(null)} className="text-red-400 hover:text-red-600 shrink-0">✕</button>
          )}
        </div>
      )}

      <div className={`${CARD} overflow-hidden`}>
        <div className="divide-y divide-mor-line/60">
          {shown.map((r) => {
            const state = r.purged_at ? 'purged' : r.restored_at ? 'restored' : 'open';
            const age = trashAge(r.deleted_at);
            const isOpen = open === r.id;
            return (
              <div key={r.id}>
                <button onClick={() => setOpen(isOpen ? null : r.id)}
                  className="w-full px-4 py-2.5 text-left hover:bg-white/45">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="shrink-0 w-16 text-center rounded bg-mor-sand/70 px-1.5 py-0.5 text-[11px] text-gray-600">
                      {TABLE_LABEL[r.table_name] ?? r.table_name}
                    </span>
                    <span className={`text-sm flex-1 min-w-0 truncate ${
                      state === 'purged' ? 'text-gray-400 line-through' : ''}`}>
                      {r.label || <span className="text-gray-400">（沒有可顯示的識別）</span>}
                    </span>
                    {r.child_count > 0 && (
                      <span className="shrink-0 text-[11px] text-gray-400">＋{r.child_count} 筆相關</span>
                    )}
                    {/* 年代標註：不自動刪，但要看得出這是很久以前的東西 */}
                    {age.old && state === 'open' && (
                      <span className="shrink-0 text-[11px] text-gray-400">{age.text}</span>
                    )}
                    <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] ${
                      state === 'open' ? 'bg-amber-50 text-amber-700 border-amber-200'
                        : state === 'restored' ? 'bg-mor-greenlight text-mor-green border-mor-green/30'
                        : 'bg-gray-100 text-gray-500 border-gray-200'}`}>
                      {state === 'open' ? '在回收桶' : state === 'restored' ? '已復原' : '已永久刪除'}
                    </span>
                    <span className="shrink-0 w-32 text-right text-[11px] text-gray-400 tabular-nums">
                      {fmtAt(r.deleted_at)}
                    </span>
                    <span className="shrink-0 w-14 text-right text-[11px] text-gray-500 truncate">
                      {names.get(r.deleted_by ?? '') ?? '系統'}
                    </span>
                  </div>
                </button>

                {isOpen && (
                  <div className="px-4 pb-4 -mt-0.5 space-y-3">
                    <div className="text-xs text-gray-500 leading-relaxed">
                      {names.get(r.deleted_by ?? '') ?? '系統'} 於 {fmtAt(r.deleted_at)} 刪除
                      {r.reason && <>・原因：{r.reason}</>}
                      {r.restored_at && (
                        <><br />{names.get(r.restored_by ?? '') ?? '—'} 於 {fmtAt(r.restored_at)} 復原</>
                      )}
                      {r.purged_at && (
                        <><br />{names.get(r.purged_by ?? '') ?? '—'} 於 {fmtAt(r.purged_at)} 永久刪除，內容已清空</>
                      )}
                    </div>

                    {r.payload ? (
                      <>
                        <FieldTable title="原始內容" data={r.payload} />
                        {r.children?.map((c, i) => (
                          <FieldList key={i} title={`${TABLE_LABEL[c.table] ?? c.table}（${c.rows.length} 筆）`}
                            rows={c.rows} />
                        ))}
                      </>
                    ) : (
                      <div className="rounded-lg bg-gray-50 border border-mor-line px-3 py-2 text-xs text-gray-500">
                        內容已在永久刪除時清空。
                      </div>
                    )}

                    {state === 'open' && (
                      <div className="flex flex-wrap items-center gap-2">
                        <button onClick={() => act('restore', r)} disabled={busy === r.id}
                          className="rounded-lg px-4 py-2 text-sm font-medium bg-mor-slate text-white
                                     hover:bg-mor-slatedark disabled:opacity-40">
                          {busy === r.id ? '處理中…' : '復原'}
                        </button>
                        {/*
                          永久刪除只有總經理。其他人連按鈕都不顯示 ——
                          灰掉的按鈕會讓人一直去點，然後來問為什麼不能用。
                        */}
                        {isBoss && (
                          <button onClick={() => act('purge', r)} disabled={busy === r.id}
                            className="rounded-lg px-3 py-2 text-sm border border-red-200 text-red-600
                                       hover:bg-red-50 disabled:opacity-40">
                            永久刪除
                          </button>
                        )}
                        <span className="text-xs text-gray-400">
                          {isBoss ? '永久刪除之後救不回來。' : '要永久清掉請找總經理。'}
                        </span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {!shown.length && (
            <div className="px-4 py-12 text-center text-sm text-gray-400">
              {loading ? '載入中…' : filter === 'open' ? '回收桶是空的 👍' : '沒有符合的紀錄'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** 單列資料：欄位名 ＋ 值。空值不顯示 —— 一列 40 個 null 沒有人看得下去。 */
function FieldTable({ title, data }: { title: string; data: Record<string, unknown> }) {
  const rows = fieldRows(data);
  return (
    <div className="rounded-lg border border-mor-line overflow-hidden">
      <div className="px-3 py-1.5 bg-mor-sand/50 text-xs font-medium text-gray-600">{title}</div>
      <div className="grid sm:grid-cols-2 gap-x-4 px-3 py-2 text-xs">
        {rows.map(([k, v]) => (
          <div key={k} className="flex gap-2 py-0.5 border-b border-mor-line/40 last:border-0">
            <span className="w-32 shrink-0 text-gray-400 truncate">{k}</span>
            <span className="flex-1 min-w-0 break-all">{v}</span>
          </div>
        ))}
        {!rows.length && <div className="text-gray-400 py-1">（沒有內容）</div>}
      </div>
    </div>
  );
}

/** 多列子資料：只顯示前三筆的摘要，全部展開沒有意義（可能有幾十筆） */
function FieldList({ title, rows }: { title: string; rows: Record<string, unknown>[] }) {
  const [all, setAll] = useState(false);
  const show = all ? rows : rows.slice(0, 3);
  return (
    <div className="rounded-lg border border-mor-line overflow-hidden">
      <div className="px-3 py-1.5 bg-mor-sand/50 text-xs font-medium text-gray-600 flex items-center gap-2">
        <span className="flex-1">{title}</span>
        {rows.length > 3 && (
          <button onClick={() => setAll(!all)} className="text-[11px] text-mor-slate underline">
            {all ? '收起' : `展開全部 ${rows.length} 筆`}
          </button>
        )}
      </div>
      <div className="px-3 py-2 text-xs space-y-1">
        {show.map((r, i) => (
          <div key={i} className="break-all text-gray-600">
            {fieldRows(r).slice(0, 6).map(([k, v]) => `${k}=${v}`).join('　')}
          </div>
        ))}
        {!all && rows.length > 3 && <div className="text-gray-400">…還有 {rows.length - 3} 筆</div>}
      </div>
    </div>
  );
}
