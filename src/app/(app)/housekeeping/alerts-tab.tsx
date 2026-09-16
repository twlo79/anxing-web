'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase';
import { fetchAll } from '@/lib/fetch-all';
import { FilterBar, Field, FilterSelect } from '@/lib/filters';
import {
  exitsSoon, addDays, lastNightOf,
  type Stay, type Exit,
} from '@/lib/room-calendar';
import {
  ALERT_WINDOWS, DEFAULT_WINDOW, winLabel, winDays, parseWin,
  splitContractExits, contractTypeLabel, daysLabel, exitTone,
  type AlertWindow,
} from '@/lib/hk-alerts';

/*
 * ══════════════════════════════════════════════════════════
 * 未來提醒（2026-09-16 使用者指定）
 *
 * 「多一個未來提醒，包含兩塊。上面可以選物業，然後管家 主管 會計 總經理
 *   都能讀。1. 退租提醒：裡面有 姓名 房源 多久後退 哪一天(住房期間)
 *   2. 退房提醒」
 * 「不要有 hardcode 什麼時候，跟不連到契約。上面有一個選多久退 可以按」
 * 「多一個契約結束提醒，主要是租辦公室與公司登記的契約」
 *
 * ★★★ 判斷全部在 `lib/hk-alerts.ts` 與 `lib/room-calendar.ts`
 *   （加起來 80 幾個測試）—— 這一頁只負責排版。
 *   寫在 `.tsx` 裡的判斷式**測不到**（測試環境不處理 JSX）。
 *
 * ★★ 這一頁跟房源狀態看的是**同一份真相**:同樣的 `exitsSoon()`、
 *   同樣的差一天規則。兩邊各寫一次的話，同一張契約會在兩頁
 *   顯示不同的天數，而沒有人查得出哪一邊才對。
 *
 * ★ 這一頁**不連到契約／訂單**（使用者 2026-09-16 劃掉了那一欄）。
 *   純清單。
 * ══════════════════════════════════════════════════════════
 */

const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

type Est = { id: string; name: string; sort: number | null; active: boolean };

/** 一列要畫的東西。畫面只認這個型別 —— 三塊共用同一張表 */
type Row = {
  id: string;
  name: string;
  room: string;
  estate: string;
  ctype: string | null;
  days: number;
  on: string;
  from: string;
  /** 訂單才有:最後一晚（退房日的前一天） */
  lastNight: string | null;
};

/**
 * 膠囊。**一顆元件畫完整排** —— 兩個地方各寫一次就會有長得不一樣的一天。
 *
 * ★ 定在模組層不是元件裡:定在元件裡的話每次 render 都是新的型別，
 *   React 會把整排拆掉重做。
 * ★★ 字級 `text-uisub` 不是 `text-xs` —— 膠囊是**介面外框**不是資料
 *   （anxing-ui 第四節）。
 */
function Pill({ on, onClick, children }: {
  on: boolean; onClick: () => void; children: React.ReactNode;
}) {
  return (
    <button type="button" onClick={onClick} aria-pressed={on}
      className={`inline-flex items-center rounded-full border px-3.5 py-2 text-uisub
                  transition-colors whitespace-nowrap ${
        on ? 'bg-mor-ink border-mor-ink text-white font-medium'
           : 'bg-white border-mor-line text-gray-600 hover:bg-mor-sand/60'}`}>
      {children}
    </button>
  );
}

