'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase';
import { getPosition, punchUi, hhmm, type GeoFail } from '@/lib/punch';
import {
  twToday, dayStatus, countTodo, quickRange, type ReportRow,
} from '@/lib/attendance-ui';
import { CARD, type Estate, type TabProps } from './types';

type Today = {
  in_at: string | null; out_at: string | null;
  late_min: number | null; early_min: number | null;
  status: string;
};

const TONE_CLS: Record<string, string> = {
  ok: 'bg-mor-greenlight text-mor-green border-mor-green/30',
  bad: 'bg-red-50 text-red-600 border-red-200',
  off: 'bg-gray-100 text-gray-500 border-gray-200',
  wait: 'bg-amber-50 text-amber-700 border-amber-200',
  none: 'bg-transparent text-transparent border-transparent',
};

/**
 * 走動的時鐘。
 *
 * 【為什麼值得多一個 setInterval】
 * 打卡的人在按下去之前會看一眼時間 —— 「現在幾點、我算不算遲到」。
 * 停住的時間讓人不確定畫面是不是活的，然後他會重新整理一次再按。
 * 秒數在跳是「這台機器在運作」最便宜的證據。
 */
function Clock() {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());                                   // 掛載後才設，避免 SSR 與瀏覽器對不上
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  const f = (d: Date) => d.toLocaleTimeString('zh-TW', {
    hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Asia/Taipei',
  });
  return (
    <>
      <div className="text-4xl md:text-5xl font-bold tabular-nums tracking-tight text-white">
        {now ? f(now) : '--:--:--'}
      </div>
      <div className="text-xs text-white/70 mt-1">
        {now ? now.toLocaleDateString('zh-TW', {
          year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', timeZone: 'Asia/Taipei',
        }) : ''}
      </div>
    </>
  );
}

