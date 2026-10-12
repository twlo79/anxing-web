'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase';
import { savedToast } from '@/lib/saved-feedback';
import type { TabProps } from './types';

/*
 * ══════════════════════════════════════════════════════════
 * 誰可以在哪打卡（migration_330，2026-10-12 David）
 *
 *   「員工可在有選到的地點打卡，用 or 的概念，只要在有選定的任一範圍內打卡就成功」
 *   「加一個可遠端機制」→ 直接算上班，紀錄標「遠端」
 *
 *   · 每個人一列，點地點切換（staff_punch_estates）
 *   · 一個都沒勾的人 → 所有有座標的物業都能打（漏設定不會被擋在門外）
 *   · 沒座標的物業可以勾，但要等座標設好才打得了（虛線提示）
 *   · 可遠端打卡走 set_remote_punch()（profiles 不開放直接 update）
 *
 * ★ 真正的判斷在資料庫 punch()，這裡只是設定畫面。
 * ══════════════════════════════════════════════════════════
 */

type Person = { id: string; name: string; role: string; active: boolean | null; allow_remote_punch: boolean | null };
type Est = { id: string; name: string; gps_lat: number | null; gps_lng: number | null };

const ROLE_ORDER: Record<string, number> = { housekeeper: 0, manager: 1, accountant: 2 };

export default function PunchWhoSection({ onMsg }: { onMsg: TabProps['onMsg'] }) {
  const supabase = useMemo(() => createClient(), []);
  const [ppl, setPpl] = useState<Person[]>([]);
  const [ests, setEsts] = useState<Est[]>([]);
  const [map, setMap] = useState<Record<string, Set<string>>>({});
  const [busy, setBusy] = useState<string>('');

  const load = useCallback(async () => {
    const [{ data: p, error: pe }, { data: e }, { data: s }] = await Promise.all([
      supabase.from('profiles').select('id, name, role, active, allow_remote_punch').order('name'),
      supabase.from('estates').select('id, name, gps_lat, gps_lng').eq('active', true).order('sort').order('name'),
      supabase.from('staff_punch_estates').select('user_id, estate_id'),
    ]);
    if (pe) return onMsg('讀不到員工：' + pe.message + '（migration_330 跑了嗎？）', true);
    setPpl(((p ?? []) as Person[])
      .filter((x) => x.active !== false && x.role in ROLE_ORDER)
      .sort((a, b) => (ROLE_ORDER[a.role] - ROLE_ORDER[b.role]) || a.name.localeCompare(b.name)));
    setEsts((e ?? []) as Est[]);
    const m: Record<string, Set<string>> = {};
    for (const r of (s ?? []) as { user_id: string; estate_id: string }[]) (m[r.user_id] ??= new Set()).add(r.estate_id);
    setMap(m);
  }, [supabase, onMsg]);
  useEffect(() => { load(); }, [load]);

  async function toggle(p: Person, e: Est) {
    const key = p.id + e.id;
    if (busy) return;
    const on = map[p.id]?.has(e.id);
    setBusy(key);
    const { data, error } = on
      ? await supabase.from('staff_punch_estates').delete().eq('user_id', p.id).eq('estate_id', e.id).select('user_id')
      : await supabase.from('staff_punch_estates').insert({ user_id: p.id, estate_id: e.id }).select('user_id');
    setBusy('');
    if (error) return onMsg('沒存到：' + error.message, true);
    if (!data?.length) return onMsg('沒存到 —— 只有主管、總經理可以設定', true);
    setMap((m) => {
      const n = new Set(m[p.id] ?? []);
      if (on) n.delete(e.id); else n.add(e.id);
      return { ...m, [p.id]: n };
    });
  }

  async function setRemote(p: Person, v: boolean) {
    setBusy('r' + p.id);
    const { data, error } = await supabase.rpc('set_remote_punch', { p_user: p.id, p_on: v });
    setBusy('');
    const r = data as { ok: boolean; message: string } | null;
    if (error || !r?.ok) return onMsg('沒存到：' + (error?.message ?? r?.message ?? ''), true);
    setPpl((xs) => xs.map((x) => (x.id === p.id ? { ...x, allow_remote_punch: v } : x)));
    savedToast(`${p.name}：${r.message}`);
  }

  return (
    <div>
      <div className="text-sm font-medium mb-1">誰可以在哪打卡</div>
      <div className="text-xs text-gray-500 mb-3 leading-relaxed">
        點地點切換。打卡時只要在<b>勾選的任一個地點</b>範圍內就算成功。
        一個都沒勾的人，所有有座標的地點都能打。
      </div>

      <div className="divide-y divide-mor-line">
        {ppl.map((p) => {
          const mine = map[p.id] ?? new Set<string>();
          return (
            <div key={p.id} className="py-2.5 grid grid-cols-[5rem_1fr] md:grid-cols-[6rem_1fr_8rem] gap-x-3 gap-y-1.5 items-start">
              <div className="text-sm font-medium pt-1">{p.name}</div>
              <div className="flex flex-wrap gap-1.5">
                {ests.map((e) => {
                  const on = mine.has(e.id);
                  const noGps = e.gps_lat == null || e.gps_lng == null;
                  return (
                    <button key={e.id} onClick={() => void toggle(p, e)} disabled={!!busy}
                      title={noGps ? `${e.name} 還沒設座標 —— 勾了要等座標設好才打得了` : undefined}
                      className={`rounded-full px-2.5 py-1 text-xs border transition-colors disabled:opacity-60 ${
                        on ? 'bg-mor-bluelight text-mor-slate border-mor-slate/40 font-medium'
                          : noGps ? 'border-dashed border-gray-300 text-gray-400 hover:bg-mor-sand/40'
                            : 'border-mor-line text-gray-600 hover:bg-mor-sand/40'}`}>
                      {on ? '✓ ' : ''}{e.name}{on && noGps ? '（還沒座標）' : ''}
                    </button>
                  );
                })}
                {mine.size === 0 && <span className="text-[11px] text-gray-400 self-center">沒勾 → 有座標的地點都能打</span>}
              </div>
              <label className="col-start-2 md:col-start-auto flex items-center gap-1.5 text-xs text-gray-600 pt-1">
                <input type="checkbox" checked={!!p.allow_remote_punch} disabled={!!busy}
                  onChange={(e) => void setRemote(p, e.target.checked)} />
                可遠端打卡
              </label>
            </div>
          );
        })}
      </div>
      <div className="mt-3 text-[11px] text-gray-400 leading-relaxed">
        可遠端打卡的人在範圍外也算上班，紀錄會標「遠端」並存下當時離最近地點多遠。
        虛線的地點還沒設座標，到「打卡位置」設好之後才打得了。
      </div>
    </div>
  );
}
