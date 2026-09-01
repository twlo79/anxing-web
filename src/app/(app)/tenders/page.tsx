'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase';
import { useOnce } from '@/lib/once';
import { useProfile } from '@/lib/profile';
import { fetchAll } from '@/lib/fetch-all';
import Toast from '@/components/Toast';
import { AddButton } from '@/components/Actions';
import { Tabs } from '@/components/Tabs';
import Req from '@/components/Req';
import Receipts, { type ReceiptsHandle } from '@/components/Receipts';
import RangeInput from '@/components/RangeInput';
import StatCard, { StatRow } from '@/components/StatCard';
import { SortTh, sortRows, type SortState, type SortCols } from '@/lib/sortable';
import {
  STATUS_LABEL, STATUS_ORDER, STATUS_CLS, isOpen,
  tenderError, fromFeed, afterImportTodo, dueHint,
  type TenderStatus,
} from '@/lib/tender';
import { FilterSearch } from '@/lib/filters';

/**
 * 標案管理（migration_179，2026-08-28）。
 *
 * ============================================================
 * 【兩個分頁在做兩件事】
 *
 *   Tab 2  追蹤器  —— 爬蟲每天推進來的。**系統負責看見**
 *   Tab 1  紀錄    —— 加星之後複製一份。**人負責決定**
 *
 * 這正是 CLAUDE.md 那條「建議，不自動」的形狀,跟同步建議那一頁一樣:
 * 系統不會自己把標案放進你的清單,它只是把東西攤在你面前。
 *
 *
 * ============================================================
 * 【★★ 為什麼追蹤器排在第二個分頁】
 *
 * 直覺是「新東西先看」,所以追蹤器排第一。但每天真正要用的是**紀錄** ——
 * 追蹤器一天看一次就夠了,而紀錄裡有截標日期在倒數。
 *
 * 一進來就看到一整頁還沒篩選的爬蟲結果,重要的那幾件事反而在第二層。
 */

type Tender = {
  id: string; name: string; source: string | null; url: string | null;
  address: string | null; due_on: string | null; status: TenderStatus;
  note: string | null; feed_id: string | null; created_at: string;
};
type Feed = {
  id: string; source: string; title: string; url: string;
  agency: string | null; posted_on: string | null; run_at: string;
  starred_at: string | null; tender_id: string | null;
};

const todayStr = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
const daysAgo = (n: number) => {
  const d = new Date(); d.setDate(d.getDate() - n);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(d);
};

const SORT_COLS: SortCols<Tender> = {
  created_at: { type: 'date', get: (r) => r.created_at },
  name:    { type: 'text', get: (r) => r.name },
  source:  { type: 'text', get: (r) => r.source ?? '' },
  address: { type: 'text', get: (r) => r.address ?? '' },
  /*
   * ★ 未填的截標日期排在**最後**，不是最前。
   *
   *   空字串在文字排序裡最小,預設會讓「未填」全部浮到最上面 ——
   *   而使用者按「截標日期」是想看**快到期的**,不是想看沒填的。
   *   沒填的那些有自己的統計卡在盯。
   */
  due_on:  { type: 'text', get: (r) => r.due_on || '9999-12-31' },
  status:  { type: 'text', get: (r) => STATUS_ORDER.indexOf(r.status) },
};

