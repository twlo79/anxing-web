'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase';
import { leaveVote, otVote } from '@/lib/attendance-ui';
import {
  BTN2, CARD, TONE, fmtDT, noRowsMsg,
  type FixReq, type LeaveReq, type LeaveType, type OtReq, type TabProps,
} from './types';

/**
 * 核可：請假 · 加班 · 補登。
 *
 * 【為什麼三種待辦擠在同一頁】
 * 主管每天要看的是「有沒有事情等我」。分成三頁的話，
 * 有兩頁是空的、一頁有三件事，而他得點三次才知道。
 * 分頁上直接標數字，沒有數字就不用點進去。
 *
 * 【駁回一定要寫理由】
 * 沒有理由的駁回會變成當面追問，而追問的答案不會留在系統裡。
 * 下次同一個人送同樣的單，還是會被駁回，還是不知道為什麼。
 */

type Sub = 'leave' | 'ot' | 'fix';

/**
 * 姓名是另外撈的，不是用 PostgREST 的 join。
 *
 * `profiles!leave_requests_user_id_fkey(name)` 這種寫法要填對外鍵的**約束名稱**，
 * 而約束名稱是資料庫自動產生的、這個 repo 裡看不到。猜錯的話 PostgREST 回 400，
 * 而畫面上只會是一片空白的待辦清單 —— 主管會以為沒事要處理。
 * 員工只有八個人，多一次查詢換一個不會猜錯的東西。
 */
type WithName<T> = T & { name?: string };

