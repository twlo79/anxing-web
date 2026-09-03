'use client';
/**
 * 暫付分頁 —— 公司付出去、之後要收回來的押金與保證金（migration_196）。
 *
 * ============================================================
 * 【★★★ 為什麼拆成 hook ＋ 兩個元件】（2026-09-01 使用者:「tab 位置被移動」）
 *
 * 這一頁的版面順序是**固定的**:
 *
 *     總計 ＋ 統計卡  →  分頁籤  →  篩選 ＋ 清單
 *
 * 分頁籤夾在中間。所以暫付的卡片必須放在分頁籤**之前**、清單放在**之後** ——
 * 一個元件包全部的話，它只能整塊放在分頁籤下面，
 * 於是切到暫付時分頁籤會從畫面中間跳到最上面。
 *
 * ★ 第一版就是那樣做的，而使用者一眼就看到了。**版面順序不是實作細節**:
 *   使用者在頁面上找東西靠的是位置記憶，換一個分頁就換一個位置
 *   等於每次都要重新找。
 *
 * ★★ 拆開之後兩邊要共用同一份資料 —— 所以資料抓取提成 `useAdvance()`，
 *   由 page 呼叫一次，把結果分別傳給兩個元件。
 *   兩個元件各自抓一次的話，數字會有一瞬間對不上，
 *   而且新增一筆之後只有其中一邊會更新。
 *
 * ============================================================
 * 【為什麼不塞進 deposits/page.tsx】
 *
 * 那一頁已經 2,300 行，而暫付跟暫收**只有版面像**:
 *
 *   暫收   錢是別人的，退款要走兩票核可（主管＋總經理）
 *   暫付   錢是我們的，收回是錢進來，不需要核可
 *
 * 混在同一個元件裡的話，每一個判斷式都要先問「這是哪一種」——
 * 而那正是 CLAUDE.md 說的「以後每次都要多想一次」。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase';
import StatCard, { StatRow, StatGroup, StatTotal } from '@/components/StatCard';
import MoneyInput from '@/components/MoneyInput';
import { useOnce } from '@/lib/once';
import {
  statusOf, STATUS_LABEL, forfeitedOf, statsOf, validateAdvance,
  defaultRefundAccount, refundAccountWarning, needsForfeitExpense,
  CATEGORIES, type Advance, type AdvanceStatus,
  purposeFromSelect, purposeToSelect, purposeLabel, PURPOSE_OFFICE, OFFICE_LABEL,
} from '@/lib/advance';

const fmt = (n: number) => Math.round(Number(n) || 0).toLocaleString('en-US');

/*
 * 狀態的顏色。★ 照站上既有的語意（記在 ToggleInfo）:
 *   琥珀＝還沒定案的錢（錢在外面，等它回來）
 *   綠＝已收（收回來了）
 *   紅＝警示（被扣了，那是真的損失）
 */
const STATUS_CLASS: Record<AdvanceStatus, string> = {
  draft:    'bg-gray-100 text-gray-500',
  paid:     'bg-amber-50 text-amber-700',
  refunded: 'bg-mor-greenlight text-mor-greendark',
  partial:  'bg-red-50 text-red-600',
};

const CAT_CLASS: Record<string, string> = {
  押金:   'bg-mor-bluelight text-mor-slate',
  保證金: 'bg-purple-50 text-purple-700',
  // ★ 零用金給琥珀（migration_212）。少了這一列不會報錯，只是變成沒有底色的白字
  零用金: 'bg-amber-50 text-amber-700',
  其他:   'bg-gray-100 text-gray-600',
};

const CTRL = 'h-11 md:h-9 rounded-lg border border-gray-300 px-2 text-sm bg-white';

/**
 * 必填欄位的標題（2026-09-03 使用者:「必填 打*」）。
 *
 * ★★ 只有**真的會擋下存檔**的四個欄位可以用這個 ——
 *   類別、對象、項目、暫付款（`validateAdvance` 擋的就是這四個）。
 *   標了星卻不擋、或擋了卻沒標，兩種都會讓人不信任那顆星。
 *
 * ★ 星號是紅的而且在字後面 —— 表單慣例，不用另外解釋。
 */
function Req({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-xs text-gray-500">
      {children}<span className="text-red-500 ml-0.5">*</span>
    </span>
  );
}

type Row = Advance & { id: string; estate_id: string | null; purpose_type?: string | null; created_at?: string };