export default function PunchTab({ me, isAdmin, onMsg, onFix }: TabProps & {
  /** 「補登」按鈕：跳到申請分頁並帶入那一天 */
  onFix?: (workDate: string, kind: 'in' | 'out') => void;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [today, setToday] = useState<Today | null>(null);
  const [estates, setEstates] = useState<Estate[]>([]);
  const [rows, setRows] = useState<ReportRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [onlyTodo, setOnlyTodo] = useState(false);
  const d = twToday();

  const load = useCallback(async () => {
    const r30 = quickRange('last30');
    const [{ data: a }, { data: es }, { data: rep }] = await Promise.all([
      supabase.from('attendance')
        .select('in_at, out_at, late_min, early_min, status')
        .eq('user_id', me.id).eq('work_date', d).maybeSingle(),
      supabase.from('estates')
        .select('id, name, active, sort, gps_lat, gps_lng, gps_radius_m')
        .order('sort').order('name'),
      supabase.rpc('attendance_report', { p_user: me.id, p_from: r30.from, p_to: r30.to }),
    ]);
    setToday((a as Today) ?? null);
    setEstates((es ?? []) as Estate[]);
    // 新的在上面 —— 要處理的都是最近幾天的
    setRows(((rep ?? []) as ReportRow[]).slice().reverse());
    setLoading(false);
  }, [supabase, me.id, d]);

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
  const todo = countTodo(rows, d);
  const shown = onlyTodo ? rows.filter((r) => dayStatus(r, d).tone === 'bad') : rows;

  return (
    <div className="space-y-4">
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

      {/* ── 打卡鐘 ─────────────────────────────────── */}
      <div className="rounded-2xl overflow-hidden bg-gradient-to-br from-mor-slate to-mor-slatedark
                      px-5 py-6 md:flex md:items-center md:gap-8">
        <div className="text-center md:text-left md:flex-1">
          <Clock />
          <div className="flex items-center justify-center md:justify-start gap-5 mt-4">
            {([['上班', today?.in_at, today?.late_min, '遲到'],
               ['下班', today?.out_at, today?.early_min, '早退']] as const).map(([lb, at, mins, warn]) => (
              <div key={lb} className="text-center md:text-left">
                <div className="text-[11px] text-white/60">{lb}</div>
                <div className={`text-lg font-semibold tabular-nums ${at ? 'text-white' : 'text-white/30'}`}>
                  {hhmm(at)}
                </div>
                {!!mins && mins > 0 && (
                  <div className="text-[11px] text-amber-200">{warn} {mins} 分</div>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* 手機上要好按 —— 打卡是站著單手操作的動作 */}
        <div className="mt-5 md:mt-0 md:w-56">
          {ui.action ? (
            <button onClick={() => doPunch(ui.action!)} disabled={busy || !ready.length}
              className="w-full h-16 rounded-xl bg-white text-mor-slate text-lg font-bold
                         hover:bg-white/90 active:scale-[0.99] transition disabled:opacity-40">
              {busy ? '定位中…' : ui.label}
            </button>
          ) : (
            <div className="w-full h-16 rounded-xl bg-white/15 text-white
                            flex items-center justify-center text-base font-semibold">
              ✓ {ui.label}
            </div>
          )}
          <div className="text-[11px] text-white/60 mt-2 text-center leading-relaxed">{ui.hint}</div>
        </div>
      </div>

      {/* ── 要處理的 ───────────────────────────────── */}
      {todo > 0 && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <b>近 30 天有 {todo} 天要處理</b>（忘了打卡、遲到或早退）。
          <div className="text-xs mt-1 leading-relaxed">
            下面清單裡紅色那幾列右邊有「補登」——{' '}
            <b>今天的打卡不會補到那一天去</b>，那一天要單獨補，否則兩天的工時都會錯。
          </div>
        </div>
      )}

      {/* ── 我的出勤紀錄 ───────────────────────────── */}
      <div className={`${CARD} overflow-hidden`}>
        <div className="px-4 py-2.5 border-b border-mor-line bg-mor-sand/40
                        flex items-center gap-3 text-sm font-medium">
          <span>我的出勤（近 30 天）</span>
          <div className="flex-1" />
          <label className="flex items-center gap-1.5 text-xs font-normal text-gray-600">
            <input type="checkbox" checked={onlyTodo} onChange={(e) => setOnlyTodo(e.target.checked)} />
            只看要處理的{todo > 0 && `（${todo}）`}
          </label>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[620px] text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500 border-b border-mor-line">
                <th className="px-4 py-2">日期</th>
                <th className="px-4 py-2">上班卡</th>
                <th className="px-4 py-2">下班卡</th>
                <th className="px-4 py-2">工時</th>
                <th className="px-4 py-2">狀態</th>
                <th className="px-4 py-2 text-right"> </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const s = dayStatus(r, d);
                const dow = ['日', '一', '二', '三', '四', '五', '六'][
                  new Date(`${r.work_date}T00:00:00+08:00`).getDay()];
                return (
                  <tr key={r.work_date}
                    className={`border-b border-mor-line/60 last:border-0 ${
                      r.work_date === d ? 'bg-mor-slate/5' : ''}`}>
                    <td className="px-4 py-2 whitespace-nowrap tabular-nums">
                      {r.work_date.slice(5).replace('-', '/')}
                      <span className={`ml-1 text-xs ${
                        dow === '日' || dow === '六' ? 'text-red-400' : 'text-gray-400'}`}>({dow})</span>
                    </td>
                    <td className={`px-4 py-2 tabular-nums ${
                      (r.late_min ?? 0) > 0 ? 'text-red-600' : ''}`}>
                      {r.in_at ?? <span className="text-gray-300">—</span>}
                    </td>
                    <td className={`px-4 py-2 tabular-nums ${
                      (r.early_min ?? 0) > 0 ? 'text-red-600' : ''}`}>
                      {r.out_at ?? <span className="text-gray-300">—</span>}
                    </td>
                    <td className="px-4 py-2 tabular-nums text-gray-600">
                      {r.work_hours > 0 ? r.work_hours : <span className="text-gray-300">—</span>}
                      {r.ot_hours > 0 && <span className="text-mor-slate">＋{r.ot_hours}</span>}
                    </td>
                    <td className="px-4 py-2">
                      {s.tone !== 'none' && (
                        <span className={`rounded-full border px-2 py-0.5 text-[11px] whitespace-nowrap ${
                          TONE_CLS[s.tone]}`}>{s.label}</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right">
                      {/* 光標紅字沒有用 —— 要讓他當場就能補 */}
                      {s.fixKind && onFix && (
                        <button onClick={() => onFix(r.work_date, s.fixKind!)}
                          className="rounded-lg border border-mor-line px-3 py-1 text-xs hover:bg-mor-sand/60">
                          補登{s.fixKind === 'in' ? '上班' : '下班'}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {!shown.length && (
                <tr><td colSpan={6} className="px-4 py-8 text-center text-sm text-gray-400">
                  {loading ? '載入中…' : onlyTodo ? '近 30 天沒有要處理的 👍' : '沒有資料'}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="text-xs text-gray-400 leading-relaxed">
        打卡需要定位權限。可打卡的物業：{ready.map((e) => e.name).join('、') || '（尚未設定）'}。
        在任何一個物業的範圍內都能打卡，紀錄會帶到是在哪一個物業打的。
        <br />
        <b>工時走制度，不看打卡待多久</b> —— 多待的算加班（要事前申請），早走的分鐘另外記。
      </div>
    </div>
  );
}
