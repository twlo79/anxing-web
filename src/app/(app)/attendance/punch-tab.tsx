'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase';
import { getPosition, punchUi, hhmm, type GeoFail } from '@/lib/punch';
import { twToday } from '@/lib/attendance-ui';
import { CARD, type Estate, type TabProps } from './types';

type Today = {
  in_at: string | null; out_at: string | null;
  late_min: number | null; early_min: number | null;
  status: string;
};

export default function PunchTab({ me, isAdmin, onMsg }: TabProps) {
  const supabase = useMemo(() => createClient(), []);
  const [today, setToday] = useState<Today | null>(null);
  /** 之前有上班卡卻沒下班卡的那一天。忘記打下班是這套系統最常見的問題。 */
  const [openDay, setOpenDay] = useState<{ work_date: string; in_at: string } | null>(null);
  const [estates, setEstates] = useState<Estate[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const d = twToday();
    const [{ data: a }, { data: open }, { data: es }] = await Promise.all([
      supabase.from('attendance')
        .select('in_at, out_at, late_min, early_min, status')
        .eq('user_id', me.id).eq('work_date', d).maybeSingle(),
      // 只看今天以前 —— 今天的當然還沒下班
      supabase.from('attendance').select('work_date, in_at')
        .eq('user_id', me.id).lt('work_date', d)
        .not('in_at', 'is', null).is('out_at', null)
        .order('work_date', { ascending: false }).limit(1).maybeSingle(),
      supabase.from('estates')
        .select('id, name, active, sort, gps_lat, gps_lng, gps_radius_m')
        .order('sort').order('name'),
    ]);
    setToday((a as Today) ?? null);
    setOpenDay((open as { work_date: string; in_at: string }) ?? null);
    setEstates((es ?? []) as Estate[]);
    setLoading(false);
  }, [supabase, me.id]);

  useEffect(() => { load(); }, [load]);

  /**
   * 打卡。
   *
   * 【為什麼先拿 GPS 再呼叫資料庫】
   * 反過來的話，資料庫會先回「沒有座標」，而真正的原因是瀏覽器不給定位 ——
   * 兩種失敗的處理方式完全不同（一個要改瀏覽器設定，一個要找主管）。
   */
  async function doPunch(kind: 'in' | 'out') {
    setBusy(true);
    try {
      const pos = await getPosition();
      const { data, error } = await supabase.rpc('punch', {
        p_kind: kind, p_lat: pos.lat, p_lng: pos.lng,
      });
      if (error) return onMsg('打卡失敗：' + error.message, true);
      const r = data as { ok: boolean; message: string };
      if (r?.ok) { onMsg(r.message); load(); } else { onMsg(r?.message ?? '打卡失敗', true); }
    } catch (e) {
      // getPosition 拋的是已經寫好中文的 GeoFail
      onMsg((e as GeoFail)?.message ?? '打卡失敗，請再試一次。', true);
    } finally { setBusy(false); }
  }

  const ui = punchUi(today ? { in_at: hhmm(today.in_at), out_at: hhmm(today.out_at) } : null);
  // 有座標的物業才算「可以打卡」—— 沒設座標的不該讓人以為能打
  const ready = estates.filter((e) => e.active && e.gps_lat != null && e.gps_lng != null);

  return (
    <div className="space-y-4">
      {/*
        【最常見的錯誤，要主動講】
        昨天忘了打下班，隔天上班打卡 —— 打卡鐘的經典災難是把今天的卡
        補成昨天的下班。這裡不會那樣做（migration_98 的 NO_IN_YET 擋住了），
        但如果只是默默擋掉，那筆沒收尾的紀錄會一直掛著沒人處理。
      */}
      {openDay && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <b>{openDay.work_date} 有上班卡，沒有下班卡。</b>
          <div className="text-xs mt-1 leading-relaxed">
            那天 {hhmm(openDay.in_at)} 打了上班。<b>今天再打卡不會補到那一天去</b> ——
            今天的卡算今天的，那天要到「申請 → 補登」單獨補，否則兩天的工時都會錯。
          </div>
        </div>
      )}

      {/*
        沒有任何物業設座標時先擋在前面。
        讓人按下去才得到「沒有物業設定打卡位置」是最糟的順序 ——
        他會以為是自己的問題，而那是主管還沒設定。
      */}
      {!loading && !ready.length && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <b>還不能打卡 —— 沒有任何物業設定打卡位置。</b>
          <div className="text-xs mt-1">
            {isAdmin ? '到「管理」分頁設定物業座標之後就能開始使用。' : '請主管到「出勤 → 管理」設定物業座標。'}
          </div>
        </div>
      )}

      <div className={`${CARD} p-5 text-center`}>
        <div className="text-xs text-gray-400 mb-1">
          {new Date().toLocaleDateString('zh-TW', { month: 'long', day: 'numeric', weekday: 'long' })}
        </div>

        <div className="flex items-center justify-center gap-6 my-4">
          {([['上班', today?.in_at, today?.late_min, '遲到'],
             ['下班', today?.out_at, today?.early_min, '早退']] as const).map(([lb, at, mins, warn]) => (
            <div key={lb} className="min-w-[6rem]">
              <div className="text-xs text-gray-500">{lb}</div>
              <div className={`text-2xl font-bold tabular-nums ${at ? 'text-mor-slate' : 'text-gray-300'}`}>
                {hhmm(at)}
              </div>
              {!!mins && mins > 0 && (
                <div className="text-[11px] text-amber-600">{warn} {mins} 分</div>
              )}
            </div>
          ))}
        </div>

        {/* 手機上要好按 —— 打卡是站著單手操作的動作 */}
        {ui.action ? (
          <button onClick={() => doPunch(ui.action!)} disabled={busy || !ready.length}
            className="w-full h-14 rounded-xl bg-mor-slate text-white text-base font-semibold
                       hover:bg-mor-slatedark disabled:opacity-40">
            {busy ? '定位中…' : ui.label}
          </button>
        ) : (
          <div className="w-full h-14 rounded-xl bg-mor-greenlight text-mor-green
                          flex items-center justify-center text-base font-semibold">
            ✓ {ui.label}
          </div>
        )}
        <div className="text-xs text-gray-400 mt-2 leading-relaxed">{ui.hint}</div>
      </div>

      <div className="text-xs text-gray-400 leading-relaxed">
        打卡需要定位權限。可打卡的物業：{ready.map((e) => e.name).join('、') || '（尚未設定）'}。
        <br />
        在任何一個物業的範圍內都能打卡，紀錄會帶到是在哪一個物業打的。
      </div>
    </div>
  );
}