const blank = (): Advance => ({
  category: '押金', counterparty: '', usage: '', amount: 0,
  paid_on: '', refunded_on: null, refunded_amount: null, note: '',
});

/* ══════════════════════════════════════════════════════════
 * 資料 —— 卡片與清單共用同一份
 * ══════════════════════════════════════════════════════════ */

export type AdvanceState = ReturnType<typeof useAdvance>;

/**
 * @param enabled 只有在暫付分頁時才去查。
 *
 * ★ 不加這個旗標的話，每次打開暫收付管理都會多一次查詢 ——
 *   而使用者九成的時間待在暫收那三頁。
 */
export function useAdvance(enabled: boolean) {
  const supabase = useMemo(() => createClient(), []);
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);
  const [statusF, setStatusF] = useState<'all' | AdvanceStatus>('all');
  const [estateF, setEstateF] = useState('');
  const [edit, setEdit] = useState<Advance | null>(null);

  /*
   * 收款帳戶與會計科目的選單資料。
   *
   * ★ 在這支 hook 裡查，不從 deposits/page.tsx 傳進來 —— 那一頁的四個分頁
   *   只有暫付需要它們，往上提就變成每個分頁都要背著兩份用不到的資料。
   */
  const [payAccounts, setPayAccounts] = useState<{ code: string; name: string }[]>([]);
  const [accountCodes, setAccountCodes] = useState<{ code: string; name: string }[]>([]);

  const load = useCallback(async () => {
    if (!enabled) return;
    setLoading(true);
    const { data, error } = await supabase.from('advance_payments')
      .select('*').order('paid_on', { ascending: false, nullsFirst: true });
    if (error) setMsg('讀取失敗：' + error.message);
    setRows((data ?? []) as Row[]);
    setLoading(false);
  }, [supabase, enabled]);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!enabled) return;
    /*
     * ★ 表名是 `payment_accounts` 不是 `pay_accounts`（purchases/page.tsx:355）。
     *   寫錯的話 PostgREST 回 404、這裡沒有檢查 error，
     *   結果是下拉**靜靜地空著** —— 而使用者只會覺得「怎麼沒有帳戶可選」。
     */
    supabase.from('payment_accounts').select('code, name').order('code')
      .then(({ data, error }) => {
        if (error) setMsg('讀不到收款帳戶：' + error.message);
        setPayAccounts((data ?? []) as { code: string; name: string }[]);
      });
    /*
     * ★ 只要能記支出的科目。`kind` 是 income 的（房租收入那些）出現在
     *   「被扣的差額」下拉裡沒有意義 —— 而選下去會產生一筆科目是收入的支出，
     *   那在報表上是查不出來的（migration_90 定義了這個 kind）。
     */
    supabase.from('account_codes').select('code, name, kind, active').order('sort')
      .then(({ data, error }) => {
        if (error) setMsg('讀不到會計科目：' + error.message);
        setAccountCodes(((data ?? []) as any[])
          .filter((c) => c.active !== false && c.kind !== 'income')
          .map((c) => ({ code: c.code, name: c.name })));
      });
  }, [supabase, enabled]);

  const shown = useMemo(() => rows.filter((r) => {
    if (estateF && r.estate_id !== estateF) return false;
    if (statusF !== 'all' && statusOf(r) !== statusF) return false;
    return true;
  }), [rows, statusF, estateF]);

  /*
   * ★ 統計算在**篩選前**的全部資料上（`rows` 不是 `shown`）——
   *   卡片是總覽，不是當前清單的重複。切到「已退款」之後
   *   「錢還在外面」那個數字還在，才看得出比例。
   *   跟暫收那邊同一條規則（那裡的註解寫著「筆數算在 base 上」）。
   */
  const st = useMemo(() => statsOf(rows), [rows]);

  return {
    supabase, rows, shown, st, loading, msg, setMsg,
    statusF, setStatusF, estateF, setEstateF, edit, setEdit, load,
    payAccounts, accountCodes,
  };
}

/* ══════════════════════════════════════════════════════════
 * 上半：總計 ＋ 統計卡（放在分頁籤**之前**）
 * ══════════════════════════════════════════════════════════ */

