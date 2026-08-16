'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase';
import { getPosition, punchUi, hhmm, type GeoFail } from '@/lib/punch';
import { dayPhase, taipeiHour, workedText, type CardInk } from '@/lib/day-phase';
import { fmtLate } from '@/lib/attendance-hours';
import {
  twToday, dayStatus, monthSummary, monthRange, shiftMonth, type ReportRow,
} from '@/lib/attendance-ui';
import { CARD, C_IN, C_NEUTRAL, C_WARN, type Estate, type TabProps } from './types';

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
  none: 'hidden',
};
const DOW = ['日', '一', '二', '三', '四', '五', '六'];

/**
 * 走動的時鐘。
 *
 * 【為什麼值得多一個 setInterval】
 * 打卡的人在按下去之前會看一眼時間 —— 「現在幾點、我算不算遲到」。
 * 停住的時間讓人不確定畫面是不是活的，然後他會重新整理一次再按。
 * 秒數在跳是「這台機器在運作」最便宜的證據。
 */
/**
 * 每秒跳一次的現在時間。
 *
 * 掛載後才設 —— SSR 算出來的時間跟瀏覽器一定對不上，
 * React 會丟 hydration 警告，而且使用者會看到時間閃一下。
 */
function useNow() {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

function Clock({ now, ink }: { now: Date | null; ink: CardInk }) {
  const f = (d: Date) => d.toLocaleTimeString('zh-TW', {
    hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Asia/Taipei',
  });
  return (
    <>
      {/* 秒數用小一號並降透明度 —— 它一直在動，跟時分同樣大會一直搶注意力，
          而看時間的人要的是「幾點幾分」 */}
      <div className={`text-5xl md:text-6xl font-bold tabular-nums tracking-tight leading-none ${ink.strong}`}>
        {now ? f(now).slice(0, 5) : '--:--'}
        <span className={`text-2xl md:text-3xl font-semibold ml-1 ${ink.faint}`}>
          {now ? f(now).slice(5) : ':--'}
        </span>
      </div>
      <div className={`text-xs mt-2 ${ink.dim}`}>
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
  const d = twToday();
  const [today, setToday] = useState<Today | null>(null);
  const [estates, setEstates] = useState<Estate[]>([]);
  const [rows, setRows] = useState<ReportRow[]>([]);
  /**
   * 這個人第一次打卡是哪一天。
   *
   * 【為什麼一定要撈這個】
   * 系統 8/10 上線，8/10 之前的每一個工作日在報表上都是「未出勤」。
   * 不擋的話第一次打開畫面就是「近 30 天有 21 天要處理」——
   * 全紅的清單跟全綠的一樣沒有資訊量，而第一印象是「這系統壞了」。
   */
  const [firstDay, setFirstDay] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [onlyTodo, setOnlyTodo] = useState(false);

  // 以整月為單位。歷史紀錄就是往前翻月份 —— 「近 30 天」永遠跨兩個月，
  // 而薪資與請假額度都是按月結的，兩邊對不起來。
  // 這個只用來決定「預設顯示哪個月」,不需要每秒跳 —— 跟下面每秒更新的
  // useNow() 分開,免得整張月曆每秒重算一次
  const today0 = new Date();
  const [[y, m], setYm] = useState<[number, number]>([today0.getFullYear(), today0.getMonth() + 1]);
  const isThisMonth = y === today0.getFullYear() && m === today0.getMonth() + 1;

  const load = useCallback(async () => {
    setLoading(true);
    const rg = monthRange(y, m);
    const [{ data: a }, { data: es }, { data: rep }, { data: first }] = await Promise.all([
      supabase.from('attendance')
        .select('in_at, out_at, late_min, early_min, status')
        .eq('user_id', me.id).eq('work_date', d).maybeSingle(),
      supabase.from('estates')
        .select('id, name, active, sort, gps_lat, gps_lng, gps_radius_m')
        .order('sort').order('name'),
      supabase.rpc('attendance_report', { p_user: me.id, p_from: rg.from, p_to: rg.to }),
      supabase.from('attendance').select('work_date')
        .eq('user_id', me.id).order('work_date').limit(1).maybeSingle(),
    ]);
    setToday((a as Today) ?? null);
    setEstates((es ?? []) as Estate[]);
    // 新的在上面 —— 要處理的都是最近幾天的
    setRows(((rep ?? []) as ReportRow[]).slice().reverse());
    setFirstDay((first as { work_date: string } | null)?.work_date ?? d);
    setLoading(false);
  }, [supabase, me.id, d, y, m]);

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

  // null 要原樣傳下去。套 hhmm 之後 null 會變成 '—'，而那是真值 ——
  // punchUi 會以為下班打過了，下班按鈕就消失（punch.ts 裡另有一道防護）。
  const ui = punchUi(today ? {
    in_at: today.in_at ? hhmm(today.in_at) : null,
    out_at: today.out_at ? hhmm(today.out_at) : null,
  } : null);
  // 有座標的物業才算「可以打卡」—— 沒設座標的不該讓人以為能打
  const ready = estates.filter((e) => e.active && e.gps_lat != null && e.gps_lng != null);
  const now = useNow();
  // 時段決定卡片的漸層與問候語。now 還沒好（第一次算繪）時先當下午，
  // 免得閃一下深色再變淺色。
  const phase = dayPhase(now ? taipeiHour(now) : 13);
  const ink = phase.ink;   // 淺色底配墨色字、深色底配白字
  // 打完上班、還沒打下班時才顯示「已工作多久」
  const worked = today?.in_at && !today?.out_at
    ? workedText(hhmm(today.in_at), now ?? new Date()) : '';

  const sum = monthSummary(rows, d, firstDay);
  const shown = onlyTodo ? rows.filter((r) => dayStatus(r, d, firstDay).tone === 'bad') : rows;

  return (
    <div className="space-y-4">
      {!loading && !ready.length && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <b>還不能打卡 —— 沒有任何物業設定打卡位置。</b>
          <div className="text-xs mt-1">
            {isAdmin ? '到「管理」分頁設定物業座標之後就能開始使用。' : '請主管到「出勤 → 管理」設定物業座標。'}
          </div>
        </div>
      )}

      {/* ── 打卡鐘 ─────────────────────────────────── */}
      {/*
        【時段配色】
        顏色如果只是裝飾，它就只是裝飾。跟著時段換之後這張卡多帶了一個
        真的資訊：一眼看得出現在是早上還是晚上 —— 而打卡的人正是在確認
        「現在幾點、我算不算遲到」。
      */}
      {/*
        陰影往下而不是四周散開（shadow-black/20 ＋ 位移），加上一圈
        內縮的白色細邊 —— 深色卡片沒有邊界的話，邊緣會跟背景糊在一起，
        看起來像一塊色塊而不是一張浮起來的卡。
      */}
      <div className={`relative rounded-3xl overflow-hidden
                       shadow-[0_12px_32px_-12px_rgba(46,56,64,0.28)]
                       ${ink.edge}
                       px-5 py-6 sm:px-7 sm:py-7 md:flex md:items-center md:gap-8
                       transition-[background-image] duration-1000 ${phase.gradient}`}>
        {/*
          兩顆模糊的白色圓形。
          純色塊在大面積時看起來很平，加一點光暈之後才像一張「卡片」而不是一個 div。

          底色降飽和之後這兩顆要跟著調淡（20%→10%）—— 原本的亮度是拿來
          對抗螢光紫的，放在暮色紫上就變成兩塊看得出形狀的白斑。
          光暈要讓人感覺得到、但看不出來。

          pointer-events-none —— 它們蓋在按鈕上方，不擋掉點擊。
        */}
        <div aria-hidden className={`pointer-events-none absolute -top-20 -right-12 w-64 h-64
                                    rounded-full blur-3xl ${ink.glow1}`} />
        <div aria-hidden className={`pointer-events-none absolute -bottom-24 left-4 w-48 h-48
                                    rounded-full blur-3xl ${ink.glow2}`} />
        {/* 右下角一個大圖示壓在光暈裡 —— 那是「這是什麼時段」的第二個訊號。
            淡到只剩輪廓：它是氣氛，不是要被讀的東西 */}
        <div aria-hidden className={`pointer-events-none absolute -right-4 -bottom-6
                                    text-[7rem] leading-none select-none ${ink.iconDim}`}>
          {phase.icon}
        </div>

        <div className="relative text-center md:text-left md:flex-1">
          {/* 問候語帶名字 —— 這張卡是「他的」，不是一個公用面板 */}
          <div className={`text-sm font-medium mb-2 ${ink.soft}`}>
            {phase.icon} {phase.greeting}{me.name ? `，${me.name}` : ''}
          </div>
          <Clock now={now} ink={ink} />
          {/*
            【為什麼兩欄要固定寬高】
            「遲到 135 分」只會出現在上班那一欄。用條件渲染的話：
              · 上班欄比下班欄高一行 → 兩欄的基線對不齊
              · 整張卡在打卡的瞬間變高 → 底下的東西整個往下跳
            所以兩欄都固定寬度、警告那一行永遠佔位（沒有就放空字串），
            版面在打卡前後長得一模一樣。
          */}
          {/* 已工作多久。只在「打了上班、還沒打下班」時出現 ——
              那正是這個數字唯一有意義的時候。固定高度,不然打卡瞬間版面會跳 */}
          <div className={`h-4 mt-2 text-[13px] font-medium tabular-nums ${ink.soft}`}>
            {worked || ' '}
          </div>

          <div className="flex items-start justify-center md:justify-start gap-3 mt-3">
            {([['上班', today?.in_at, today?.late_min, '遲到'],
               ['下班', today?.out_at, today?.early_min, '早退']] as const).map(([lb, at, mins, warn]) => (
              // 做成小膠囊而不是裸文字 —— 卡片變亮之後,半透明的白字
              // 在漸層上會糊掉,有底色才讀得清楚
              <div key={lb} className={`w-[7rem] shrink-0 rounded-xl px-3 py-2
                                       backdrop-blur-sm text-center md:text-left ${ink.pill}`}>
                <div className={`text-[11px] leading-none ${ink.dim}`}>{lb}</div>
                <div className={`text-lg font-semibold tabular-nums leading-tight mt-1 ${
                  at ? ink.strong : ink.faint}`}>
                  {hhmm(at)}
                </div>
                <div className={`text-[11px] leading-none h-3 mt-1 truncate ${ink.warn}`}>
                  {!!mins && mins > 0 ? `${warn} ${mins} 分` : ' '}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* 手機上要好按 —— 打卡是站著單手操作的動作 */}
        {/*
          維持整條寬、高 64px —— 打卡是站著單手操作的動作。
          膠囊 ＋ 右邊一個圓形箭頭：圓形是「可以按」最直覺的形狀，
          但只有圓形沒有字的話沒人知道按下去會發生什麼,所以兩個都要。
        */}
        <div className="relative mt-5 md:mt-0 md:w-60">
          {ui.action ? (
            <button onClick={() => doPunch(ui.action!)} disabled={busy || !ready.length}
              className={`group w-full h-16 rounded-full ${ink.btn}
                         pl-6 pr-2 flex items-center justify-between gap-3
                         shadow-lg shadow-black/10
                         hover:shadow-xl active:scale-[0.98] transition
                         disabled:opacity-40 disabled:active:scale-100`}>
              <span className="text-lg font-bold">{busy ? '定位中…' : ui.label}</span>
              <span aria-hidden
                className={`w-12 h-12 shrink-0 rounded-full flex items-center justify-center
                            text-xl transition-transform group-hover:translate-x-0.5
                            ${ink.arrow} ${phase.gradient}`}>
                {busy ? '⏳' : '→'}
              </span>
            </button>
          ) : (
            <div className={`w-full h-16 rounded-full backdrop-blur-sm border
                            flex items-center justify-center gap-2 text-base font-semibold
                            ${ink.done}`}>
              <span className={`w-7 h-7 rounded-full flex items-center justify-center text-sm ${ink.pill}`}>✓</span>
              {ui.label}
            </div>
          )}
          {ui.hint && (
            <div className={`text-[11px] mt-2 text-center ${ink.dim}`}>{ui.hint}</div>
          )}
        </div>
      </div>

      {/* ── 月份切換 ＋ 當月統計 ─────────────────────── */}
      <div>
        <div className="flex items-center gap-1 mb-2">
          <button onClick={() => setYm(shiftMonth(y, m, -1))} aria-label="上個月"
            className="rounded-lg border border-mor-line bg-white w-9 h-9 hover:bg-mor-sand/60">‹</button>
          <div className="text-sm font-semibold flex-1 text-center tabular-nums">
            {y} 年 {m} 月
          </div>
          <button onClick={() => setYm(shiftMonth(y, m, 1))} aria-label="下個月"
            disabled={isThisMonth}
            className="rounded-lg border border-mor-line bg-white w-9 h-9 hover:bg-mor-sand/60 disabled:opacity-30">›</button>
          {!isThisMonth && (
            <button onClick={() => setYm([today0.getFullYear(), today0.getMonth() + 1])}
              className="ml-1 rounded-lg border border-mor-line bg-white px-3 h-9 text-xs hover:bg-mor-sand/60">
              本月
            </button>
          )}
        </div>

        {/*
          三十列數字沒有人會自己加 —— 月底想知道上了幾天、加了幾小時。

          【每一格是一張小卡，不是表格裡的一欄】
          扁平的一排文字要靠對齊來分辨界線，而手機上一換行就分不出
          哪個標題配哪個數字。各自一張卡就沒有這個問題。

          顏色沿用側邊欄那三個：綠＝正常累積、橘＝要注意、藍＝中性。
        */}
        <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
          {([
            // 只有兩個色：綠＝正常累積、藍＝中性。
            // 「遲到早退」有數字才轉琥珀 —— 那是唯一需要被看見的異常。
            /*
              【應到與實到分兩格】（2026-08-16）
              原本只有一格「工時」，而它的算法是「有打卡就算滿 8 小時」——
              遲到兩小時跟準時來，那個數字一模一樣。
              兩格並排，這個月少做多少一眼看得到。
            */
            ['出勤', sum.days, '天', C_IN],
            ['應到', sum.dueHours, '小時', C_NEUTRAL],
            ['實到', sum.actualHours, '小時', C_IN],
            ['加班', sum.otHours, '小時', C_NEUTRAL],
            ['請假', sum.leaveHours, '小時', C_NEUTRAL],
            ['遲到早退', sum.lateDays + sum.earlyDays, '次', C_WARN],
          ] as const).map(([lb, v, unit, c]) => {
            // 0 就是灰的。全部上色的話「這個月加班 0 小時」跟
            // 「加班 12 小時」一樣醒目，而只有後者需要被看見。
            const lit = v > 0;
            return (
              <div key={lb}
                className="rounded-xl border px-3 py-3 text-center sm:text-left"
                style={lit
                  ? { borderColor: `${c}33`, backgroundColor: `${c}0D` }
                  : { borderColor: '#E0DDD5', backgroundColor: '#fff' }}>
                {/* 標籤字距拉開、字級壓小 —— 標籤跟數字同樣大小時，
                    整張卡看起來就是兩行普通文字，沒有主從 */}
                <div className="text-[10px] tracking-[0.12em] text-gray-500">{lb}</div>
                <div className="mt-1 font-bold tabular-nums leading-none text-2xl"
                  style={{ color: lit ? c : '#C9C6BE' }}>
                  {v}
                  <span className="text-[11px] font-normal text-gray-400 ml-1">{unit}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/*
        算不出實到的日子要講出來。
        不講的話「實到 120 小時」看起來完全正常，
        而那個數字少了三天 —— 少掉的部分沒有任何跡象。
      */}
      {sum.actualUnknownDays > 0 && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          有 <b>{sum.actualUnknownDays} 天</b>算不出實到（有上班卡、沒有下班卡）——
          那幾天沒有算進上面的實到合計。
        </div>
      )}

      {/* ── 要處理的 ───────────────────────────────── */}
      {sum.todo > 0 && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <b>{m} 月有 {sum.todo} 天要處理</b> —— 紅色那幾列右邊可以補登。
        </div>
      )}

      {/* ── 出勤明細 ───────────────────────────────── */}
      <div className={`${CARD} overflow-hidden`}>
        <div className="px-4 py-2.5 border-b border-mor-line bg-white/45
                        flex items-center gap-3 text-sm font-medium">
          <span>{m} 月出勤明細</span>
          <div className="flex-1" />
          <label className="flex items-center gap-1.5 text-xs font-normal text-gray-600">
            <input type="checkbox" checked={onlyTodo} onChange={(e) => setOnlyTodo(e.target.checked)} />
            只看要處理的{sum.todo > 0 && `（${sum.todo}）`}
          </label>
        </div>

        {/* 桌機：表格 */}
        <table className="w-full text-sm hidden sm:table">
          <thead>
            <tr className="text-left text-[11px] tracking-wider text-gray-500
                           border-b border-mor-line bg-white/45">
              <th className="px-4 py-2.5">日期</th>
              <th className="px-4 py-2.5">上班卡</th>
              <th className="px-4 py-2.5">下班卡</th>
              <th className="px-4 py-2.5">工時</th>
              <th className="px-4 py-2.5">狀態</th>
              <th className="px-4 py-2.5 text-right"> </th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const s = dayStatus(r, d, firstDay);
              const dow = DOW[new Date(`${r.work_date}T00:00:00+08:00`).getDay()];
              return (
                <tr key={r.work_date}
                  className={`border-b border-mor-line/60 last:border-0 hover:bg-mor-sand/30 ${
                    r.work_date === d ? 'bg-mor-slate/[0.06]' : ''}`}>
                  <td className="px-4 py-2 whitespace-nowrap tabular-nums">
                    {r.work_date.slice(5).replace('-', '/')}
                    <span className={`ml-1 text-xs ${
                      dow === '日' || dow === '六' ? 'text-red-400' : 'text-gray-400'}`}>({dow})</span>
                  </td>
                  <td className={`px-4 py-2 tabular-nums ${(r.late_min ?? 0) > 0 ? 'text-red-600' : ''}`}>
                    {r.in_at ?? <span className="text-gray-300">—</span>}
                  </td>
                  <td className={`px-4 py-2 tabular-nums ${(r.early_min ?? 0) > 0 ? 'text-red-600' : ''}`}>
                    {r.out_at ?? <span className="text-gray-300">—</span>}
                  </td>
                  <td className="px-4 py-2 tabular-nums text-gray-600">
                    {r.work_hours > 0 ? r.work_hours : <span className="text-gray-300">—</span>}
                    {r.ot_hours > 0 && <span className="text-mor-slate">＋{r.ot_hours}</span>}
                  </td>
                  <td className="px-4 py-2">
                    <span className={`rounded-full border px-2 py-0.5 text-[11px] whitespace-nowrap ${
                      TONE_CLS[s.tone]}`}>{s.label}</span>
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
                {loading ? '載入中…' : onlyTodo ? '這個月沒有要處理的 👍' : '這個月沒有紀錄'}
              </td></tr>
            )}
          </tbody>
        </table>

        {/*
          手機：一天一列，不是橫向捲動的表格。
          六欄的表格在 375px 寬的螢幕上只看得到兩欄，而要看狀態得往右滑 ——
          沒有人會滑，他只會覺得這頁在手機上不能用。
        */}
        <div className="sm:hidden divide-y divide-mor-line/60">
          {shown.map((r) => {
            const s = dayStatus(r, d, firstDay);
            const dt = new Date(`${r.work_date}T00:00:00+08:00`);
            const dow = DOW[dt.getDay()];
            const weekend = dt.getDay() === 0 || dt.getDay() === 6;
            return (
              <div key={r.work_date}
                className={`px-4 py-2.5 flex items-center gap-3 ${
                  r.work_date === d ? 'bg-mor-slate/5' : ''}`}>
                <div className="w-11 shrink-0 text-center">
                  <div className="text-base font-semibold tabular-nums leading-none">
                    {Number(r.work_date.slice(8))}
                  </div>
                  <div className={`text-[10px] mt-0.5 ${weekend ? 'text-red-400' : 'text-gray-400'}`}>
                    週{dow}
                  </div>
                </div>

                <div className="flex-1 min-w-0">
                  <div className="tabular-nums text-sm">
                    <span className={(r.late_min ?? 0) > 0 ? 'text-red-600' : ''}>
                      {r.in_at ?? '—'}
                    </span>
                    <span className="text-gray-300 mx-1">→</span>
                    <span className={(r.early_min ?? 0) > 0 ? 'text-red-600' : ''}>
                      {r.out_at ?? '—'}
                    </span>
                    {r.work_hours > 0 && (
                      <span className="text-xs text-gray-400 ml-2">{r.work_hours} 小時</span>
                    )}
                    {r.ot_hours > 0 && (
                      <span className="text-xs text-mor-slate ml-1">＋{r.ot_hours}</span>
                    )}
                  </div>
                  <span className={`inline-block mt-1 rounded-full border px-2 py-0.5 text-[11px] ${
                    TONE_CLS[s.tone]}`}>{s.label}</span>
                </div>

                {s.fixKind && onFix && (
                  <button onClick={() => onFix(r.work_date, s.fixKind!)}
                    className="shrink-0 rounded-lg border border-mor-line px-2.5 py-2 text-xs
                               hover:bg-mor-sand/60 leading-tight">
                    補登<br />{s.fixKind === 'in' ? '上班' : '下班'}
                  </button>
                )}
              </div>
            );
          })}
          {!shown.length && (
            <div className="px-4 py-8 text-center text-sm text-gray-400">
              {loading ? '載入中…' : onlyTodo ? '這個月沒有要處理的 👍' : '這個月沒有紀錄'}
            </div>
          )}
        </div>
      </div>

      <div className="text-xs text-gray-400">
        可打卡：{ready.map((e) => e.name).join('、') || '尚未設定'}
      </div>
    </div>
  );
}
