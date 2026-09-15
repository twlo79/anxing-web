'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase';
import { fetchAll } from '@/lib/fetch-all';
import { FilterBar, Field, FilterSelect, FilterSearch, FilterClear, FilterCount } from '@/lib/filters';
import {
  daysInMonth, ymd, isWeekend, weekdayOf, sortRooms, matchRoom,
  rowOf, hasFreeDay, hasStay, overlapRanges, dropContractOrders,
  type Stay, type Room, type Cell,
} from '@/lib/room-calendar';

/*
 * ══════════════════════════════════════════════════════════
 * 房源狀態（2026-09-15 使用者指定）
 *
 * 一條一個房源、橫軸是日期，訂單與契約畫在同一條線上，空白就是空房。
 *
 * ★★★ 「哪一格有人」的算法全部在 `lib/room-calendar.ts`（有 24 個測試）——
 *   這一頁只負責排版。兩種來源的「迄」邊界不一樣（短租是退房日、
 *   契約是最後一晚），那是最容易錯一格的地方，
 *   而錯一格的後果是「畫面說有人、實際上空著」—— 有人會照著它排錯房。
 *
 * ★★ 房源清單來自 `properties`，**不是從訂單反推**。
 *   從訂單反推的話，「整個月都空著」的房間永遠不會出現在畫面上 ——
 *   而那正是最想看到的那幾間。
 *
 * ★★ 只畫**還在用**（`active`）而且**有設物業**的房源
 *   （使用者 2026-09-15：「物業只有正隆」）。
 *   停用的舊房源（舊-A5、C房…）不是今天要排的房，
 *   混在裡面會讓人捲過三十列才找到真的那一間。
 *   沒設物業的不是靜靜消失 —— 下面另外列出來，不然沒人會知道要去補。
 * ══════════════════════════════════════════════════════════
 */

const WD = ['日', '一', '二', '三', '四', '五', '六'];

/** 顏色。跟圖例是同一份 —— 兩邊各寫一次就會有對不起來的一天 */
const TONE: Record<Stay['tone'], { bar: string; label: string }> = {
  short:    { bar: 'bg-[#2F8C8C]',  label: '短租（Airbnb／Agoda）' },
  private:  { bar: 'bg-mor-green',  label: '私下' },
  longterm: { bar: 'bg-mor-slate',  label: '長租契約' },
  earnest:  { bar: 'bg-[#C9A227]',  label: '訂金／未確認' },
};

/** 重疊清單裡標「這一筆是哪裡來的」—— 沒有這兩個字就不知道去哪一頁修 */
const KIND: Record<Stay['kind'], string> = { contract: '契約', order: '訂單' };

/** `2026-10-26` → `10/26`。年份在月份篩選上，這裡再寫一次只是雜訊 */
const mdOf = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;

const thisYm = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};
const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

type Est = { id: string; name: string; sort: number | null };