export default function TendersPage() {
  const supabase = useMemo(() => createClient(), []);
  const { profile } = useProfile();
  const [tab, setTab] = useState<'rec' | 'feed'>('rec');
  const [msg, setMsg] = useState('');
  const [msgErr, setMsgErr] = useState(false);
  const say = (t: string, err = false) => { setMsg(t); setMsgErr(err); };

  const [rows, setRows] = useState<Tender[]>([]);
  const [feed, setFeed] = useState<Feed[]>([]);
  const [loading, setLoading] = useState(true);
  const [edit, setEdit] = useState<Partial<Tender> | null>(null);
  /*
   * ★★ 檢視是**唯讀抽屜**，編輯是另一個動作（README 9.3）。
   *
   *   「檢視」直接開編輯表單的話，只想看的人會不小心改到東西 ——
   *   而且刪除是不可逆的，把它擺在「已經看過內容」之後才合理。
   */
  const [detail, setDetail] = useState<Tender | null>(null);
  /*
   * ★ 新增時檔案先留在瀏覽器（staged），存檔拿到 id 之後才真的上傳。
   *   跟支出、請款單同一套（Receipts 的 flush）。
   */
  const receiptsRef = useRef<ReceiptsHandle>(null);
  const [statusF, setStatusF] = useState('');
  const [kw, setKw] = useState('');
  const [kwIn, setKwIn] = useState('');
  const [sort, setSort] = useState<SortState>({ key: 'due_on', dir: 'asc' });

  /* 追蹤器預設只看近 30 天 —— 一年會累積兩三千筆 */
  const [fFrom, setFFrom] = useState(daysAgo(30));
  const [fTo, setFTo] = useState('');
  const [showDone, setShowDone] = useState(false);
  const [srcF, setSrcF] = useState('');

  const today = todayStr();

  const load = useCallback(async () => {
    setLoading(true);
    // ★ fetchAll:Supabase 預設最多回 1000 列且不報錯（README 9.2）
    const { rows: t, error } = await fetchAll<Tender>((f, to) =>
      supabase.from('tenders')
        .select('id, name, source, url, address, due_on, status, note, feed_id, created_at')
        .range(f, to));
    // ★ 撈失敗要講話 —— 不講的話畫面是「還沒有標案紀錄」,跟真的沒有一模一樣
    if (error) say('讀取失敗：' + error, true);
    setRows(t);
    setLoading(false);
  }, [supabase]);

  const loadFeed = useCallback(async () => {
    const { rows: f, error } = await fetchAll<Feed>((a, b) => {
      let q = supabase.from('tender_feed')
        .select('id, source, title, url, agency, posted_on, run_at, starred_at, tender_id')
        .order('run_at', { ascending: false });
      if (fFrom) q = q.gte('run_at', `${fFrom}T00:00:00Z`);
      if (fTo) q = q.lte('run_at', `${fTo}T23:59:59Z`);
      return q.range(a, b);
    });
    if (error) say('讀取失敗：' + error, true);
    setFeed(f);
  }, [supabase, fFrom, fTo]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadFeed(); }, [loadFeed]);

  /* ══════════════ 存檔 ══════════════ */
  /*
   * ★★★ 用 `useOnce` 包起來，擋住重複點擊（2026-09-01）。
   *
   *   稽核紀錄上出現同一秒鐘的三筆訂單 ＋ 三筆押金，操作人與金額完全相同 ——
   *   儲存鈕沒有 disabled，而這支是 async 且中間有好幾次 await，
   *   按第二下時第一輪還停在某個 await 上，於是兩輪各跑一次完整流程。
   *
   * ★ 閘門是 ref（同步）不是 state —— state 的更新是非同步的，
   *   快速連點三下時三次都可能讀到「還沒在存」。見 lib/once.ts。
   */
  async function saveInner() {
    if (!edit) return;
    const e = tenderError(edit);
    if (e) return say(e, true);

    const patch = {
      name: (edit.name ?? '').trim(),
      source: (edit.source ?? '').trim() || null,
      url: (edit.url ?? '').trim() || null,
      address: (edit.address ?? '').trim() || null,
      due_on: (edit.due_on ?? '').trim() || null,
      status: edit.status ?? 'watching',
      note: (edit.note ?? '').trim() || null,
      feed_id: edit.feed_id ?? null,
    };

    /*
     * ★★ 一律 `.select('id')` 並檢查長度。
     *
     *   PostgREST 遇到 RLS 擋下的 UPDATE **不會報錯**,只回空陣列 ——
     *   而畫面會說「已儲存」。這個專案為了這件事賠掉一整天（README 9.1①）。
     */
    let id = edit.id ?? '';
    if (edit.id) {
      const { data, error } = await supabase.from('tenders')
        .update(patch).eq('id', edit.id).select('id');
      if (error) return say('儲存失敗：' + error.message, true);
      if (!data?.length) return say('沒有任何一列被更新，通常是權限或這筆已經被刪了。', true);
    } else {
      const { data, error } = await supabase.from('tenders')
        .insert({ ...patch, created_by: profile?.id ?? null }).select('id');
      if (error) return say('新增失敗：' + error.message, true);
      if (!data?.length) return say('沒有新增任何一列，通常是權限問題。', true);
      id = data[0].id;
    }

    /*
     * ★★ 新增時選的檔案還留在瀏覽器裡 —— 拿到 id 之後才真的上傳。
     *
     *   附件掛在 tender_id 上,而新增當下還沒有 id。
     *   所以 Receipts 支援「先暫存、存檔後 flush」（跟支出、請款單同一套）。
     *
     * ★ flush 失敗要**單獨講**,不能跟「已儲存」混在一起 ——
     *   標案本身存進去了,只有檔案沒上去。說成「儲存失敗」的話
     *   使用者會再存一次,然後多出一筆重複的。
     */
    const fe = await receiptsRef.current?.flush(id);
    if (fe) { setEdit(null); load(); return say('標案已儲存，但附件' + fe, true); }

    setEdit(null);
    say('已儲存');
    load();
  }

  const [save, saveBusy] = useOnce(saveInner);

  /* ══════════════ 刪除 ══════════════ */
  async function del(t: Tender) {
    /*
     * ★★ 硬刪，不進回收桶。
     *
     *   `tenders` 沒有註冊進 trash 機制（那要動 trash_deletable_tables()
     *   與 trash_table_label 兩處，是另一支 migration）。
     *
     * ★ 而且正常流程**用不到刪除** —— 不投就改成「放棄」,那是一個狀態,
     *   三個月後還查得到「這個我們看過、為什麼沒投」。
     *   真的要刪的只有誤建的空白紀錄。
     *
     * ★★ 所以確認訊息要把兩件事講清楚:附件會一起消失、而且更可能你要的是「放棄」。
     */
    if (!confirm(
      `確定刪除「${t.name}」?\n\n`
      + `底下的文件與照片會一起刪掉，不可復原。\n\n`
      + `※ 如果只是決定不投，請改成狀態「放棄」—— 那樣紀錄會留著。`)) return;

    const { data, error } = await supabase.from('tenders')
      .delete().eq('id', t.id).select('id');
    if (error) return say('刪除失敗：' + error.message, true);
    if (!data?.length) return say('沒有刪掉任何一列，通常是權限或這筆已經不在了。', true);
    setDetail(null);
    say('已刪除');
    load(); loadFeed();   // ★ 追蹤器那筆的 tender_id 會被 FK 設成 null,星星要跟著變回空心
  }

  /* ══════════════ 加星建檔 ══════════════ */
  async function star(f: Feed) {
    if (f.tender_id) { setTab('rec'); setKw(f.title); setKwIn(f.title); return; }
    const draft = fromFeed({ ...f, url: f.url || null });

    const { data, error } = await supabase.from('tenders')
      .insert({ ...draft, created_by: profile?.id ?? null }).select('id');
    if (error) return say('建檔失敗：' + error.message, true);
    if (!data?.length) return say('沒有建立任何一列，通常是權限問題。', true);

    const tid = data[0].id;
    const { data: up, error: e2 } = await supabase.from('tender_feed')
      .update({ starred_at: new Date().toISOString(), starred_by: profile?.id ?? null, tender_id: tid })
      .eq('id', f.id).select('id');
    if (e2 || !up?.length) {
      /*
       * ★★ 紀錄建好了但追蹤器沒標記到 —— **要講出來**。
       *
       *   無聲的話那一筆會留在「未建檔」,使用者明天會再加一次星,
       *   然後紀錄裡出現兩筆一樣的。
       */
      say('紀錄已建立，但追蹤器那一筆沒有標記成功 —— 重新整理後如果還是空心星，請再按一次。', true);
    } else {
      const todo = afterImportTodo(draft);
      say(todo.length
        ? `已建檔。★ 還要補：${todo.join('、')} —— 爬蟲給不出這兩個欄位。`
        : '已建檔。');
    }
    load(); loadFeed();
  }

  /* ══════════════ 篩選 ══════════════ */
  const filtered = useMemo(() => {
    let out = rows;
    if (statusF === '__open') out = out.filter((r) => isOpen(r.status));
    else if (statusF) out = out.filter((r) => r.status === statusF);
    if (kw) {
      const k = kw.toLowerCase();
      out = out.filter((r) =>
        `${r.name}${r.source ?? ''}${r.address ?? ''}${r.note ?? ''}`.toLowerCase().includes(k));
    }
    return sortRows(out, sort, SORT_COLS);
  }, [rows, statusF, kw, sort]);

  const stat = useMemo(() => {
    const open = rows.filter((r) => isOpen(r.status));
    return {
      open: open.length,
      noDue: open.filter((r) => !r.due_on).length,
      soon: open.filter((r) => {
        const h = dueHint(r.due_on, today, r.status);
        return h ? /剩 [0-7] 天|今天截標/.test(h.text) : false;
      }).length,
      won: rows.filter((r) => r.status === 'won').length,
    };
  }, [rows, today]);

  const feedShown = useMemo(() => {
    let out = feed;
    if (!showDone) out = out.filter((f) => !f.tender_id);
    if (srcF) out = out.filter((f) => f.source === srcF);
    return out;
  }, [feed, showDone, srcF]);

  const sources = useMemo(
    () => [...new Set(feed.map((f) => f.source))].sort(), [feed]);

  const inp = 'rounded-lg border border-gray-300 px-2 py-1.5';

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <h1 className="mr-auto">
          標案管理 <span className="text-sm font-normal text-gray-400">政府標租・不動產標售</span>
        </h1>
        <Toast msg={msg} error={msgErr} onClose={() => setMsg('')} />
      </div>

      {/* 分頁 */}
      {/*
        ★ 數量從標籤裡搬進**徽章** —— 原本寫成「標案追蹤器（3 未建檔）」，
          那讓兩個分頁一長一短、寬度跳來跳去。
        ★ 徽章只在 > 0 時出現（見 components/Tabs.tsx）。
      */}
      <Tabs variant="browser" tone="page" className="mb-4" value={tab} onChange={setTab}
        items={[
          { key: 'rec' as const, label: '紀錄標案', badge: rows.length },
          { key: 'feed' as const, label: '標案追蹤器',
            badge: feed.filter((f) => !f.tender_id).length },
        ]} />

      {/* ══════════════ Tab 1：紀錄標案 ══════════════ */}
      {tab === 'rec' && (
        <>
          <StatRow cols={4} className="mb-4">
            <StatCard label="進行中" value={stat.open} sub={`共 ${rows.length} 筆`}
              active={statusF === '__open'} onClick={() => setStatusF(statusF === '__open' ? '' : '__open')} />
            {/*
              ★★ 「截標日期未填」要當成一張卡,不是一個小標記。
                爬蟲給不出這個欄位,所以它**永遠會有存量** ——
                不放在看得見的地方,補這件事就不會發生。
            */}
            <StatCard label="截標日期未填" value={stat.noDue} tone="amber"
              active={false} muted={stat.noDue === 0} />
            <StatCard label="七天內截標" value={stat.soon} tone="amber" muted={stat.soon === 0} />
            <StatCard label="得標" value={stat.won} muted={stat.won === 0} />
          </StatRow>

          <div className="filter-bar rounded-xl glass p-4 mb-4 flex flex-wrap items-end gap-3">
            <div>
              <label className="block text-xs text-gray-500 mb-1">狀態</label>
              <select value={statusF} onChange={(e) => setStatusF(e.target.value)} className={inp}>
                <option value="">全部</option>
                <option value="__open">進行中（關注／準備／已投）</option>
                {STATUS_ORDER.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
              </select>
            </div>
            <FilterSearch value={kwIn} onChange={setKwIn}
              onSubmit={() => setKw(kwIn.trim())} placeholder="名稱／來源／地址／筆記" />
            {(statusF || kw || kwIn) && (
              <button onClick={() => { setStatusF(''); setKw(''); setKwIn(''); }}
                className="text-gray-500 underline pb-1.5">清除</button>
            )}
          </div>

          {/*
            動作列自成一行,跟訂單頁與請款單頁同一個排法（2026-08-28 使用者指定）。

            ★ 篩選欄位一多就會把按鈕擠到第二行,而擠出來的那一行是一整片空白
              配右邊一小撮按鈕,看起來像排版壞了。自己一行就不會再被擠。

            ★ 手機 `mr-auto`:只有一個「共 N 筆」時靠左,不然它會孤零零貼在右邊。
          */}
          <div className="flex flex-wrap items-center justify-end gap-3 mb-4">
            <div className="text-xs text-gray-400 whitespace-nowrap mr-auto md:mr-0">
              共 {filtered.length} 筆
            </div>
            <AddButton onClick={() => setEdit({ status: 'watching' })}>新增標案</AddButton>
          </div>

          {loading ? (
            <div className="text-center text-gray-400 py-16">載入中…</div>
          ) : !filtered.length ? (
            <div className="rounded-xl border border-dashed border-mor-line bg-white px-6 py-16 text-center text-gray-400">
              {rows.length ? '沒有符合條件的標案。' : '還沒有標案紀錄。到「標案追蹤器」加星，或按「＋ 新增標案」。'}
            </div>
          ) : (
            <>
              {/* ── 手機卡片 ── 表格在 390px 只能橫向滑（docs/UI體檢 的 P0） */}
              <div className="md:hidden space-y-2">
                {filtered.map((r) => {
                  const h = dueHint(r.due_on, today, r.status);
                  return (
                    <button key={r.id} onClick={() => setDetail(r)}
                      className="w-full text-left rounded-xl border border-mor-line bg-white p-3">
                      <div className="flex items-start gap-2">
                        <span className="flex-1 text-sm font-medium leading-snug">{r.name}</span>
                        <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${STATUS_CLS[r.status]}`}>
                          {STATUS_LABEL[r.status]}
                        </span>
                      </div>
                      <div className="mt-1 text-xs text-gray-500">{r.source || '—'}</div>
                      <div className="mt-1 flex items-baseline gap-2 text-xs">
                        <span className="text-gray-400">{r.due_on || '截標未填'}</span>
                        {h && <span className={h.cls}>{h.text}</span>}
                      </div>
                    </button>
                  );
                })}
              </div>

              <div className="hidden md:block rounded-xl glass overflow-x-auto">
                <table className="w-full min-w-[860px] text-sm">
                  <thead>
                    <tr className="text-left text-xs text-gray-500 border-b border-mor-line bg-white/45">
                      <SortTh label="建立日" sortKey="created_at" state={sort} onSort={(k, d) => setSort({ key: k, dir: d })} />
                      <SortTh label="標案名稱" sortKey="name" state={sort} onSort={(k, d) => setSort({ key: k, dir: d })} />
                      <SortTh label="來源" sortKey="source" state={sort} onSort={(k, d) => setSort({ key: k, dir: d })} />
                      <SortTh label="地址" sortKey="address" state={sort} onSort={(k, d) => setSort({ key: k, dir: d })} />
                      <SortTh label="截標日期" sortKey="due_on" state={sort} onSort={(k, d) => setSort({ key: k, dir: d })} />
                      <SortTh label="狀態" sortKey="status" state={sort} onSort={(k, d) => setSort({ key: k, dir: d })} />
                      <th className="px-3 py-2.5 text-right">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((r) => {
                      const h = dueHint(r.due_on, today, r.status);
                      return (
                        <tr key={r.id} className="border-b border-mor-line/60 last:border-0 hover:bg-white/45">
                          {/* ★ 只到「日」。時分秒對「這筆什麼時候建的」沒有幫助,還會把欄位撐寬 */}
                          <td className="px-3 py-2.5 whitespace-nowrap text-gray-500">
                            {(r.created_at ?? '').slice(0, 10)}
                          </td>
                          <td className="px-3 py-2.5">
                            <div className="font-medium">{r.name}</div>
                            {r.note && <div className="text-xs text-gray-400 truncate max-w-[22rem]">{r.note}</div>}
                          </td>
                          <td className="px-3 py-2.5 text-gray-600">{r.source || '—'}</td>
                          {/* ★ 未填的用灰字寫出來,不要留白 —— 留白跟「不適用」長得一樣 */}
                          <td className="px-3 py-2.5">{r.address || <span className="text-gray-300">未填</span>}</td>
                          <td className="px-3 py-2.5 whitespace-nowrap">
                            <div>{r.due_on || <span className="text-gray-300">未填</span>}</div>
                            {h && <div className={`text-xs ${h.cls}`}>{h.text}</div>}
                          </td>
                          <td className="px-3 py-2.5">
                            <span className={`inline-block rounded px-1.5 py-0.5 text-[11px] font-medium ${STATUS_CLS[r.status]}`}>
                              {STATUS_LABEL[r.status]}
                            </span>
                          </td>
                          <td className="px-3 py-2.5 text-right whitespace-nowrap">
                            {r.url && (
                              <a href={r.url} target="_blank" rel="noreferrer"
                                className="text-mor-slate underline mr-3">公告</a>
                            )}
                            <button onClick={() => setDetail(r)} className="text-mor-slate underline">檢視</button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}

      {/* ══════════════ Tab 2：追蹤器 ══════════════ */}
      {tab === 'feed' && (
        <>
          <div className="rounded-lg bg-mor-sand/40 px-3 py-2 text-xs text-gray-600 mb-3">
            爬蟲每天 08:00 抓九個政府網站，<b>只收有推播到 LINE 的那些</b>（通過關鍵字、地區與日期篩選）。
            這裡是爬蟲的資料，<b>不要在這裡記筆記</b> —— 按 ☆ 建檔之後再寫。
          </div>

          <div className="filter-bar rounded-xl glass p-4 mb-4 flex flex-wrap items-end gap-3">
            <div>
              <label className="block text-xs text-gray-500 mb-1">進來的日期</label>
              <RangeInput from={fFrom} to={fTo} onChange={(f, t) => { setFFrom(f); setFTo(t); }} />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">來源</label>
              <select value={srcF} onChange={(e) => setSrcF(e.target.value)} className={inp}>
                <option value="">全部</option>
                {sources.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <label className="flex items-center gap-1.5 text-xs text-gray-600 pb-1.5">
              <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} />
              含已建檔的
            </label>
            <div className="ml-auto text-xs text-gray-400 pb-1.5">共 {feedShown.length} 筆</div>
          </div>

          {!feedShown.length ? (
            <div className="rounded-xl border border-dashed border-mor-line bg-white px-6 py-16 text-center text-gray-400">
              這個區間沒有標案。
              <span className="block text-xs mt-1">爬蟲每天 08:00 執行；空的代表那幾天沒有通過篩選的公告。</span>
            </div>
          ) : (
            <div className="space-y-2">
              {feedShown.map((f) => (
                <div key={f.id}
                  className={`rounded-xl border p-3 flex items-start gap-3 ${
                    f.tender_id ? 'border-mor-line bg-white/60' : 'border-mor-line bg-white'}`}>
                  {/*
                    ★★ 已建檔的**留著並標記**，不是讓它消失。
                      消失的話使用者會以為爬蟲漏了那一筆。
                  */}
                  <button onClick={() => star(f)}
                    title={f.tender_id ? '已建檔 —— 點擊查看紀錄' : '加入紀錄標案'}
                    className={`shrink-0 w-8 h-8 rounded-full text-lg leading-none transition-colors ${
                      f.tender_id ? 'text-amber-500' : 'text-gray-300 hover:text-amber-500 hover:bg-amber-50'}`}>
                    {f.tender_id ? '★' : '☆'}
                  </button>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium leading-snug">{f.title}</div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500">
                      <span className="rounded bg-mor-bluelight text-mor-slate px-1.5 py-0.5">{f.source}</span>
                      {f.agency && <span>{f.agency}</span>}
                      {/* ★ 寫「公告」兩個字 —— 不寫的話會被當成截標日期 */}
                      {f.posted_on && <span>公告 {f.posted_on}</span>}
                      {f.tender_id && <span className="text-amber-700">已建檔</span>}
                    </div>
                  </div>
                  {f.url && (
                    <a href={f.url} target="_blank" rel="noreferrer"
                      className="shrink-0 text-xs text-mor-slate underline pt-1">原始公告</a>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* ══════════════ 檢視抽屜（唯讀）══════════════ */}
      {/*
        ★★ 「檢視」不開編輯表單（README 9.3）。
          只想看的人不小心改到東西 —— 而且刪除是不可逆的,
          把它擺在「已經看過內容」之後才合理。

        ★ 附件在這裡是**看得到但改不動**（canEdit={false}）——
          要換檔案得先按「編輯」。同一個動作在兩個地方都做得到的話,
          使用者會不確定自己現在在哪個模式。
      */}
      {detail && (
        <div className="modal-backdrop" onClick={() => setDetail(null)}>
          <div className="modal-panel max-w-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <span className="font-medium truncate">{detail.name}</span>
              <button onClick={() => setDetail(null)} className="text-gray-400 hover:text-gray-600">✕</button>
            </div>
            <div className="modal-body space-y-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${STATUS_CLS[detail.status]}`}>
                  {STATUS_LABEL[detail.status]}
                </span>
                {(() => { const h = dueHint(detail.due_on, today, detail.status);
                  return h ? <span className={`text-xs ${h.cls}`}>{h.text}</span> : null; })()}
                <span className="text-xs text-gray-400 ml-auto">
                  建立 {(detail.created_at ?? '').slice(0, 10)}
                </span>
              </div>

              {afterImportTodo(detail).length > 0 && (
                <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800">
                  還沒填：<b>{afterImportTodo(detail).join('、')}</b>
                  {detail.feed_id && '　—— 爬蟲給不出這兩個欄位（它只抓到公告日期，不是截標日期）。'}
                </div>
              )}

              {/* ★ 未填的欄位寫「未填」,不要整列消失 —— 消失的話看的人不知道有這個欄位 */}
              <dl className="grid grid-cols-[6rem_1fr] gap-y-2 gap-x-3">
                {([['來源機關', detail.source], ['地址', detail.address],
                   ['截標日期', detail.due_on]] as const).map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="text-xs text-gray-500 pt-0.5">{k}</dt>
                    <dd>{v || <span className="text-gray-300">未填</span>}</dd>
                  </div>
                ))}
                <dt className="text-xs text-gray-500 pt-0.5">公告網址</dt>
                <dd>
                  {detail.url
                    ? <a href={detail.url} target="_blank" rel="noreferrer"
                        className="text-mor-slate underline break-all">{detail.url}</a>
                    : <span className="text-gray-300">未填</span>}
                </dd>
                <dt className="text-xs text-gray-500 pt-0.5">出處</dt>
                <dd className="text-gray-500">
                  {detail.feed_id ? '從標案追蹤器加星建檔' : '手動新增'}
                </dd>
              </dl>

              <div>
                <div className="text-xs text-gray-500 mb-1">筆記</div>
                {/* ★ whitespace-pre-line:筆記裡的換行要留著,不然多段會擠成一坨 */}
                <div className="rounded-lg bg-mor-sand/30 px-3 py-2 whitespace-pre-line min-h-[3rem]">
                  {detail.note || <span className="text-gray-300">沒有筆記</span>}
                </div>
              </div>

              <Receipts kind="td" parentId={detail.id} label="文件與照片" canEdit={false} />
            </div>
            <div className="modal-foot">
              {/* ★ 刪除放最左、跟另外兩顆分開 —— 不可逆的動作不該挨著「編輯」 */}
              <button onClick={() => del(detail)} className="btn btn-danger mr-auto">刪除</button>
              <button onClick={() => setDetail(null)} className="btn btn-ghost">關閉</button>
              <button onClick={() => { setEdit(detail); setDetail(null); }} className="btn btn-primary">編輯</button>
            </div>
          </div>
        </div>
      )}

      {/* ══════════════ 編輯視窗 ══════════════ */}
      {edit && (
        <div className="modal-backdrop" onClick={() => setEdit(null)}>
          <div className="modal-panel max-w-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <span className="font-medium">{edit.id ? '標案' : '新增標案'}</span>
              <button onClick={() => setEdit(null)} className="text-gray-400 hover:text-gray-600">✕</button>
            </div>
            <div className="modal-body space-y-3 text-sm">
              {/*
                ★★ 加星進來的還缺什麼要**寫在最上面**。
                  藏在欄位裡的話沒有人會回頭補,而截標日期正是最重要的那一個。
              */}
              {afterImportTodo(edit).length > 0 && (
                <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800">
                  還沒填：<b>{afterImportTodo(edit).join('、')}</b>
                  {edit.feed_id && '　—— 爬蟲給不出這兩個欄位（它只抓到公告日期，不是截標日期）。'}
                </div>
              )}

              <label className="block">
                <span className="text-xs text-gray-500">標案名稱 <Req /></span>
                <input value={edit.name ?? ''} onChange={(e) => setEdit({ ...edit, name: e.target.value })}
                  className={`${inp} w-full mt-1`} />
              </label>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <label className="block">
                  <span className="text-xs text-gray-500">來源機關</span>
                  <input value={edit.source ?? ''} onChange={(e) => setEdit({ ...edit, source: e.target.value })}
                    className={`${inp} w-full mt-1`} />
                </label>
                <label className="block">
                  <span className="text-xs text-gray-500">截標日期</span>
                  <input type="date" value={edit.due_on ?? ''}
                    onChange={(e) => setEdit({ ...edit, due_on: e.target.value })}
                    className={`${inp} w-full mt-1`} />
                </label>
              </div>

              <label className="block">
                <span className="text-xs text-gray-500">地址</span>
                <input value={edit.address ?? ''} onChange={(e) => setEdit({ ...edit, address: e.target.value })}
                  className={`${inp} w-full mt-1`} placeholder="爬蟲抓不到，人工填" />
              </label>

              <label className="block">
                <span className="text-xs text-gray-500">公告網址</span>
                <input value={edit.url ?? ''} onChange={(e) => setEdit({ ...edit, url: e.target.value })}
                  className={`${inp} w-full mt-1`} />
              </label>

              <label className="block">
                <span className="text-xs text-gray-500">狀態</span>
                <select value={edit.status ?? 'watching'}
                  onChange={(e) => setEdit({ ...edit, status: e.target.value as TenderStatus })}
                  className={`${inp} w-full mt-1`}>
                  {STATUS_ORDER.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
                </select>
              </label>

              <label className="block">
                <span className="text-xs text-gray-500">筆記</span>
                <textarea value={edit.note ?? ''} onChange={(e) => setEdit({ ...edit, note: e.target.value })}
                  rows={4} className={`${inp} w-full mt-1`}
                  placeholder="現場看了什麼、報價怎麼抓、為什麼放棄…" />
              </label>

              {/*
                ★★ 附件要先存檔才能上傳 —— 沒有 id 就沒有地方掛。
                  這裡寫出來,不然使用者會以為上傳壞了。
              */}
              {/*
                ★ 新增時也能選檔案 —— 先留在瀏覽器,存檔拿到 id 之後由 flush() 上傳。
                  原本寫「先存檔之後才能上傳」,那是把實作的限制丟給使用者。
              */}
              <Receipts ref={receiptsRef} kind="td" parentId={edit.id || null} label="文件與照片" />
            </div>
            <div className="modal-foot">
              <button onClick={() => setEdit(null)} className="btn btn-ghost">取消</button>
              <button onClick={save} disabled={saveBusy} className="btn btn-primary disabled:opacity-50">
                {saveBusy ? '儲存中⋯' : '儲存'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