export default function ApproveTab({ me, onMsg }: TabProps) {
  const supabase = useMemo(() => createClient(), []);
  const [sub, setSub] = useState<Sub>('leave');
  /**
   * 簽核中 / 已結束。
   *
   * 【為什麼要有「已結束」】
   * 「我上禮拜那張假到底過了沒」是主管會被問的問題，
   * 而只留待辦清單的話，簽完就消失，主管自己也查不到。
   * 已結束只撈最近 60 天 —— 再舊的沒有人在追。
   */
  const [done, setDone] = useState(false);
  const [types, setTypes] = useState<LeaveType[]>([]);
  const [leaves, setLeaves] = useState<WithName<LeaveReq>[]>([]);
  const [ots, setOts] = useState<WithName<OtReq>[]>([]);
  const [fixes, setFixes] = useState<WithName<FixReq>[]>([]);
  const [busy, setBusy] = useState('');
  const isBoss = me.role === 'super_admin';

  const load = useCallback(async () => {
    // 已結束只看最近 60 天。全部撈的話會愈來愈慢，而超過兩個月的沒有人在追。
    const since = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);
    // 兩種模式分開寫。想寫成一個泛型 helper 包起來的話 TypeScript 會在
    // Supabase 的 query builder 型別上遞迴到爆（TS2589），而那個錯誤訊息
    // 完全看不出來是這裡造成的。
    const lrQ = done
      ? supabase.from('leave_requests').select('*').neq('status', 'pending')
          .gte('start_at', since).order('start_at', { ascending: false })
      : supabase.from('leave_requests').select('*').eq('status', 'pending').order('start_at');
    const otQ = done
      ? supabase.from('overtime_requests').select('*').neq('status', 'pending')
          .gte('work_date', since).order('work_date', { ascending: false })
      : supabase.from('overtime_requests').select('*').eq('status', 'pending').order('work_date');
    const fxQ = done
      ? supabase.from('attendance_fixes').select('*').neq('status', 'pending')
          .gte('work_date', since).order('work_date', { ascending: false })
      : supabase.from('attendance_fixes').select('*').eq('status', 'pending').order('work_date');

    const [{ data: lt }, { data: pf }, { data: lr }, { data: ot }, { data: fx }] = await Promise.all([
      supabase.from('leave_types').select('code, name, has_quota, sort').order('sort'),
      supabase.from('profiles').select('id, name'),
      lrQ, otQ, fxQ,
    ]);
    const nameOf = new Map((pf ?? []).map((p) => [p.id as string, p.name as string]));
    const withName = <T extends { user_id: string }>(rows: unknown): WithName<T>[] =>
      ((rows ?? []) as T[]).map((r) => ({ ...r, name: nameOf.get(r.user_id) ?? '—' }));
    setTypes((lt ?? []) as LeaveType[]);
    setLeaves(withName<LeaveReq>(lr));
    setOts(withName<OtReq>(ot));
    setFixes(withName<FixReq>(fx));
  }, [supabase, done]);

  useEffect(() => { load(); }, [load]);

  const typeName = (c: string) => types.find((t) => t.code === c)?.name ?? c;

  /** 共用的寫入：一定檢查影響列數，RLS 擋掉時不會回錯誤。 */
  async function write(table: string, id: string, patch: Record<string, unknown>, okText: string) {
    setBusy(id);
    const { data, error } = await supabase.from(table).update(patch).eq('id', id).select('id');
    setBusy('');
    if (error) return onMsg('失敗：' + error.message, true);
    if (!data?.length) return onMsg(noRowsMsg('這筆'), true);
    onMsg(okText); load();
  }

  function reject(table: string, id: string, field: string) {
    const why = window.prompt('駁回理由（會顯示給申請人看）');
    if (why === null) return;               // 按取消
    if (!why.trim()) {
      return onMsg('駁回一定要寫理由。\n\n沒有理由的駁回會變成當面追問，而追問的答案不會留在系統裡。', true);
    }
    write(table, id, { status: 'rejected', [field]: why.trim() }, '已駁回');
  }

  const tabs: [Sub, string, number][] = [
    ['leave', '請假', leaves.length],
    ['ot', '加班', ots.length],
    ['fix', '補登', fixes.length],
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-1">
        {([[false, '簽核中'], [true, '已結束']] as const).map(([v, lb]) => (
          <button key={lb} onClick={() => setDone(v)}
            className={`px-3 py-1 text-sm ${
              done === v ? 'text-mor-slate font-semibold' : 'text-gray-400 hover:text-gray-600'}`}>
            {lb}
          </button>
        ))}
        <span className="text-xs text-gray-300">|</span>
        <span className="text-xs text-gray-400">{done ? '最近 60 天' : '等你處理的'}</span>
      </div>

      <div className="flex gap-1">
        {tabs.map(([k, label, n]) => (
          <button key={k} onClick={() => setSub(k)}
            className={`rounded-lg px-3 py-1.5 text-sm flex items-center gap-1.5 ${
              sub === k ? 'bg-mor-slate text-white' : 'border border-mor-line hover:bg-mor-sand/60'}`}>
            {label}
            {/* 數字直接標在分頁上 —— 沒有數字就不用點進去 */}
            {!done && n > 0 && (
              <span className={`rounded-full px-1.5 text-[11px] ${
                sub === k ? 'bg-white/25' : 'bg-amber-100 text-amber-700'}`}>{n}</span>
            )}
          </button>
        ))}
      </div>

      <div className={CARD}>
        <div className="divide-y divide-mor-line/60">
          {/* ── 請假：兩票 ─────────────────────────── */}
          {sub === 'leave' && leaves.map((r) => {
            const v = leaveVote(r);
            // 我這一票投過了沒有 —— 投過的不該再顯示按鈕，按下去只是重複寫同一個值
            const mine = isBoss ? r.admin_at : r.manager_at;
            return (
              <div key={r.id} className="px-4 py-3">
                <div className="flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium">
                      {r.name}・{typeName(r.type_code)} {r.hours} 小時
                    </div>
                    <div className="text-xs text-gray-500 mt-0.5">
                      {fmtDT(r.start_at)} → {fmtDT(r.end_at)}{r.reason ? `・${r.reason}` : ''}
                    </div>
                  </div>
                  <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] ${TONE[v.tone]}`}>
                    {v.text}
                  </span>
                </div>
                {!done && <div className="flex gap-2 mt-2">
                  {mine ? (
                    <span className="text-xs text-gray-400 py-1.5">
                      你已經簽過了，等{isBoss ? '主管' : '總經理'}。
                    </span>
                  ) : (
                    <button disabled={busy === r.id}
                      onClick={() => write('leave_requests', r.id,
                        isBoss ? { admin_by: me.id, admin_at: new Date().toISOString() }
                               : { manager_by: me.id, manager_at: new Date().toISOString() },
                        '已簽核')}
                      className={`${BTN2} border-mor-slate text-mor-slate`}>
                      {isBoss ? '總經理核可' : '主管核可'}
                    </button>
                  )}
                  <button disabled={busy === r.id}
                    onClick={() => reject('leave_requests', r.id, 'reject_reason')}
                    className={`${BTN2} text-red-600 border-red-200`}>駁回</button>
                </div>}
              </div>
            );
          })}

          {/* ── 加班：一票 ─────────────────────────── */}
          {sub === 'ot' && ots.map((r) => {
            const v = otVote(r);
            return (
              <div key={r.id} className="px-4 py-3">
                <div className="flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium">
                      {r.name}・加班 {r.hours} 小時
                    </div>
                    <div className="text-xs text-gray-500 mt-0.5">
                      {fmtDT(r.start_at)} → {fmtDT(r.end_at)}・{r.reason}
                    </div>
                  </div>
                  <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] ${TONE[v.tone]}`}>
                    {v.text}
                  </span>
                </div>
                {!done && <div className="flex gap-2 mt-2">
                  <button disabled={busy === r.id}
                    onClick={() => write('overtime_requests', r.id,
                      { status: 'approved', manager_by: me.id, manager_at: new Date().toISOString() },
                      '已核可')}
                    className={`${BTN2} border-mor-slate text-mor-slate`}>核可</button>
                  <button disabled={busy === r.id}
                    onClick={() => reject('overtime_requests', r.id, 'reject_reason')}
                    className={`${BTN2} text-red-600 border-red-200`}>駁回</button>
                </div>}
              </div>
            );
          })}

          {/* ── 補登 ───────────────────────────────── */}
          {sub === 'fix' && fixes.map((r) => (
            <div key={r.id} className="px-4 py-3">
              <div className="text-sm font-medium">
                {r.name}・{r.work_date} 補{r.kind === 'in' ? '上班' : '下班'}{' '}
                {r.fix_time.slice(0, 5)}
              </div>
              <div className="text-xs text-gray-500 mt-0.5">{r.reason}</div>
              {!done && <div className="flex gap-2 mt-2">
                <button disabled={busy === r.id}
                  onClick={() => write('attendance_fixes', r.id,
                    { status: 'approved', reviewed_by: me.id, reviewed_at: new Date().toISOString() },
                    '已補上，出勤紀錄同步更新')}
                  className={`${BTN2} border-mor-slate text-mor-slate`}>核可並寫入</button>
                <button disabled={busy === r.id}
                  onClick={() => reject('attendance_fixes', r.id, 'review_note')}
                  className={`${BTN2} text-red-600 border-red-200`}>駁回</button>
              </div>}
            </div>
          ))}

          {((sub === 'leave' && !leaves.length) || (sub === 'ot' && !ots.length)
            || (sub === 'fix' && !fixes.length)) && (
            <div className="px-4 py-8 text-center text-sm text-gray-400">
              {done ? '最近 60 天沒有已結束的' : '沒有待處理的'}
              {sub === 'leave' ? '請假' : sub === 'ot' ? '加班' : '補登'}
            </div>
          )}
        </div>
      </div>

    </div>
  );
}