export default function RoomStatusPage() {
  const supabase = useMemo(() => createClient(), []);

  const [ym, setYm] = useState(thisYm());
  const [estF, setEstF] = useState('');
  const [kwInput, setKwInput] = useState('');
  const [kw, setKw] = useState('');
  const [only, setOnly] = useState<'' | 'free' | 'busy'>('');

  const [estates, setEstates] = useState<Est[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  /** 還在用、但沒設物業的房源名稱 —— 畫不出來，所以列出來 */
  const [noEstate, setNoEstate] = useState<string[]>([]);
  const [stays, setStays] = useState<Stay[]>([]);
  const [loading, setLoading] = useState(true);

  /*
   * ★★ 一進來就選好物業（使用者 2026-09-15：「預設物業選正隆」）。
   *   排序第一個 —— 不是把「正隆」寫死在這裡。多一個物業的那天，
   *   把它的 `sort` 調到前面就好，不用再改一次程式。
   *
   * ★ `load` 每換一次月份就會跑，所以只認第一次 ——
   *   不然使用者切到「全部」再換個月份，畫面會自己跳回正隆。
   */
  const defaulted = useRef(false);
  const defEst = estates[0]?.name ?? '';

  const days = daysInMonth(ym);
  const today = todayStr();

  const load = useCallback(async () => {
    setLoading(true);
    const from = `${ym}-01`;
    const to = ymd(ym, daysInMonth(ym));

    const [{ data: es }, { data: ps }] = await Promise.all([
      supabase.from('estates').select('id, name, sort').order('sort'),
      // ★ 停用的房源不畫（使用者 2026-09-15：「物業只有正隆」）
      supabase.from('properties').select('id, name, estate_id')
        .eq('active', true).order('name'),
    ]);
    const estList = (es ?? []) as Est[];
    const estById: Record<string, Est> = {};
    estList.forEach((e) => { estById[e.id] = e; });
    setEstates(estList);
    if (!defaulted.current && estList.length) {
      defaulted.current = true;
      setEstF(estList[0].name);
    }

    const allRooms: Room[] = ((ps ?? []) as any[]).map((p) => ({
      name: p.name as string,
      estate: estById[p.estate_id]?.name ?? null,
      estateSort: estById[p.estate_id]?.sort ?? null,
    }));
    setRooms(allRooms.filter((r) => r.estate));
    setNoEstate(allRooms.filter((r) => !r.estate).map((r) => r.name));

    /*
     * ★★ 撈的是「跟這個月有交集」的，不是「起日在這個月」的 ——
     *   後者會漏掉跨月的長住（8/20 住到 9/10 那種），
     *   而畫面上那間房會顯示成空的。
     *
     * ★ 訂單的 checkout 是**退房日**，所以條件要 `> from` 不是 `>= from`：
     *   9/1 退房的單最後一晚是 8/31，跟九月沒有交集。
     */
    const { rows: os } = await fetchAll<any>((f, t) => supabase.from('orders')
      .select('id, property_raw, guest_name, checkin, checkout, source, imported_via, contract_id')
      .not('source', 'in', '(oneoff,airbnb_cancelled)')
      .lte('checkin', to).gt('checkout', from).range(f, t));

    const { data: cs } = await supabase.from('contracts')
      .select('id, room, tenant_name, display_name, start_date, end_date, active, earnest_only')
      .lte('start_date', to).gte('end_date', from);

    const oStays: Stay[] = ((os ?? []) as any[])
      .filter((o) => o.property_raw)
      .map((o) => ({
        id: `o${o.id}`, room: o.property_raw as string, kind: 'order' as const,
        start: o.checkin, end: o.checkout, guest: o.guest_name,
        tone: (o.source === 'private' ? 'private' : 'short') as Stay['tone'],
        contractId: o.contract_id as string | null,
      }));

    const cStays: Stay[] = ((cs ?? []) as any[])
      .filter((c) => c.room && c.active !== false)
      .map((c) => ({
        id: `c${c.id}`, room: c.room as string, kind: 'contract' as const,
        start: c.start_date, end: c.end_date,
        guest: c.display_name || c.tenant_name,
        /*
         * ★ 還在訂金階段的契約單獨一色（使用者 2026-09-15 選的）。
         *   房客還沒入住，但那間房**已經不能給別人** ——
         *   畫成一般長租的話看起來像已經住進去了。
         */
        tone: (c.earnest_only ? 'earnest' : 'longterm') as Stay['tone'],
        contractId: c.id as string,
      }));

    /*
     * ★★★ 契約產生的月租單跟契約畫的是同一段期間 ——
     *   兩筆都留的話每一間長租房的每一天都會被算成「重疊」
     *   （2026-09-15 上線第一天的樣子）。規則與理由在 `dropContractOrders()`。
     */
    setStays(dropContractOrders([...oStays, ...cStays]));
    setLoading(false);
  }, [supabase, ym]);
  useEffect(() => { load(); }, [load]);

  /** 房源 → 這個月的佔用 */
  const byRoom = useMemo(() => {
    const m: Record<string, Stay[]> = {};
    stays.forEach((s) => { (m[s.room] ??= []).push(s); });
    return m;
  }, [stays]);

  const visible = useMemo(() => {
    const picked = estF ? rooms.filter((r) => r.estate === estF) : rooms;
    return sortRooms(picked)
      .map((r) => ({ room: r, stays: byRoom[r.name] ?? [] }))
      .filter((x) => matchRoom(x.room, x.stays, kw))
      .map((x) => ({ ...x, cells: rowOf(x.stays, ym) }))
      .filter((x) => (only === 'free' ? hasFreeDay(x.cells)
        : only === 'busy' ? hasStay(x.cells) : true));
  }, [rooms, byRoom, estF, kw, only, ym]);

  /** 同一間房同一天有兩筆 —— 資料有問題，列出來讓人去修 */
  const dup = useMemo(() => visible
    .flatMap((x) => overlapRanges(x.stays, ym).map((r) => ({ room: x.room.name, ...r }))),
  [visible, ym]);

  /*
   * ★ 預設的那個物業**不算篩選** —— 算的話篩選列一進來就亮著、
   *   「清除」永遠可按，而按下去什麼都沒變（它本來就是預設值）。
   */
  const active = !!((estF && estF !== defEst) || kw || only);

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h1>房源狀態
          <span className="text-sm font-normal text-gray-400 ml-2">
            訂單與契約畫在同一條線上，空白就是空房
          </span>
        </h1>
      </div>

      <FilterBar active={active} right={<FilterCount n={visible.length} unit="間" />}>
        <FilterSelect label="物業" value={estF} onChange={setEstF}
          options={estates.map((e) => ({ value: e.name, label: e.name }))} />
        <Field label="月份">
          <input type="month" value={ym} onChange={(e) => setYm(e.target.value || thisYm())}
            className="h-12 md:h-10 rounded-lg border border-gray-300 px-2 text-ui" />
        </Field>
        {/*
          ★ placeholder 寫「可以搜哪些」—— 標題一律留「關鍵字」（filters.tsx 的規矩）。
            使用者 2026-09-15 指定要能打房客名字，所以那三個字一定要出現在這裡，
            不然沒有人會知道搜得到。
        */}
        <FilterSearch value={kwInput} onChange={setKwInput}
          onSubmit={() => setKw(kwInput.trim())} placeholder="房源／房客" />
        <Field label="顯示">
          <div className="flex gap-1.5">
            {([['', '全部'], ['free', '只看空房'], ['busy', '只看有客']] as const).map(([v, t]) => (
              <button key={v} onClick={() => setOnly(v as any)}
                className={`h-12 md:h-10 rounded-lg border px-3 text-uisub
                  ${only === v ? 'bg-mor-slate text-white border-mor-slate'
                               : 'bg-white border-gray-300 text-gray-600 hover:bg-mor-sand'}`}>
                {t}
              </button>
            ))}
          </div>
        </Field>
        {/* ★ 清除也要把輸入框清掉 —— 只清 kw 的話框裡還留著字，看起來像沒生效 */}
        {/* ★ 清除是回到「預設」，不是回到「全部」 */}
        <FilterClear active={active} onClear={() => {
          setEstF(defEst); setKw(''); setKwInput(''); setOnly('');
        }} />
      </FilterBar>

      {/*
        ★★ 沒設物業的房源畫不出來（左邊那一欄要顯示物業、篩選也是按物業）。
          但**靜靜不見**是最糟的做法 —— 有人新增了房源忘了選物業，
          它就會從此不在任何一張排房表上，而沒有人會發現。
      */}
      {noEstate.length > 0 && (
        <div className="mb-3 rounded-xl border border-mor-line bg-mor-sand/60 px-4 py-2.5 text-xs text-gray-600">
          <b>{noEstate.length} 間房源沒有設定物業</b>，沒有畫在下面 ——
          到「管理 → 物業與房源」把它們歸到物業底下就會出現：
          <span className="ml-1 text-gray-500">{noEstate.join('、')}</span>
        </div>
      )}

      {/*
        ★★★ 一行一段，而且**寫出是哪幾筆**（使用者 2026-09-15）。
          原本只列「14B2 26、27、28、29、30、31 號」——
          他去契約清單搜 14B2 只有一筆，就沒路可走了。
          說得出「金鋒（契約）× Roni（訂單）」才修得動。
      */}
      {dup.length > 0 && (
        <div className="mb-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-xs text-amber-800">
          <b>同一間房同時有兩筆</b> —— 日曆上只畫得下其中一筆，所以這裡列出來：
          <div className="mt-1.5 space-y-1">
            {dup.map((d) => (
              <div key={`${d.room}/${d.from}`}>
                <b>{d.room}</b>
                <span className="ml-2">{mdOf(d.from)}{d.to === d.from ? '' : `～${mdOf(d.to)}`}</span>
                <span className="ml-2">
                  {d.stays.map((s) => `${s.guest || '（沒有名字）'}（${KIND[s.kind]}）`).join('　×　')}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/*
        ★★ 左邊房源欄與上面日期列都**釘住**（sticky）。
          橫軸三十天一定要橫向捲動，不釘住的話捲到第 20 天
          就看不出這是哪一間、哪一號（anxing-ui 第二節）。
      */}
      <div className="rounded-xl border border-mor-line bg-white overflow-auto max-h-[70vh]">
        <table className="border-separate border-spacing-0 text-xs w-max min-w-full">
          <thead>
            <tr>
              <th className="sticky left-0 top-0 z-30 bg-mor-sand border-b border-r border-mor-line
                             min-w-[150px] max-w-[150px] px-2.5 py-1.5 text-left font-semibold">房源</th>
              {/*
                ★★★ 「今天」畫在**表頭**，不是畫在格子上。
                  原本是每一格 `c.day === today` 就加一條藍色左框 ——
                  但有人住的那幾天會被合併成**一個** `td`（`colSpan`），
                  那個 td 的 `day` 是**起日**不是今天，所以條件永遠不成立:
                  結果只有空房那幾列畫得出來，看起來就是一條來路不明的藍線
                  （使用者 2026-09-15：「中間藍色的是甚麼」）。

                  表頭沒有合併問題，而且是 sticky 的 —— 捲到哪裡都看得到。
                  「今天」兩個字取代星期，所以高度沒變。
              */}
              {Array.from({ length: days }, (_, i) => i + 1).map((d) => {
                const day = ymd(ym, d);
                const w = weekdayOf(day);
                const isToday = day === today;
                return (
                  <th key={d} className={`sticky top-0 z-20 border-b border-r border-mor-line
                      min-w-[42px] py-1 text-center font-semibold
                      ${isToday ? 'bg-mor-slate text-white'
                                : `bg-mor-sand ${isWeekend(day) ? 'text-[#C25B5B]' : ''}`}`}>
                    {d}
                    <div className={`font-normal text-[10px] ${isToday ? 'opacity-100' : 'opacity-70'}`}>
                      {isToday ? '今天' : WD[w]}
                    </div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {visible.map(({ room, cells }) => (
              <tr key={`${room.estate}/${room.name}`} className="h-8">
                <td className="sticky left-0 z-10 bg-white border-b border-r border-mor-line
                               min-w-[150px] max-w-[150px] px-2.5 font-medium whitespace-nowrap
                               overflow-hidden text-ellipsis">
                  {room.name}
                  <span className="text-gray-400 font-normal text-[11px] ml-1.5">{room.estate}</span>
                </td>
                {cells.map((c: Cell) => {
                  const cls = `relative border-b border-r border-mor-line min-w-[42px]
                    ${isWeekend(c.day) ? 'bg-mor-bg/50' : 'bg-white'}`;
                  if (c.type === 'free') return <td key={c.day} className={cls} />;
                  return (
                    <td key={c.day} colSpan={c.span} className={cls}>
                      <div title={`${c.stay.guest ?? ''}　${c.stay.start} ~ ${c.stay.end}`}
                        className={`absolute inset-y-1 inset-x-0.5 rounded-md px-1.5
                          flex items-center text-[11px] font-semibold text-white
                          whitespace-nowrap overflow-hidden ${TONE[c.stay.tone].bar}`}>
                        {c.stay.guest ?? ''}
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
            {!loading && visible.length === 0 && (
              <tr><td colSpan={days + 1} className="px-4 py-8 text-center text-gray-400">
                沒有符合的房源
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap gap-4 text-xs text-gray-600 mt-3">
        {(Object.keys(TONE) as Stay['tone'][]).map((k) => (
          <span key={k}>
            <i className={`inline-block w-3 h-3 rounded-sm mr-1.5 -mb-px align-middle ${TONE[k].bar}`} />
            {TONE[k].label}
          </span>
        ))}
        <span>
          <i className="inline-block w-3 h-3 rounded-sm mr-1.5 -mb-px align-middle bg-white border border-mor-line" />
          空房
        </span>
      </div>

      {/*
        ★★★ 兩種「迄」的規則寫在畫面上（使用者 2026-09-15 定的）。
          不寫的話，看到「9/18 退房那格是空的」的人會以為畫錯了 ——
          而那一格空著正是對的，當天可以接新客。
      */}
      <p className="text-[11px] text-gray-400 mt-2 leading-relaxed">
        短租的「迄」是<b>退房日</b>，最後一晚是前一天（9/18 退房 → 只佔到 17 號，18 號可接新客）；
        契約的「迄」<b>就是最後一晚</b>，含當日。
      </p>
    </div>
  );
}