export function AdvanceStats({ a }: { a: AdvanceState }) {
  const { st, statusF, setStatusF } = a;
  return (
    <div>
      {/*
        ★ 總計回答的是「我們現在有多少錢在別人那裡」——
          跟暫收那句「錢在我們手上」正好相反，所以標籤要講清楚方向。
          只寫「暫付總計」會被讀成「所有暫付加起來」，而它不含已收回的。
      */}
      <StatTotal
        label="暫付款總計"
        value={`NT$ ${fmt(st.paid.amt)}`}
        sub={`${st.paid.n} 筆・錢在別人手上`} />

      <StatGroup label="暫付" tone="slate" />
      <StatRow className="mb-4">
        {([
          { k: 'paid'      as const, title: '已付款', s: st.paid,      sub: '還沒收回' },
          { k: 'refunded'  as const, title: '已退款', s: st.refunded,  sub: '實際收回' },
          { k: 'forfeited' as const, title: '被扣',   s: st.forfeited, sub: '已轉支出' },
        ]).map((t) => (
          <StatCard key={t.k}
            label={t.title}
            value={`NT$ ${fmt(t.s.amt)}`}
            sub={`${t.s.n} 筆・${t.sub}`}
            muted={t.s.n === 0}
            /*
             * ★ 「被扣」點下去篩「部分退」—— 那兩者是同一群列。
             *   分開命名是因為卡片問的是「損失多少」，
             *   而狀態問的是「這一列走到哪了」。
             */
            active={statusF === (t.k === 'forfeited' ? 'partial' : t.k)}
            onClick={() => setStatusF(t.k === 'forfeited' ? 'partial' : t.k)} />
        ))}
      </StatRow>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════
 * 下半：篩選 ＋ 清單 ＋ 新增／編輯（放在分頁籤**之後**）
 * ══════════════════════════════════════════════════════════ */

export function AdvanceList({
  a, estates,
}: {
  a: AdvanceState;
  estates: { id: string; name: string }[];
}) {
  const {
    supabase, rows, shown, loading, msg, setMsg,
    statusF, setStatusF, estateF, setEstateF, edit, setEdit, load,
    payAccounts, accountCodes,
  } = a;

  const estateName = useMemo(
    () => Object.fromEntries(estates.map((e) => [e.id, e.name])), [estates]);

  async function saveInner() {
    if (!edit) return;
    const err = validateAdvance(edit);
    if (err) { setMsg(err); return; }

    const payload = {
      category: edit.category,
      counterparty: edit.counterparty.trim(),
      usage: edit.usage.trim(),
      /*
       * ★★ 用途是**兩個欄位**（purpose_type ＋ estate_id），一定要一起寫。
       *   分開設會出現 office 卻掛著物業的矛盾列（`ap_purpose_chk` 會擋，
       *   但擋下來的錯誤訊息使用者看不懂）。算式在 lib，有測試。
       */
      ...purposeFromSelect(purposeToSelect(edit.purpose_type, edit.estate_id)),
      amount: Number(edit.amount),
      /*
       * ★ 空字串要轉成 null。日期欄留空時 input 給的是 ''，
       *   而 `''` 寫進 date 欄位會被 PostgREST 當成錯誤 ——
       *   症狀是「按了儲存沒反應」，因為錯誤訊息在 console 裡。
       */
      paid_on: edit.paid_on || null,
      refunded_on: edit.refunded_on || null,
      refunded_amount: edit.refunded_on ? Number(edit.refunded_amount ?? 0) : null,
      /*
       * ★ 收款帳戶只在真的收回時才寫。沒收回卻留著帳戶的話，
       *   `refundAccountWarning` 會拿它跟出款帳戶比而跳出提醒 ——
       *   而那時根本還沒有人決定要收到哪裡。
       */
      refund_account: edit.refunded_on ? (edit.refund_account || null) : null,
      note: edit.note?.trim() || null,
    };

    const q = edit.id
      ? supabase.from('advance_payments').update(payload).eq('id', edit.id).select('id')
      : supabase.from('advance_payments').insert(payload).select('id');
    const { data, error } = await q;
    if (error) { setMsg('存不進去：' + error.message); return; }
    /*
     * ★★ RLS 擋下的 UPDATE 會**回成功而且影響 0 列**（CLAUDE.md 的坑）。
     *   不檢查長度的話，沒有權限的人按儲存會看到「已儲存」而什麼都沒變。
     */
    if (!data || data.length === 0) {
      setMsg('沒有寫入任何資料 —— 可能是權限不足（暫付限會計以上）');
      return;
    }
    setEdit(null);
    setMsg('已儲存');
    await load();
  }
  const [save, saveBusy] = useOnce(saveInner);

  async function delOne(r: Row) {
    if (!confirm(`刪除「${r.counterparty}・${r.usage}」的 ${fmt(r.amount)}？`)) return;
    const { data, error } = await supabase.from('advance_payments')
      .delete().eq('id', r.id).select('id');
    if (error) { setMsg('刪不掉：' + error.message); return; }
    if (!data || data.length === 0) { setMsg('沒有刪掉任何資料 —— 可能是權限不足'); return; }
    await load();
  }

  return (
    <div>
      {msg && (
        <div className="mb-3 rounded-lg border border-mor-line bg-white px-3 py-2 text-sm flex items-center justify-between gap-3">
          <span>{msg}</span>
          <button onClick={() => setMsg(null)} className="text-xs text-gray-400 underline">關閉</button>
        </div>
      )}

      <div className="filter-bar rounded-xl glass p-4 mb-4 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">物業</span>
          <select value={estateF} onChange={(e) => setEstateF(e.target.value)} className={CTRL}>
            <option value="">全部</option>
            {estates.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select></label>
        <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">狀態</span>
          <select value={statusF} onChange={(e) => setStatusF(e.target.value as typeof statusF)} className={CTRL}>
            <option value="all">全部</option>
            {(['draft', 'paid', 'refunded', 'partial'] as const).map((s) => (
              <option key={s} value={s}>{STATUS_LABEL[s]}</option>
            ))}
          </select></label>
        <div className="ml-auto">
          <button onClick={() => setEdit(blank())}
            className="h-11 md:h-9 rounded-lg bg-mor-slate text-white px-4 text-ui font-medium hover:bg-mor-slatedark">
            + 新增暫付
          </button>
        </div>
      </div>

      <div className="rounded-xl glass overflow-x-auto mb-4">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-mor-line bg-white/45 text-left">
              {/*
                ══════════ 欄序跟支出頁一致（2026-09-03 使用者指定）══════════

                支出頁是「支出日 → 項目 → 金額 → 會計科目 → 用途」，
                這裡是「出款日 → 項目 → 金額 → 類別 → 用途」——
                前五欄同一個閱讀順序。

                ★ 改版前是「對象」開頭，兩張表切過去要重新找一次欄位。
                ★★ 「對象」往後移，不是拿掉 —— 它是暫付才有的
                  （錢放在誰那裡），支出頁沒有對應欄。
              */}
              <th className="px-3 py-2.5">出款日</th>
              <th className="px-3 py-2.5">項目</th>
              <th className="px-3 py-2.5 text-right">金額</th>
              <th className="px-3 py-2.5">類別</th>
              <th className="px-3 py-2.5">用途</th>
              <th className="px-3 py-2.5">對象</th>
              <th className="px-3 py-2.5">收回日</th>
              <th className="px-3 py-2.5 text-right">實收回</th>
              <th className="px-3 py-2.5">狀態</th>
              <th className="px-3 py-2.5 text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={10} className="px-3 py-6 text-center text-gray-400">讀取中⋯</td></tr>
            )}
            {!loading && shown.length === 0 && (
              <tr><td colSpan={10} className="px-3 py-6 text-center text-gray-400">
                {rows.length === 0
                  ? '還沒有暫付。請款單填完在下方勾「這是暫支款」，確認出款後會出現在這裡。'
                  : '這個篩選沒有資料'}
              </td></tr>
            )}
            {!loading && shown.map((r) => {
              const s = statusOf(r);
              const lost = forfeitedOf(r);
              return (
                <tr key={r.id} className="border-b border-mor-line/40 last:border-0">
                  <td className="px-3 py-2.5 text-gray-500 whitespace-nowrap">{r.paid_on ?? '—'}</td>
                  {/* ★ 物業不再擠在項目後面當灰字 —— 它有自己的「用途」欄了 */}
                  <td className="px-3 py-2.5">{r.usage}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{fmt(r.amount)}</td>
                  <td className="px-3 py-2.5">
                    <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${CAT_CLASS[r.category] ?? ''}`}>
                      {r.category}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-gray-600 whitespace-nowrap">
                    {purposeLabel(r.purpose_type, r.estate_id, (id) => estateName[id])}
                  </td>
                  <td className="px-3 py-2.5">{r.counterparty}</td>
                  <td className="px-3 py-2.5 text-gray-500">{r.refunded_on ?? '—'}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">
                    {r.refunded_amount == null ? '—' : fmt(r.refunded_amount)}
                    {/* ★ 被扣的金額寫在旁邊 —— 那是這一列唯一真的損失 */}
                    {lost > 0 && <div className="text-xs text-red-500">被扣 {fmt(lost)}</div>}
                  </td>
                  <td className="px-3 py-2.5">
                    <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${STATUS_CLASS[s]}`}>
                      {STATUS_LABEL[s]}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-right whitespace-nowrap">
                    <button onClick={() => setEdit(r)} className="text-xs text-mor-blue underline">改</button>
                    <button onClick={() => delOne(r)} className="ml-2 text-xs text-red-500 underline">刪</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {edit && (
        <div className="fixed inset-0 z-40 bg-black/30 flex items-end md:items-center justify-center p-0 md:p-4"
          onClick={() => setEdit(null)}>
          <div className="bg-white rounded-t-2xl md:rounded-2xl w-full md:max-w-lg max-h-[90vh] overflow-y-auto p-4"
            onClick={(e) => e.stopPropagation()}>
            <div className="text-ui font-medium mb-3">{edit.id ? '編輯暫付' : '新增暫付'}</div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {/*
                ══════════ 項目排第一（2026-09-03 使用者指定）══════════

                ★ 這是「這筆錢在做什麼」—— 填表的人腦中第一個念頭，
                  而且是之後**唯一認得出這筆是什麼**的欄位。
                  類別（押金/保證金/零用金）是分類，分類要先有東西才分得了。

                ★★ 跟支出頁一致:那邊也是「項目」在最上面。
              */}
              <label className="flex flex-col gap-1 sm:col-span-2"><Req>項目</Req>
                <input value={edit.usage} autoFocus
                  onChange={(e) => setEdit({ ...edit, usage: e.target.value })}
                  placeholder="辦公室租賃／零用金撥補／114 年清潔標案" className={CTRL} /></label>

              <label className="flex flex-col gap-1"><Req>類別</Req>
                <select value={edit.category}
                  onChange={(e) => setEdit({ ...edit, category: e.target.value as Advance['category'] })}
                  className={CTRL}>
                  {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                </select></label>

              <label className="flex flex-col gap-1"><Req>對象（錢付給誰）</Req>
                <input value={edit.counterparty}
                  onChange={(e) => setEdit({ ...edit, counterparty: e.target.value })}
                  placeholder="王大明／台北市政府" className={CTRL} /></label>

              {/*
                用途（migration_212）。★ 安幸辦公室**不是物業** ——
                `estates` 裡沒有它，所以用 purpose_type 分辨，跟支出頁同一套。
              */}
              <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">用途（選填）</span>
                <select value={purposeToSelect(edit.purpose_type, edit.estate_id)}
                  onChange={(e) => setEdit({ ...edit, ...purposeFromSelect(e.target.value) })}
                  className={CTRL}>
                  <option value="">—</option>
                  <option value={PURPOSE_OFFICE}>{OFFICE_LABEL}</option>
                  {estates.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                </select></label>

              <label className="flex flex-col gap-1"><Req>暫付款</Req>
                <MoneyInput value={edit.amount} onChange={(n) => setEdit({ ...edit, amount: n })}
                  className={`${CTRL} text-right`} /></label>

              <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">出款日</span>
                <input type="date" value={edit.paid_on ?? ''}
                  onChange={(e) => setEdit({ ...edit, paid_on: e.target.value })}
                  className={CTRL} /></label>

              <div className="sm:col-span-2 border-t border-mor-line pt-3 mt-1">
                <div className="text-xs text-gray-500 mb-2">收回（還沒收回就留空）</div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">收回日</span>
                    <input type="date" value={edit.refunded_on ?? ''}
                      onChange={(e) => setEdit({
                        ...edit,
                        refunded_on: e.target.value || null,
                        /*
                         * ★★ 一填收回日就把**原出款帳戶**帶進來
                         *   （2026-09-02 使用者:「暫支要回到原支出帳戶」）。
                         *   已經選過的不覆蓋 —— 使用者改成別的之後，
                         *   改一次日期就被打回去是最惱人的那種 bug。
                         */
                        refund_account: edit.refund_account
                          || (e.target.value ? defaultRefundAccount(edit) : null),
                      })}
                      className={CTRL} /></label>
                  <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">實際收回</span>
                    <MoneyInput value={Number(edit.refunded_amount ?? 0)}
                      onChange={(n) => setEdit({ ...edit, refunded_amount: n })}
                      disabled={!edit.refunded_on}
                      className={`${CTRL} text-right ${edit.refunded_on ? '' : 'bg-gray-100 text-gray-400'}`} /></label>
                </div>
                {/*
                  ★★ 這一句要在**填的當下**看得到，不是存檔被擋才說。
                    全額被扣填 0 是合法的，而沒有這句話的人會以為要留空 ——
                    留空的話那筆押金會永遠躺在「錢還在外面」的清單裡。
                */}
                {/*
                  收款帳戶。★★ 預設是**原出款帳戶**（2026-09-02 使用者指定）。
                    可以改，但改了會在底下講一句 —— 錢確實有可能回到別的帳戶
                    （換帳戶、對方匯錯），硬鎖住的話那筆錢就記不進系統。
                    系統負責看見，人負責決定。
                */}
                {edit.refunded_on && (
                  <label className="flex flex-col gap-1 mt-3">
                    <span className="text-xs text-gray-500">收款帳戶</span>
                    <select value={edit.refund_account ?? ''}
                      onChange={(e) => setEdit({ ...edit, refund_account: e.target.value || null })}
                      className={CTRL}>
                      <option value="">（未選）</option>
                      {payAccounts.map((p) => (
                        <option key={p.code} value={p.code}>{p.code} {p.name}</option>
                      ))}
                    </select>
                    {refundAccountWarning(edit) && (
                      <span className="text-xs text-amber-700">{refundAccountWarning(edit)}</span>
                    )}
                  </label>
                )}
                <div className="text-xs text-gray-400 mt-2 leading-relaxed">
                  全額被扣就填 <b>0</b>，不要留空 —— 留空代表「還沒收回」，那一筆會一直等一個不會來的退款。
                  {Number(edit.refunded_amount ?? 0) < Number(edit.amount) && edit.refunded_on && (
                    <div className="text-red-500 mt-1">
                      差額 {fmt(Number(edit.amount) - Number(edit.refunded_amount ?? 0))} 會轉成一筆支出。
                    </div>
                  )}
                </div>
                {/*
                  ★★★ 被扣的差額要選會計科目（2026-09-02 使用者:「可選會計科目」）。

                    不強制的話那筆支出會落進空科目 —— 而三個月後看到一筆
                    2,000 的支出，沒有人查得出它是哪一筆押金被扣的。
                    `validateRefund` 也擋，這裡只是先讓他看到要填什麼。

                  ★ 只在**這一次要產生**時出現。已經產生過的（forfeit_expense_id
                    有值）不再問 —— 那筆支出早就存在，科目在它自己身上。
                */}
                {needsForfeitExpense(edit) && (
                  <div className="mt-3 rounded-lg bg-amber-50 border border-amber-200 p-3">
                    <div className="text-sm text-amber-900">
                      沒收回的 <b>{fmt(forfeitedOf(edit))}</b> 要記成一筆支出
                    </div>
                    <label className="flex flex-col gap-1 mt-2">
                      <span className="text-xs text-amber-800">會計科目</span>
                      <select value={edit.forfeit_account_code ?? ''}
                        onChange={(e) => setEdit({ ...edit, forfeit_account_code: e.target.value || null })}
                        className={CTRL}>
                        <option value="">（請選）</option>
                        {accountCodes.map((c) => (
                          <option key={c.code} value={c.code}>{c.code} {c.name}</option>
                        ))}
                      </select>
                    </label>
                    <div className="text-xs text-amber-800 mt-2">
                      科目沒選就不給存 —— 落在空科目的錢三個月後沒有人查得出是什麼
                    </div>
                  </div>
                )}
              </div>

              <label className="flex flex-col gap-1 sm:col-span-2"><span className="text-xs text-gray-500">備註</span>
                <input value={edit.note ?? ''}
                  onChange={(e) => setEdit({ ...edit, note: e.target.value })} className={CTRL} /></label>
            </div>

            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => setEdit(null)}
                className="rounded-lg border border-gray-300 px-4 py-1.5 text-sm">取消</button>
              <button onClick={save} disabled={saveBusy}
                className="rounded-lg bg-mor-slate text-white px-4 py-1.5 text-sm font-medium hover:bg-mor-slatedark disabled:opacity-50">
                {saveBusy ? '儲存中⋯' : '儲存'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