export default function AlertsTab() {
  const supabase = useMemo(() => createClient(), []);

  /*
   * ★★ 窗口記在網址上（`?win=90`）—— 重新整理、或把連結丟給會計，
   *   看到的是同一份。`parseWin` 認不得就回預設（不是「全部」）。
   */
  const [win, setWin] = useState<AlertWindow>(() => {
    if (typeof window === 'undefined') return DEFAULT_WINDOW;
    return parseWin(new URLSearchParams(window.location.search).get('win'));
  });
  /*
   * ★★★ 物業預設「全部」，不是第一個。
   *   房源狀態預設正隆是因為那是**看版面**的頁 —— 一次看一棟才讀得完。
   *   這一頁是**待辦清單**:要看的是「接下來有哪些事」，
   *   漏掉一棟就是漏掉幾件事。
   */
  const [estF, setEstF] = useState('');
  const [estates, setEstates] = useState<Est[]>([]);
  const [lease, setLease] = useState<Row[]>([]);
  const [biz, setBiz] = useState<Row[]>([]);
  const [leaving, setLeaving] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  function pickWin(w: AlertWindow) {
    setWin(w);
    if (typeof window === 'undefined') return;
    const u = new URL(window.location.href);
    u.searchParams.set('tab', 'alerts');
    u.searchParams.set('win', String(w));
    window.history.replaceState(null, '', u.toString());
  }

  const load = useCallback(async () => {
    setLoading(true);
    setErr('');
    const t0 = todayStr();
    const n = winDays(win);
    const until = addDays(t0, n);

    /*
     * ★★★ 三份查詢的基準都是**今天**，不是任何畫面上的期間。
     *   提醒問的是「真實世界接下來會發生什麼」。
     *
     * ★★★ 訂單要排掉 `contract_id` 有值的那些 —— 那是契約每個月
     *   長出來的**月租單**，它的 checkout 是下個月一號。
     *   拿去算「N 天內退房」的話，每一間長租房每個月都會叫一次，
     *   而那個人根本沒有要退房。這一條錯的話，提醒會變成每月固定的雜訊，
     *   然後就沒有人再看它。
     *
     * ★★ 契約**不篩 `room`**。公司登記只借地址、沒有房號 ——
     *   照房源狀態那頁的寫法 `.filter(c => c.room)` 會把它們整批丟掉，
     *   而那正是這一頁第三塊要看的東西。
     */
    /*
     * ★★★ 解構的形狀要跟**每一支查詢實際回什麼**對上：
     *     `supabase.from(...)`  → `{ data, error }`
     *     `fetchAll(...)`       → `{ rows, error }`
     *   混在同一個 `Promise.all` 裡最容易錯的就是這裡 ——
     *   2026-09-16 把 properties 改成分頁之後忘了改解構，
     *   `next build` 當場擋下來（`Property 'data' does not exist`）。
     */
    const [{ data: es }, pq, cq, oq] = await Promise.all([
      supabase.from('estates').select('id, name, sort, active').order('sort').order('name'),
      /* 訂單只有房號（`property_raw`），物業要靠這張表回推 */
      fetchAll<any>((a, b) => supabase.from('properties')
        .select('name, estate_id').range(a, b)),
      /*
       * ★★★ 契約也要分頁。Supabase 預設最多回 **1000 列而且不報錯** ——
       *   窗口選「全部」時這一支等於「所有還沒到期的契約」,
       *   第 1001 筆之後會安靜消失,而畫面上只是「怎麼少了幾張」。
       */
      fetchAll<any>((a, b) => supabase.from('contracts')
        .select('id, room, tenant_name, display_name, start_date, end_date, type, estate_id')
        .eq('active', true).gte('end_date', t0).lte('end_date', until).range(a, b)),
      fetchAll<any>((a, b) => supabase.from('orders')
        .select('id, property_raw, guest_name, checkin, checkout, source, contract_id')
        .not('source', 'in', '(oneoff,airbnb_cancelled)')
        .is('contract_id', null)
        .gte('checkout', t0).lte('checkout', until).range(a, b)),
    ]);

    const estAll = (es ?? []) as Est[];
    setEstates(estAll.filter((e) => e.active));
    const estName: Record<string, string> = {};
    estAll.forEach((e) => { estName[e.id] = e.name; });

    /* 房號 → 物業名 */
    const estOfRoom: Record<string, string> = {};
    ((pq.rows as any[]) ?? []).forEach((p) => {
      if (p.name && p.estate_id) estOfRoom[p.name] = estName[p.estate_id] ?? '';
    });

    /*
     * ★★ 撈不完要講出來。這一頁是待辦清單 ——
     *   少一列就是少一件該做的事，而畫面上完全看不出來。
     */
    if (oq.error) setErr('訂單沒有撈完：' + oq.error);
    else if (cq.error) setErr('契約沒有撈完：' + cq.error);
    else if (pq.error) setErr('房源沒有撈完：' + pq.error);

    const cStays: Stay[] = ((cq.rows as any[]) ?? []).map((c) => ({
      id: `c${c.id}`, srcId: c.id as string,
      room: (c.room as string) ?? '',
      kind: 'contract' as const,
      start: c.start_date, end: c.end_date,
      guest: c.display_name || c.tenant_name,
      tone: 'longterm' as const,
      ctype: c.type as string | null,
    }));

    /*
     * ★★★ 契約的物業另外開一張表，**不塞進 `Stay` 的欄位裡**。
     *   `contractId` 那一欄有它自己的用途（`dropContractOrders()` 靠它），
     *   借來裝 estate_id 的話，哪天有人把這批 stay 餵給那支函式，
     *   它會拿物業 id 去比對契約 id —— 而那不會報錯，只會安靜地比不中。
     *
     * ★★ 契約自己有 `estate_id`，不用靠房號回推 ——
     *   公司登記沒有房號，回推那條路對它們完全走不通。
     */
    const estOfContract: Record<string, string> = {};
    ((cq.rows as any[]) ?? []).forEach((c) => {
      estOfContract[`c${c.id}`] = estName[c.estate_id ?? ''] ?? '';
    });

    const oStays: Stay[] = ((oq.rows as any[]) ?? [])
      .filter((o) => o.property_raw)
      .map((o) => ({
        id: `o${o.id}`, srcId: o.id as string,
        room: o.property_raw as string, kind: 'order' as const,
        start: o.checkin, end: o.checkout, guest: o.guest_name,
        tone: (o.source === 'private' ? 'private' : 'short') as Stay['tone'],
      }));

    const toRow = (e: Exit, estate: string): Row => ({
      id: e.stay.id,
      name: e.stay.guest || '（沒有名字）',
      room: e.stay.room,
      estate,
      ctype: e.stay.ctype ?? null,
      days: e.days,
      on: e.on,
      from: e.stay.start ?? '',
      lastNight: e.stay.kind === 'order' ? lastNightOf(e.stay) : null,
    });

    const cExits = exitsSoon(cStays, t0, 'contract', n);
    const { lease: L, biz: B } = splitContractExits(cExits);
    setLease(L.map((e) => toRow(e, estOfContract[e.stay.id] ?? '')));
    setBiz(B.map((e) => toRow(e, estOfContract[e.stay.id] ?? '')));

    const oExits = exitsSoon(oStays, t0, 'order', n);
    setLeaving(oExits.map((e) => toRow(e, estOfRoom[e.stay.room] ?? '')));

    setLoading(false);
  }, [supabase, win]);
  useEffect(() => { load(); }, [load]);

  /* 物業是畫面上篩的 —— 切換不用重新查一次資料庫 */
  const pick = useCallback((rows: Row[]) => {
    const nm = estates.find((e) => e.id === estF)?.name ?? '';
    return nm ? rows.filter((r) => r.estate === nm) : rows;
  }, [estF, estates]);

  const vLease = useMemo(() => pick(lease), [pick, lease]);
  const vBiz = useMemo(() => pick(biz), [pick, biz]);
  const vLeaving = useMemo(() => pick(leaving), [pick, leaving]);

  return (
    <div className="px-4 md:px-0">
      <FilterBar
        right={
          <span className="text-uisub text-gray-500 pb-1.5 whitespace-nowrap">
            退租 <b className="text-mor-ink">{vLease.length}</b>
            退房 <b className="text-mor-ink">{vLeaving.length}</b>
            結束 <b className="text-mor-ink">{vBiz.length}</b>
          </span>
        }>
        <FilterSelect label="物業" value={estF} onChange={setEstF}
          options={estates.map((e) => ({ value: e.id, label: e.name }))}
          all="全部物業" />
        {/*
          ★★★ 天數是**按出來的**，不是寫死在標題上。
            原本標題掛著「契約在 180 天內到期」—— 那行字等於把一個
            使用者改不動的決定印在畫面上（2026-09-16 他把它劃掉了）。
        */}
        <Field label="多久後退">
          <div className="flex flex-wrap gap-1.5">
            {ALERT_WINDOWS.map((w) => (
              <Pill key={w} on={win === w} onClick={() => pickWin(w)}>{winLabel(w)}</Pill>
            ))}
          </div>
        </Field>
      </FilterBar>

      {err && (
        <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700">
          ⚠ {err}　—— 這張清單目前是<b>不完整</b>的，不要拿它當待辦。
        </div>
      )}

      {loading && <p className="text-sm text-gray-400 py-6 text-center">載入中…</p>}

      {!loading && (
        <>
          <Block kind="lease" rows={vLease} win={win} />
          <Block kind="stay" rows={vLeaving} win={win} />
          <Block kind="biz" rows={vBiz} win={win} />
        </>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════ */

const TONE_CLS: Record<string, string> = {
  hot: 'text-[#B3423C]', warm: 'text-[#8a6d1f]', calm: 'text-gray-700',
};

const TITLE = { lease: '退租提醒', stay: '退房提醒', biz: '契約結束提醒' } as const;
const DATE_COL = { lease: '退租日', stay: '退房日', biz: '結束日' } as const;
const WHEN_COL = { lease: '多久後退', stay: '多久後退', biz: '多久後結束' } as const;
const SPAN_COL = { lease: '住房期間', stay: '住房期間', biz: '契約期間' } as const;
const EMPTY = {
  lease: '沒有長租契約到期',
  stay: '沒有訂單要退房',
  biz: '沒有公司登記或辦公室契約到期',
} as const;
const FOOT = {
  lease: '★ 契約的「迄」就是最後一晚 —— 租期迄那天就是退租日，不用 ±1。',
  stay: '★ checkout 是退房日，最後一晚是它的前一天。當天就可以進去打掃、也可以接新客。',
  biz: '★ 公司登記與辦公室沒有人要搬出去 —— 到期要做的是問要不要續約，不是排打掃。有些只借地址登記、沒有房號。',
} as const;

type Kind = keyof typeof TITLE;

function Block({ kind, rows, win }: { kind: Kind; rows: Row[]; win: number }) {
  const isBiz = kind === 'biz';
  return (
    <div className="mb-4 rounded-xl border border-mor-line bg-white overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 border-b border-mor-line bg-mor-sand/30">
        <b className="text-ui">{TITLE[kind]}</b>
        <span className="ml-auto text-uisub text-gray-500">
          <b className="text-mor-ink">{rows.length}</b> 筆
        </span>
      </div>

      {/*
        ★★★ 沒有半筆的時候要**講出答案**，不是留一片空白。
          「接下來 30 天沒有訂單要退房」是一個有用的答案 ——
          空白只會讓人以為這個功能沒做出來（2026-09-16 使用者:
          「退房按鈕還沒看到」，那顆其實在，只是當時 0 筆）。
      */}
      {!rows.length ? (
        <p className="py-8 text-center text-sm text-gray-400">
          {win === 0 ? '往後' : `接下來 ${win} 天`}{EMPTY[kind]}。
        </p>
      ) : (
        <>
          {/* ── 桌機：表格 ── */}
          <table className="w-full text-sm hidden md:table">
            <thead>
              <tr className="text-left text-xs text-gray-500 border-b border-mor-line">
                <th className="px-4 py-2">姓名</th>
                {isBiz && <th className="px-4 py-2">類別</th>}
                <th className="px-4 py-2">房源</th>
                <th className="px-4 py-2">{WHEN_COL[kind]}</th>
                <th className="px-4 py-2">{DATE_COL[kind]}</th>
                <th className="px-4 py-2">{SPAN_COL[kind]}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-mor-line/50 last:border-0 hover:bg-mor-sand/20">
                  <td className="px-4 py-2 font-medium">{r.name}</td>
                  {isBiz && (
                    <td className="px-4 py-2 text-xs text-gray-500">{contractTypeLabel(r.ctype)}</td>
                  )}
                  <td className="px-4 py-2 tabular-nums">
                    {r.room || <span className="text-gray-300">無房號</span>}
                    {r.estate && <span className="ml-1.5 text-xs text-gray-400">{r.estate}</span>}
                  </td>
                  {/*
                    ★★★ 紅／琥珀的門檻**固定**在 7／30，不跟著天數選擇器跑。
                      跟著跑的話，選「7 天」時整頁都紅 —— 那就等於沒有標色。
                  */}
                  <td className={`px-4 py-2 font-bold tabular-nums whitespace-nowrap ${
                    TONE_CLS[exitTone(r.days)]}`}>
                    {daysLabel(r.days)}
                  </td>
                  {/* ★ 完整年月日不縮寫 —— 這一欄會被抄去排清潔、通知房客 */}
                  <td className="px-4 py-2 tabular-nums whitespace-nowrap">{r.on}</td>
                  <td className="px-4 py-2 text-xs text-gray-500 tabular-nums whitespace-nowrap">
                    {r.from || '—'} ~ {r.on}
                    {r.lastNight && (
                      <span className="ml-2 text-gray-400">最後一晚 {r.lastNight}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* ── 手機：卡片。表格六欄在 390px 上放不下 ── */}
          <div className="md:hidden divide-y divide-mor-line/50">
            {rows.map((r) => (
              <div key={r.id} className="px-4 py-3">
                <div className="flex items-baseline gap-2">
                  <span className="font-medium text-sm flex-1 min-w-0 truncate">{r.name}</span>
                  <span className={`text-sm font-bold tabular-nums shrink-0 ${
                    TONE_CLS[exitTone(r.days)]}`}>{daysLabel(r.days)}</span>
                </div>
                <div className="text-xs text-gray-500 mt-0.5 tabular-nums">
                  {isBiz && <span className="mr-1.5">{contractTypeLabel(r.ctype)}</span>}
                  {r.room || '無房號'}{r.estate ? `・${r.estate}` : ''}　{DATE_COL[kind]} {r.on}
                </div>
                <div className="text-xs text-gray-400 mt-0.5 tabular-nums">
                  {r.from || '—'} ~ {r.on}
                  {r.lastNight && <span className="ml-2">最後一晚 {r.lastNight}</span>}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <p className="px-4 py-2 border-t border-dashed border-mor-line bg-mor-sand/20
                    text-[11px] text-gray-500 leading-relaxed">
        {FOOT[kind]}
      </p>
    </div>
  );
}
