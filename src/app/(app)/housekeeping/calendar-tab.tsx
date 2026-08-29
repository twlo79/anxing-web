'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase';
import { monthGrid, shiftMonth, twToday } from '@/lib/attendance-ui';
import {
  byDate, dayCounts, isAuto, isPending, linenSets, sortTasks,
  displayTitle, timeRangeText, startKeyOf,
  toneOfType, TYPE_LEGEND, type TaskView,
} from '@/lib/hk-task';
import ImportPanel from './import-panel';
import TaskForm, { emptyDraft, draftOf, type TaskDraft } from './task-form';

/**
 * 房務行事曆：每天哪些房源要清、誰負責。
 *
 * ============================================================
 * 【格子裡是「工作」，不是「幾間」】（2026-08-14 使用者指定）
 *
 * 上一版寫的是「庭玉 1・Una 2」—— 那回答的是「誰在」，但看行事曆的人
 * 真正要問的是「**今天要做什麼**」。
 *
 * 「庭玉 1」看不出是哪一間、退房還是入住、客人是誰。要知道就得點進去 ——
 * 而一個月三十天、每天都要點進去看的行事曆等於沒有行事曆。
 *
 * 所以每一筆工作各佔一條，直接寫「退房清潔 A15・Kevin」。
 * 格子也拉高了：一眼要看得完，比「排得下」重要。
 *
 *
 * ============================================================
 * 【自動長出來的用灰色】
 *
 * 退房/入住清潔是從訂單推導的（migration_121），不是誰排的。
 * 用人的顏色畫會讓人以為「有人安排過了」，然後那些沒指派的
 * 就這樣一直沒人去做。
 *
 * 灰色 ＋ 明寫「自動填入」＝ **這是系統猜的，還要你指派。**
 * 一旦指派給人，就換成那個人的顏色 —— 顏色的變化本身就是進度。
 *
 *
 * ============================================================
 * 【為什麼不再讀 TimeTree 的 hk_work_item】
 *
 * 那份資料是「人在日曆打字、每月匯入、字串解析」來的。
 * 現在工作有自己的表（hk_task），而且跟訂單連動 ——
 * 兩份都畫在同一個月曆上會變成同一件事出現兩次。
 *
 * 「排班統計」分頁還在讀 TimeTree，那是刻意的：先並行一陣子，
 * 兩邊數字對得起來再停掉匯入。
 */

const DOW = ['日', '一', '二', '三', '四', '五', '六'];

/*
 * 【顏色按工作類型，不按人】（2026-08-16 使用者指定：照 TimeTree）
 *
 * 他們在 TimeTree 上就是這樣用的:藍＝退房、綠＝入住、紫＝清潔、黃＝休假。
 * 打開月曆掃一眼，看到的是「今天有幾件退房、幾件入住」——
 * 那是排班要回答的第一個問題。
 *
 * 按人配色回答的是「誰今天比較忙」，但那要先記住六個人各是什麼顏色，
 * 而人會換、會離職，顏色跟著位移，記憶就作廢了。工作類型不會換。
 *
 * 配色表與分類規則在 lib/hk-task.ts（有測試釘住「退房清潔」不會撞到「清潔」）。
 */

type Prop = { id: string; name: string; beds: number | null; count_linen: boolean };
type Staff = { id: string; name: string; active: boolean };

/** 手動加工作時可選的類型。跟排班統計那邊同一組 */
const WORK_TYPES = [
  '退房清潔', '入住清潔', '換房清潔', '細清', '公區清潔',
  '贈品補充', '點交', '拆備品', '清潔', '其他工時',
];

