'use client';
import { useEffect, useState } from 'react';
import { toneOfType, hhmmOf, type TaskView } from '@/lib/hk-task';

/**
 * 新增／編輯房務工作。**版面完全照 TimeTree 的事件表單**（2026-08-16 使用者指定）。
 *
 * ============================================================
 * 【為什麼照抄一個現成的表單】
 *
 * 他們已經用 TimeTree 排了兩年的班。那個表單的欄位順序、
 * 哪些收在「＋」底下、哪些一定看得到 —— 都是被用出來的，不是設計出來的。
 *
 * 自己重排一次的成本不是「做得比較醜」，是**每個人要重新學一次**，
 * 而排班是每天都在做的事。
 *
 *
 * ============================================================
 * 【由上而下：標題 → 時間 → 分類 → 人】
 *
 *     標題        大字，最上面。這是「這件事叫什麼」
 *     ───────
 *     全天        開關。關掉才出現時間
 *     開始 / 結束
 *     ───────
 *     標籤        工作類型，用顏色點標示
 *     負責人
 *     房源
 *     備註
 *
 * 分隔線把「什麼時候」跟「什麼事、誰做」分開 ——
 * 那是填表時腦裡本來就有的兩段。
 *
 *
 * ============================================================
 * 【全天是預設】
 *
 * 絕大多數房務工作沒有固定時間（「今天要清 A15」）。
 * 預設關掉時間欄位,要的人才打開 —— 而不是每次都逼人面對兩個時間輸入框。
 */

export type TaskDraft = {
  id?: string;
  work_date: string;
  title: string;
  all_day: boolean;
  start_time: string;
  end_time: string;
  work_type: string;
  staff_id: string;
  property_id: string;
  note: string;
};

export const emptyDraft = (work_date: string, work_type = '公區清潔'): TaskDraft => ({
  work_date, title: '', all_day: true,
  // 預設 09:00–10:00 —— 打開時間開關的人多半是要排一個上午的工作，
  // 從 00:00 開始的話他要改兩個欄位才用得了
  start_time: '09:00', end_time: '10:00',
  work_type, staff_id: '', property_id: '', note: '',
});

export function draftOf(t: TaskView & {
  title?: string | null; all_day?: boolean | null;
  start_time?: string | null; end_time?: string | null;
}): TaskDraft {
  return {
    id: t.id,
    work_date: t.work_date,
    title: t.title ?? '',
    all_day: t.all_day !== false,
    start_time: hhmmOf(t.start_time) || '09:00',
    end_time: hhmmOf(t.end_time) || '10:00',
    work_type: t.work_type,
    staff_id: t.staff_id ?? '',
    property_id: t.property_id ?? '',
    note: t.note ?? '',
  };
}

const ROW = 'flex items-center gap-3 px-4 py-3 border-b border-mor-line/50';
const LB = 'text-sm text-gray-500 w-20 shrink-0';