export default function CalendarTab({
  onMsg, canEdit,
}: { onMsg: (t: string, err?: boolean) => void; canEdit: boolean }) {
  const supabase = useMemo(() => createClient(), []);
  const now = new Date();
  const [[y, m], setYm] = useState<[number, number]>([now.getFullYear(), now.getMonth() + 1]);
  const [tasks, setTasks] = useState<TaskView[]>([]);
  const [props, setProps] = useState<Prop[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [sel, setSel] = useState<string | null>(twToday());
  const [loading, setLoading] = useState(true);
  /*
   * 新增／編輯用同一張表單（照 TimeTree）。null = 沒開。
   *
   * 原本新增是三個下拉並排、編輯只能改指派 —— 兩條不一樣的路，
   * 而「我剛剛新增時填得到房源，為什麼改的時候不行」是必然會被問的。
   */
  const [form, setForm] = useState<TaskDraft | null>(null);
  const [saving, setSaving] = useState(false);
  /*
   * 匯入 TimeTree 排班。放在行事曆這一頁而不是排班統計 ——
   * 匯入改變的是這個畫面，按完格子就從灰色變成各人的顏色，
   * 那個變化本身就是「成功了」的證據。
   */
  const [importing, setImporting] = useState(false);


  const grid = useMemo(() => monthGrid(y, m), [y, m]);
  const from = grid[0].date;
  const to = grid[41].date;
  const today = twToday();

  const load = useCallback(async () => {
    setLoading(true);
    // 範圍用整個 42 格,不是當月 —— 月初月底跨月的那幾格也要有資料,
    // 不然一號在畫面上會突然變成空白
    const [{ data: tk, error }, { data: pr }, { data: st }] = await Promise.all([
      supabase.from('hk_task')
        .select('id, work_date, property_id, work_type, staff_id, auto_kind, done_at, note, order_id, accepted, title, all_day, start_time, end_time, orders(guest_name)')
        .gte('work_date', from).lte('work_date', to).order('work_date'),
      supabase.from('properties').select('id, name, beds, count_linen').order('name'),
      supabase.from('staff').select('id, name, active').order('sort').order('name'),
    ]);
    // 讀不到就講出來。RLS 擋掉的查詢會回空陣列而不是錯誤 ——
    // 靜靜顯示空月曆的話，看起來就像「這個月沒有排班」
    if (error) onMsg('讀取房務工作失敗：' + error.message, true);

    const ps = (pr ?? []) as Prop[];
    const ss = (st ?? []) as Staff[];
    const pName = new Map(ps.map((p) => [p.id, p.name]));
    const sName = new Map(ss.map((s) => [s.id, s.name]));
    setProps(ps);
    setStaff(ss);
    setTasks(((tk ?? []) as unknown as (TaskView & { orders?: { guest_name: string | null } | null })[])
      .map((t) => ({
        ...t,
        room: t.property_id ? pName.get(t.property_id) ?? null : null,
        guest: t.orders?.guest_name ?? null,
        staff: t.staff_id ? sName.get(t.staff_id) ?? null : null,
      })));
    setLoading(false);
  }, [supabase, from, to, onMsg]);

  useEffect(() => { load(); }, [load]);

  const perDay = useMemo(() => byDate(tasks), [tasks]);
  /** 自動長出來的 id。表單要靠它決定給不給刪 */
  const autoIds = useMemo(() => new Set(tasks.filter(isAuto).map((t) => t.id)), [tasks]);
  const bedsOf = useCallback((id: string) => props.find((p) => p.id === id)?.beds, [props]);
  const linenOf = useCallback((id: string) => props.find((p) => p.id === id)?.count_linen !== false, [props]);

  const selList = sel ? perDay[sel] ?? [] : [];
  const selCount = dayCounts(selList);
  const selLinen = linenSets(selList, bedsOf, linenOf);

  /** 指派／取消指派。空字串 = 收回，變回未指派 */
  async function assign(id: string, staffId: string) {
    const { data, error } = await supabase.from('hk_task')
      .update({ staff_id: staffId || null }).eq('id', id).select('id');
    if (error) return onMsg('指派失敗：' + error.message, true);
    // RLS 擋掉的 update 會回成功而且影響 0 列 —— 不檢查的話畫面說成功、
    // 資料一個字都沒變，而那比報錯更難查
    if (!data?.length) return onMsg('指派沒有存進去 —— 你的帳號沒有排班的權限。', true);
    load();
  }

  /**
   * 接受建議 —— 自動長出來的工作放上行事曆（migration_133）。
   *
   * 沒有「拒絕」按鈕:訂單還在，工作就還在。要它消失請改訂單
   * （取消或改日期），不然下次觸發器又會把它長回來，
   * 而那時人會以為系統壞了。
   */
  async function accept(id: string) {
    const { data, error } = await supabase.from('hk_task')
      .update({ accepted: true }).eq('id', id).select('id');
    if (error) return onMsg('接受失敗：' + error.message, true);
    if (!data?.length) return onMsg('沒有存進去 —— 你的帳號沒有排班的權限。', true);
    load();
  }

  async function toggleDone(id: string, done: boolean) {
    const { data, error } = await supabase.from('hk_task')
      .update({ done_at: done ? new Date().toISOString() : null }).eq('id', id).select('id');
    if (error) return onMsg('更新失敗：' + error.message, true);
    if (!data?.length) return onMsg('沒有存進去 —— 你的帳號沒有排班的權限。', true);
    load();
  }

  /**
   * 存表單。新增與編輯走同一支 —— 有 id 就 update，沒有就 insert。
   *
   * 分兩支的話「編輯時能不能改房源」這種問題會有兩個答案，
   * 而使用者只會記住其中一個。
   */
  async function saveForm() {
    if (!form) return;
    setSaving(true);
    try {
      const row = {
        work_date: form.work_date,
        title: form.title.trim() || null,
        all_day: form.all_day,
        /*
         * 全天時把時間寫成 null。
         *
         * 留著的話「全天」的工作在資料庫裡有時間 —— 之後有人寫報表
         * 直接讀 start_time，那些全天的會突然有 09:00。
         * 畫面上切換時保留（使用者只是切過去看一下），存的時候才清掉。
         */
        start_time: form.all_day ? null : form.start_time || null,
        end_time: form.all_day ? null : form.end_time || null,
        work_type: form.work_type,
        staff_id: form.staff_id || null,
        property_id: form.property_id || null,
        note: form.note.trim() || null,
      };

      const q = form.id
        ? supabase.from('hk_task').update(row).eq('id', form.id).select('id')
        : supabase.from('hk_task').insert(row).select('id');
      const { data, error } = await q;
      if (error) return onMsg((form.id ? '儲存' : '新增') + '失敗：' + error.message, true);
      // RLS 擋掉的 update 會回成功而且影響 0 列 —— 不檢查的話畫面說成功、
      // 資料一個字都沒變
      if (!data?.length) return onMsg('沒有存進去 —— 你的帳號沒有排班的權限。', true);

      setForm(null);
      onMsg(form.id ? '已儲存' : '已新增');
      load();
    } finally { setSaving(false); }
  }

  async function removeTask(t: TaskView) {
    if (isAuto(t)) {
      return onMsg('這筆是從訂單自動長出來的,不能直接刪 —— 要拿掉請改訂單（取消或改日期）。', true);
    }
    if (!confirm(`刪掉「${displayTitle(t)}」？`)) return;
    const { error } = await supabase.from('hk_task').delete().eq('id', t.id);
    if (error) return onMsg('刪除失敗：' + error.message, true);
    onMsg('已刪除'); load();
  }

  return (
    <div className="space-y-3">
      {importing && (
        <ImportPanel onClose={() => setImporting(false)} onDone={load} onMsg={onMsg} />
      )}
      {form && (
        <TaskForm
          draft={form} setDraft={setForm}
          workTypes={WORK_TYPES}
          staff={staff} props={props}
          onSave={saveForm} onClose={() => setForm(null)} saving={saving}
          /*
           * 自動長出來的不給刪 —— 訂單還在，工作就還在。
           * 給了刪除鈕的話，下次觸發器又會把它長回來，
           * 而那時人會以為系統壞了。
           */
          onDelete={form.id && !autoIds.has(form.id)
            ? () => { const t = tasks.find((x) => x.id === form.id); if (t) removeTask(t); }
            : undefined}
        />
      )}
      <div className="flex items-center gap-2 px-4 md:px-0">
        <button onClick={() => setYm(shiftMonth(y, m, -1))}
          className="rounded-lg border border-mor-line w-9 h-9 hover:bg-mor-sand/60">‹</button>
        <div className="text-base font-semibold w-28 text-center tabular-nums">{y} 年 {m} 月</div>
        <button onClick={() => setYm(shiftMonth(y, m, 1))}
          className="rounded-lg border border-mor-line w-9 h-9 hover:bg-mor-sand/60">›</button>
        <button onClick={() => { setYm([now.getFullYear(), now.getMonth() + 1]); setSel(today); }}
          className="rounded-lg border border-mor-line px-3 h-9 text-sm hover:bg-mor-sand/60">今天</button>
        {canEdit && (
          <button onClick={() => setImporting(true)}
            className="rounded-lg border border-mor-slate text-mor-slate px-3 h-9 text-sm font-medium hover:bg-mor-sand/60">
            ⬆ 匯入 TimeTree
          </button>
        )}
        {/* 空白的月曆跟還沒載完的月曆長得一模一樣,那個要分得出來 */}
        {loading && <span className="text-xs text-gray-400">載入中…</span>}
      </div>

      {/*
        圖例。顏色是分類，而分類沒有標示就只是好看的顏色 ——
        第一次打開的人不知道藍色是退房還是入住。

        放在月曆上方而不是下方:要先知道規則再看內容，
        放下面的話人會先困惑一次再往下找。
      */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 md:px-0 text-[11px] text-gray-500">
        {TYPE_LEGEND.map(({ key, tone }) => (
          <span key={key} className="inline-flex items-center gap-1">
            <span className="w-3 h-3 rounded-[2px] inline-block"
              style={{ backgroundColor: tone.bg }} />
            {key}
          </span>
        ))}
        <span className="inline-flex items-center gap-1">
          <span className="w-3 h-3 rounded-[2px] inline-block border border-dashed border-gray-300 bg-white" />
          待確認
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="w-3 h-3 rounded-[2px] inline-block border border-dashed"
            style={{ borderColor: '#4FC3F7', backgroundColor: '#4FC3F71A' }} />
          未指派
        </span>
      </div>

      {/*
        整片月曆自己捲。格子拉高之後整頁會很長，而月份切換鈕在最上面 ——
        看到月底想換月要滑回頂端。
      */}
      {/* 手機滿版:七欄月曆在 390px 上，每欄多 5px 就是多一個字 */}
      <div className="glass overflow-hidden md:rounded-xl">
        <div className="grid grid-cols-7 text-center text-[11px] md:text-xs text-gray-500 border-b border-mor-line/60">
          {DOW.map((d, i) => (
            <div key={d} className={`py-2 ${i === 0 || i === 6 ? 'text-red-400' : ''}`}>{d}</div>
          ))}
        </div>
        <div className="grid grid-cols-7">
          {grid.map((c) => {
            const list = perDay[c.date] ?? [];
            const cnt = dayCounts(list);
            return (
              <button key={c.date} onClick={() => setSel(c.date === sel ? null : c.date)}
                className={`min-h-[5.5rem] md:min-h-[7.5rem] border-b border-r border-mor-line/60
                  p-0.5 md:p-1 text-left
                  align-top hover:bg-white/45 transition-colors
                  ${!c.inMonth ? 'bg-gray-50/60' : ''}
                  ${sel === c.date ? 'ring-2 ring-inset ring-mor-slate' : ''}`}>
                <div className="flex items-center gap-1 mb-1">
                  {/*
                    今天用實心黑圓包住數字（TimeTree 的做法），週末數字紅色。
                    原本是加粗＋旁邊一個小圓點 —— 小圓點在一格塞滿色條時看不到，
                    而「今天是哪一格」是每次打開都要先找的東西。
                  */}
                  <span className={`text-xs tabular-nums leading-none inline-flex items-center
                    justify-center w-[18px] h-[18px] rounded-full ${
                      c.date === today ? 'bg-mor-slate text-white font-bold'
                      : new Date(`${c.date}T00:00:00+08:00`).getDay() % 6 === 0
                        ? 'text-red-400' : 'text-gray-500'}`}>
                    {Number(c.date.slice(8))}
                  </span>
                  {/*
                    要人動手的東西。待確認排在未指派前面 ——
                    還沒決定要不要做的，比「要做但沒人接」更前面一步。
                  */}
                  {cnt.pending > 0 ? (
                    <span className="ml-auto text-[10px] rounded-full bg-mor-slate/15 text-mor-slate px-1.5">
                      {cnt.pending} 待確認
                    </span>
                  ) : cnt.unassigned > 0 ? (
                    <span className="ml-auto text-[10px] rounded-full bg-gray-200 text-gray-600 px-1.5">
                      {cnt.unassigned} 未派
                    </span>
                  ) : null}
                </div>
                {/*
                  【實心色條，緊密堆疊】（照 TimeTree 網頁版）

                  淺底深字在一格塞五六條時，每條之間的界線會糊掉 ——
                  五個淡藍方塊看起來像一整塊。實心條有明確邊界，
                  而顏色本身就是分類，不用再靠邊框分。

                  【未指派用虛線，不用灰色】
                  灰色會弄丟「這是退房還是入住」，而那正是要指派的人
                  第一個要知道的。虛線邊框讓「什麼工作」跟「有沒有人接」
                  各佔一個視覺通道，不用互相犧牲。
                */}
                <div className="space-y-px">
                  {list.slice(0, 5).map((t) => {
                    const tone = toneOfType(t.work_type);
                    /*
                      三個狀態，三種樣子（migration_133）：

                        待確認  白底虛線灰字      ← 系統的建議，還沒有人決定
                        已接受未指派  淡色虛線     ← 要做，但還沒人接
                        已接受已指派  實心色條     ← 排好了

                      「這個月還沒排」跟「排好了」要一眼分得出來。
                      全部沒勾的話整片是白的 —— 那是刻意的。
                    */
                    const pending = isPending(t);
                    const unassigned = !t.staff_id;
                    return (
                      <div key={t.id}
                        title={pending
                          ? `建議：${t.work_type}${t.room ? '・' + t.room : ''}（點日期展開後打勾接受）`
                          : `${t.work_type}${t.room ? '・' + t.room : ''}${t.staff ? '・' + t.staff : '（未指派）'}`}
                        className={`px-1 py-[1px] text-[10px] leading-[1.35] truncate rounded-[2px]
                          ${pending || unassigned ? 'border border-dashed' : ''}
                          ${t.done_at ? 'line-through opacity-55' : ''}`}
                        style={pending
                          ? { color: '#9CA3AF', borderColor: '#D1D5DB', backgroundColor: '#FFFFFF' }
                          : unassigned
                            ? { color: tone.bg, borderColor: tone.bg, backgroundColor: `${tone.bg}1A` }
                            : { backgroundColor: tone.bg, color: tone.fg }}>
                        {pending ? '☐ ' : ''}
                        {/* 有時間的把時間放最前面 —— 那是硬約束,比做什麼更早要知道 */}
                        {timeRangeText(t) ? `${timeRangeText(t).split('–')[0]} ` : ''}
                        {displayTitle(t)}{t.staff ? `・${t.staff}` : ''}
                      </div>
                    );
                  })}
                  {list.length > 5 && (
                    <div className="text-[10px] text-gray-400 px-1 leading-tight">＋{list.length - 5}</div>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {sel && (
        <div className="glass p-4 md:rounded-xl mx-0">
          <div className="flex flex-wrap items-baseline gap-2 mb-3">
            <div className="font-semibold tabular-nums">
              {sel}（{DOW[new Date(`${sel}T00:00:00+08:00`).getDay()]}）
            </div>
            <div className="text-xs text-gray-500">
              {selCount.total} 筆
              {selCount.unassigned > 0 && <span className="text-amber-700"> ・{selCount.unassigned} 未指派</span>}
              {selCount.done > 0 && <span className="text-mor-green"> ・{selCount.done} 已完成</span>}
              {/*
                布巾算不出來的要講出來,不能當成 0 ——
                當成 0 的話那間房就靜靜地少帶一組床單,到現場才發現
              */}
              ・布巾 {selLinen.sets} 組
              {selLinen.unknown > 0 && (
                <span className="text-amber-700" title="這幾間還沒填床數,到「權限管理 → 房源管理」補">
                  （{selLinen.unknown} 間未填床數）
                </span>
              )}
            </div>
            <div className="flex-1" />
            {canEdit && (
              <button onClick={() => setForm(emptyDraft(sel))}
                className="rounded-lg bg-mor-slate text-white px-3 py-1.5 text-sm font-medium hover:bg-mor-slatedark">
                ＋ 加工作
              </button>
            )}
            <button onClick={() => setSel(null)} className="text-gray-400 hover:text-gray-600 px-1">✕</button>
          </div>

          {!selList.length ? (
            <div className="text-sm text-gray-400 py-6 text-center">這天沒有工作</div>
          ) : (
            <div className="space-y-1.5">
              {/*
                全天排前面、其餘照開始時間（startKeyOf）——
                有指定時間的是硬約束,看的人要先掃過軟的再看硬的。
                同一組裡面再照原本的規則（未指派最前）。
              */}
              {[...sortTasks(selList)].sort((a, b) => startKeyOf(a) - startKeyOf(b)).map((t) => (
                <div key={t.id}
                  onClick={(e) => {
                    /*
                      點整列開編輯表單。按鈕上的點擊要擋掉 ——
                      不然按「完成」會同時把表單也打開。
                    */
                    if (!canEdit) return;
                    if ((e.target as HTMLElement).closest('button,select,a')) return;
                    setForm(draftOf(t));
                  }}
                  className={`flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2
                    ${canEdit ? 'cursor-pointer hover:bg-white' : ''}
                    ${isPending(t) ? 'border-dashed border-mor-slate/40 bg-white'
                      : t.done_at ? 'border-mor-line/60 bg-mor-greenlight/40'
                      : 'border-mor-line/60 bg-white/50'}`}>
                  {/*
                    【建議要打勾才上行事曆】（migration_133）

                    自動從訂單長出來的先當建議 —— 系統負責看見，人負責決定。
                    跟同步建議同一個模式。

                    勾選框放在最前面:那是這一列唯一要動手的東西，
                    而人的眼睛從左邊開始掃。
                  */}
                  {canEdit && isPending(t) && (
                    <button onClick={() => accept(t.id)} title="接受這個建議，放上行事曆"
                      className="w-6 h-6 shrink-0 rounded border-2 border-mor-slate/50 text-mor-slate
                                 hover:bg-mor-slate hover:text-white transition-colors
                                 flex items-center justify-center text-sm leading-none">
                      ✓
                    </button>
                  )}
                  <span className="rounded px-2 py-0.5 text-xs font-medium"
                    style={t.staff_id
                      ? { backgroundColor: toneOfType(t.work_type).bg, color: toneOfType(t.work_type).fg }
                      : { color: toneOfType(t.work_type).bg,
                          border: `1px dashed ${toneOfType(t.work_type).bg}`,
                          backgroundColor: `${toneOfType(t.work_type).bg}1A` }}>
                    {t.work_type}
                  </span>
                  {/* 時間在最前面。沒有就是全天 —— 不寫「全天」兩個字 */}
                  {timeRangeText(t) && (
                    <span className="text-xs tabular-nums text-gray-500 shrink-0">
                      {timeRangeText(t)}
                    </span>
                  )}
                  <span className={`text-sm ${t.done_at ? 'line-through text-gray-400' : ''}`}>
                    {t.title?.trim() || t.room || '（無房源）'}
                    {!t.title?.trim() && t.guest && (
                      <span className="text-gray-500 ml-1.5">{t.guest}</span>
                    )}
                  </span>
                  {/*
                    自動長出來的明寫出來。不寫的話看的人會以為「有人排過了」，
                    然後那些沒指派的就這樣一直沒人去做。
                  */}
                  {isAuto(t) && (
                    <span className="rounded bg-gray-100 text-gray-500 px-1.5 py-0.5 text-[11px] whitespace-nowrap"
                      title="從訂單的進退房日推導出來。改訂單日期時它會自己搬,指派會保留">
                      自動填入
                    </span>
                  )}
                  <div className="flex-1" />
                  {canEdit ? (
                    <select value={t.staff_id ?? ''} onChange={(e) => assign(t.id, e.target.value)}
                      className={`rounded-lg border px-2 py-1 text-xs w-28 ${
                        t.staff_id ? 'border-mor-line' : 'border-amber-300 bg-amber-50/50'}`}>
                      <option value="">未指派</option>
                      {staff.filter((s) => s.active || s.id === t.staff_id)
                        .map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                  ) : (
                    <span className="text-xs text-gray-500">{t.staff ?? '未指派'}</span>
                  )}
                  {canEdit && (
                    <>
                      <button onClick={() => toggleDone(t.id, !t.done_at)}
                        title={t.done_at ? '取消完成' : '標記完成'}
                        className={`w-8 h-8 rounded-lg border text-base leading-none transition-colors ${
                          t.done_at
                            ? 'border-mor-green/30 bg-mor-greenlight text-mor-green'
                            : 'border-mor-line bg-white text-gray-300 hover:text-mor-green'}`}>
                        ✓
                      </button>
                      {/* 自動的不給刪 —— 刪了下一輪同步又會長回來,而人會以為系統壞了 */}
                      {!isAuto(t) && (
                        <button onClick={() => removeTask(t)} title="刪除"
                          className="w-8 h-8 rounded-lg border border-mor-line bg-white text-gray-400
                                     text-base leading-none hover:bg-gray-100 hover:text-gray-600">
                          ✕
                        </button>
                      )}
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