export default function TaskForm({
  draft, setDraft, workTypes, staff, props, onSave, onClose, onDelete, saving,
}: {
  draft: TaskDraft;
  setDraft: (d: TaskDraft) => void;
  workTypes: string[];
  staff: { id: string; name: string; active: boolean }[];
  props: { id: string; name: string }[];
  onSave: () => void;
  onClose: () => void;
  onDelete?: () => void;
  saving?: boolean;
}) {
  const tone = toneOfType(draft.work_type);
  const [showType, setShowType] = useState(false);

  // Esc 關掉。手機上沒有鍵盤，但桌機上按 Esc 是反射動作
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  const set = (p: Partial<TaskDraft>) => setDraft({ ...draft, ...p });

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-end md:items-center justify-center"
      onClick={onClose}>
      {/*
        手機從底部升起、桌機置中 —— TimeTree 手機版就是 bottom sheet。
        表單長，手機上從底部出來的話拇指構得到「保存」。
      */}
      <div onClick={(e) => e.stopPropagation()}
        className="bg-white w-full md:w-[460px] md:max-w-[95vw] max-h-[92vh] overflow-auto
                   rounded-t-2xl md:rounded-2xl shadow-xl">

        {/* 頂列：✕ 與 保存。TimeTree 的保存在右上角，不在最底下 */}
        <div className="sticky top-0 bg-white z-10 flex items-center justify-between px-4 py-3
                        border-b border-mor-line/50">
          <button onClick={onClose} aria-label="關閉"
            className="w-8 h-8 flex items-center justify-center text-gray-400
                       hover:text-gray-600 text-xl leading-none">✕</button>
          <button onClick={onSave} disabled={saving}
            className="rounded-full border border-mor-line px-5 py-1.5 text-sm font-medium
                       hover:bg-mor-sand/60 disabled:opacity-40">
            {saving ? '保存中…' : '保存'}
          </button>
        </div>

        {/* 標題 —— 大字，最上面 */}
        <div className="px-4 pt-5 pb-4">
          <input value={draft.title} onChange={(e) => set({ title: e.target.value })}
            placeholder="標題"
            className="w-full text-2xl font-medium placeholder:text-gray-300
                       outline-none border-none bg-transparent" />
          {/*
            沒填標題會顯示什麼 —— 先講出來。
            不講的話他會以為留白就是留白，然後看到月曆上冒出
            「退房清潔 A15・Kevin」會覺得是別人填的。
          */}
          {!draft.title.trim() && (
            <p className="text-xs text-gray-400 mt-1">
              留白的話會自動顯示「{draft.work_type} 房源・客人」
            </p>
          )}
        </div>

        <div className="border-t border-mor-line/50" />

        {/* ── 什麼時候 ────────────────────────── */}
        <div className={ROW}>
          <span className={LB}>日期</span>
          <input type="date" value={draft.work_date}
            onChange={(e) => set({ work_date: e.target.value })}
            className="flex-1 rounded-lg border border-mor-line px-2 py-1.5 text-sm" />
        </div>

        <div className={ROW}>
          <span className={LB}>全天</span>
          <div className="flex-1" />
          {/*
            開關做成滑塊而不是 checkbox —— TimeTree 是滑塊，
            而且滑塊的「開／關」在手機上一眼看得出來，方框打勾不會。
          */}
          <button onClick={() => set({ all_day: !draft.all_day })}
            aria-pressed={draft.all_day} aria-label="全天"
            className={`w-11 h-6 rounded-full transition-colors relative shrink-0 ${
              draft.all_day ? 'bg-mor-slate' : 'bg-gray-300'}`}>
            <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${
              draft.all_day ? 'left-[22px]' : 'left-0.5'}`} />
          </button>
        </div>

        {/*
          時間只在關掉全天時出現。
          永遠顯示的話，絕大多數（全天的）工作要面對兩個用不到的輸入框。
        */}
        {!draft.all_day && (
          <>
            <div className={ROW}>
              <span className={LB}>開始</span>
              <input type="time" value={draft.start_time}
                onChange={(e) => set({ start_time: e.target.value })}
                className="flex-1 rounded-lg border border-mor-line px-2 py-1.5 text-sm" />
            </div>
            <div className={ROW}>
              <span className={LB}>結束</span>
              <input type="time" value={draft.end_time}
                onChange={(e) => set({ end_time: e.target.value })}
                className="flex-1 rounded-lg border border-mor-line px-2 py-1.5 text-sm" />
            </div>
            {/*
              跨夜要講出來。不講的話「22:00–02:00」看起來像打錯，
              而它其實是合法的排班（migration_134 沒有 CHECK 擋它）。
            */}
            {draft.end_time < draft.start_time && (
              <p className="px-4 pb-2 text-xs text-amber-700">
                結束比開始早 —— 這會被當成**跨夜**（做到隔天）。
              </p>
            )}
          </>
        )}

        <div className="h-2 bg-mor-sand/30 border-y border-mor-line/50" />

        {/* ── 什麼事、誰做 ──────────────────────── */}
        <button onClick={() => setShowType((v) => !v)}
          className={`${ROW} w-full text-left hover:bg-mor-sand/20`}>
          <span className={LB}>標籤</span>
          <span className="w-3 h-3 rounded-[3px] shrink-0" style={{ backgroundColor: tone.bg }} />
          <span className="flex-1 text-sm">{draft.work_type}</span>
          <span className="text-gray-300">{showType ? '⌃' : '›'}</span>
        </button>

        {/*
          標籤清單直接展開在下面，不另開一層。
          TimeTree 是推一個新畫面，但在網頁上那會讓人失去「我在填一張表」的感覺。
        */}
        {showType && (
          <div className="border-b border-mor-line/50 bg-mor-sand/10">
            {workTypes.map((w) => {
              const c = toneOfType(w);
              const on = w === draft.work_type;
              return (
                <button key={w}
                  onClick={() => { set({ work_type: w }); setShowType(false); }}
                  className={`w-full flex items-center gap-3 px-4 py-2.5 text-left text-sm
                              hover:bg-white/70 ${on ? 'bg-white' : ''}`}>
                  <span className="w-1 h-5 rounded-full shrink-0"
                    style={{ backgroundColor: c.bg }} />
                  <span className="flex-1">{w}</span>
                  <span className={`w-4 h-4 rounded-full border-2 shrink-0 ${
                    on ? 'border-mor-slate bg-mor-slate' : 'border-gray-300'}`} />
                </button>
              );
            })}
          </div>
        )}

        <div className={ROW}>
          <span className={LB}>負責人</span>
          <select value={draft.staff_id} onChange={(e) => set({ staff_id: e.target.value })}
            className="flex-1 rounded-lg border border-mor-line px-2 py-1.5 text-sm">
            <option value="">（未指派）</option>
            {staff.filter((s) => s.active).map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </div>

        <div className={ROW}>
          <span className={LB}>房源</span>
          <select value={draft.property_id} onChange={(e) => set({ property_id: e.target.value })}
            className="flex-1 rounded-lg border border-mor-line px-2 py-1.5 text-sm">
            <option value="">（無房源）</option>
            {props.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>

        <div className={`${ROW} items-start`}>
          <span className={`${LB} pt-1.5`}>備註</span>
          <textarea value={draft.note} onChange={(e) => set({ note: e.target.value })}
            rows={2} placeholder="選填"
            className="flex-1 rounded-lg border border-mor-line px-2 py-1.5 text-sm resize-y" />
        </div>

        {onDelete && (
          <div className="px-4 py-4">
            <button onClick={onDelete}
              className="text-sm text-red-500 hover:text-red-700 underline">刪除這個工作</button>
          </div>
        )}
        <div className="h-4" />
      </div>
    </div>
  );
}
