'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import MoneyInput from '@/components/MoneyInput';
import { createClient } from '@/lib/supabase';
import {
  checkDeferral, linesTotal, parentAmount, childLines,
  deferralLabel, type DeferralLine,
} from '@/lib/deferral';

/**
 * 支出的遞延認列設定。
 *
 * 【一句話】
 * 8/8 付了 10,000，但要分 9/8、10/8 各認列 5,000 —— 這裡就是填那兩筆的地方。
 *
 * 【存下去之後長什麼樣】
 *     母單 8/8   amount 0        gross_amount 10,000   deferred
 *     子單 9/8   amount 5,000    parent_expense_id → 母單
 *     子單 10/8  amount 5,000    parent_expense_id → 母單
 *
 * 母單的 amount 變成「這一天認列多少」而不是「付了多少」——
 * 因為系統沒有支出認列表，報表直接 sum(amount)，
 * 母單留著全額的話那筆錢會被算兩次（見 migration_88 的檔頭）。
 *
 * 【為什麼合計一定要剛好等於實付總額】
 * 使用者定的規則。差一塊都不給存 —— 不擋的話母單金額會變成負數，
 * 或多出一筆對不到的錢混進某個月的費用裡，而報表只看 sum(amount)，
 * 不會有任何跡象。資料庫那邊也有一道觸發器守同一條等式。
 */

type Expense = {
  id: string; spent_on: string; amount: number;
  gross_amount?: number | null; deferred?: boolean;
  item_name: string | null;
};

const fmt = (n: number) => Math.round(Number(n) || 0).toLocaleString('en-US');
const CTRL = 'h-11 md:h-9 bg-white rounded-lg border border-mor-line px-2 text-sm';

export default function DeferralPanel({
  expense, canEdit, onChanged,
}: {
  expense: Expense;
  canEdit: boolean;
  onChanged: () => void;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [on, setOn] = useState(!!expense.deferred);
  const [lines, setLines] = useState<DeferralLine[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [loaded, setLoaded] = useState(false);

  /** 實付總額。已經遞延的看 gross_amount,還沒遞延的就是目前的金額。 */
  const gross = Math.round(Number(expense.deferred ? expense.gross_amount : expense.amount) || 0);
  const paidOn = expense.spent_on;

  function flash(t: string) { setMsg(t); setTimeout(() => setMsg(''), 5000); }

  const load = useCallback(async () => {
    if (!expense.deferred) {
      // 還沒遞延:預設給一列,日期就是出款日,金額是全額 —— 使用者只要改日期就好
      setLines([{ on: paidOn, amount: gross }]);
      setLoaded(true);
      return;
    }
    const { data } = await supabase.from('expenses')
      .select('spent_on, amount').eq('parent_expense_id', expense.id).order('spent_on');
    const kids = ((data ?? []) as { spent_on: string; amount: number }[])
      .map((k) => ({ on: k.spent_on, amount: Math.round(Number(k.amount) || 0) }));
    // 母單自己那一期也是明細的一部分,不然畫面上會少一筆、合計對不起來
    const own = Math.round(Number(expense.amount) || 0);
    setLines(own > 0 ? [{ on: paidOn, amount: own }, ...kids] : kids);
    setLoaded(true);
  }, [supabase, expense.id, expense.deferred, expense.amount, paidOn, gross]);
  useEffect(() => { load(); }, [load]);

  const total = linesTotal(lines);
  const diff = gross - total;
  const upd = (i: number, p: Partial<DeferralLine>) =>
    setLines(lines.map((l, idx) => (idx === i ? { ...l, ...p } : l)));

  /**
   * 存檔：先把舊子單全刪，再照新明細重建。
   *
   * 【為什麼是全刪重建，不是逐筆比對】
   * 逐筆比對要處理「改日期」「改金額」「刪一筆再加一筆」三種路徑，
   * 而資料庫那條等式在中途一定會短暫不成立。
   * 全刪重建只有一條路徑，而且觸發器是 deferrable —— 交易結束才驗，
   * 中間怎麼進出都沒關係。
   */
  async function save() {
    const chk = checkDeferral(gross, paidOn, lines);
    if (!chk.ok) return flash(chk.error);

    /*
     * 存檔前把整份算式攤開來讓人核對一次。
     *
     * 畫面上的差額已經是 0 了,但那只證明「數字加得起來」,
     * 不證明「日期填對了」—— 把每一期逐行列出來,
     * 打錯月份的那種錯只有在這裡看得出來。
     */
    const own = parentAmount(gross, paidOn, lines);
    const kids = childLines(paidOn, lines);
    const detail = [...lines]
      .sort((a, b) => (a.on < b.on ? -1 : 1))
      .map((l) => `　${l.on}　$${fmt(l.amount)}${l.on === paidOn ? '（併入本筆）' : ''}`)
      .join('\n');
    if (!confirm(
      `確認遞延認列\n\n`
      + `實付總額　$${fmt(gross)}（${paidOn} 付款）\n\n`
      + `認列明細\n${detail}\n\n`
      + `合計　　　$${fmt(linesTotal(lines))}　＝　實付總額 ✓\n\n`
      + `存檔後：本筆認列 $${fmt(own)}、另開 ${kids.length} 張子單。`
      + (chk.warn ? `\n\n⚠ ${chk.warn}` : '')
    )) return;

    setBusy(true);
    // 先刪舊子單。母單此刻的 amount 還是舊值,等式暫時不成立 ——
    // 沒關係,觸發器延到交易結束才驗。
    // 硬刪除,不進回收桶 —— 子單是母單金額拆出來的,每改一次遞延就整組重算。
    const del = await supabase.from('expenses').delete().eq('parent_expense_id', expense.id);
    if (del.error) { setBusy(false); return flash('清除舊明細失敗:' + del.error.message); }

    const up = await supabase.from('expenses')
      .update({ deferred: true, gross_amount: gross, amount: own }).eq('id', expense.id);
    if (up.error) { setBusy(false); return flash('儲存失敗:' + up.error.message); }

    if (kids.length) {
      // 其餘欄位由 migration_88 的觸發器從母單繼承,前端不用一個一個複製 ——
      // 複製的話總有一天會漏掉新加的欄位,而漏掉不會報錯,只會歸錯類。
      const ins = await supabase.from('expenses').insert(
        kids.map((k) => ({ parent_expense_id: expense.id, spent_on: k.on, amount: k.amount })));
      if (ins.error) { setBusy(false); return flash('建立明細失敗:' + ins.error.message); }
    }
    setBusy(false);
    flash('已設定遞延認列');
    onChanged();
  }

  /** 取消遞延：子單全刪，母單金額還原成實付總額。 */
  async function cancel() {
    if (!confirm(
      `取消遞延認列?\n\n所有子單會被刪除,這筆 $${fmt(gross)} 會全部認列在 ${paidOn}。`
    )) return;
    setBusy(true);
    // 硬刪除,不進回收桶 —— 取消遞延就是把拆分收回母單,子單不該能單獨復原
    // （復原一張子單會讓母子金額對不上,觸發器會擋,但那時人已經一頭霧水）。
    await supabase.from('expenses').delete().eq('parent_expense_id', expense.id);
    const { error } = await supabase.from('expenses')
      .update({ deferred: false, gross_amount: null, amount: gross }).eq('id', expense.id);
    setBusy(false);
    if (error) return flash('取消失敗:' + error.message);
    setOn(false);
    flash('已取消遞延認列');
    onChanged();
  }

  if (!loaded) return null;

  return (
    <div className="rounded-lg border border-mor-line p-3">
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={on} disabled={!canEdit || busy}
          onChange={(e) => {
            setOn(e.target.checked);
            if (!e.target.checked && expense.deferred) cancel();
            if (e.target.checked && !lines.length) setLines([{ on: paidOn, amount: gross }]);
          }} />
        遞延認列
        <span className="text-xs text-gray-400">把這筆費用分到多個月份認列</span>
      </label>

      {on && (
        <div className="mt-3 space-y-2">
          <div className="text-xs text-gray-500">
            實付總額 <b className="text-mor-slate">${fmt(gross)}</b>
            <span className="ml-2">出款日 {paidOn}</span>
          </div>

          {lines.map((l, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <input type="date" value={l.on} disabled={!canEdit}
                onChange={(e) => upd(i, { on: e.target.value })} className={`${CTRL} flex-1 min-w-[9rem]`} />
              <MoneyInput value={l.amount || 0} placeholder="0" disabled={!canEdit}
                onChange={(n) => upd(i, { amount: n })}
                className={`${CTRL} w-28 text-right`} />
              {l.on === paidOn && <span className="text-[11px] text-gray-400">併入本筆</span>}
              {canEdit && lines.length > 1 && (
                <button type="button" onClick={() => setLines(lines.filter((_, x) => x !== i))}
                  className="text-xs text-red-400 hover:text-red-600">✕</button>
              )}
            </div>
          ))}

          {canEdit && (
            /* 新增的那一列預填「還差多少」—— 最常見的情況是最後一筆補到剛好 */
            <button type="button" onClick={() => setLines([...lines, { on: '', amount: Math.max(0, diff) }])}
              className="text-xs text-mor-blue underline">+ 新增一期</button>
          )}

          {/*
            對帳區。三個數字一定要並排看得到 ——
            只顯示「還差多少」的話,使用者不知道是自己填多了還是實付總額記錯了。
          */}
          <div className={`rounded-lg px-3 py-2 text-xs ${diff === 0 ? 'bg-mor-greenlight' : 'bg-amber-50'}`}>
            <div className="grid grid-cols-3 gap-2 text-center">
              <div>
                <div className="text-gray-500">實付總額</div>
                <div className="font-bold text-sm">${fmt(gross)}</div>
              </div>
              <div>
                <div className="text-gray-500">明細合計</div>
                <div className="font-bold text-sm">${fmt(total)}</div>
              </div>
              <div>
                <div className={diff === 0 ? 'text-mor-green' : 'text-amber-700'}>差額</div>
                <div className={`font-bold text-sm ${diff === 0 ? 'text-mor-green' : 'text-amber-700'}`}>
                  {diff === 0 ? '0' : (diff > 0 ? `差 ${fmt(diff)}` : `多 ${fmt(-diff)}`)}
                </div>
              </div>
            </div>
            <div className={`mt-1.5 pt-1.5 border-t text-center ${diff === 0 ? 'border-mor-green/20 text-mor-green' : 'border-amber-200 text-amber-800'}`}>
              {diff === 0
                ? <>{deferralLabel(gross, parentAmount(gross, paidOn, lines))}・另開 {childLines(paidOn, lines).length} 張子單</>
                : <>差額必須是 0 才能存檔</>}
            </div>
          </div>

          {msg && <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800">{msg}</div>}

          {/*
            差額不是 0 就按不下去。三道防線刻意疊在一起:
              1. 按鈕 disabled          —— 最直接,使用者不會白按
              2. checkDeferral()        —— 擋掉繞過按鈕的路徑（鍵盤送出、舊畫面）
              3. migration_88 的觸發器  —— 擋掉繞過前端的路徑（API、匯入、下一個工程師）
            少任何一道,母子金額對不上都會靜靜地混進某個月的費用裡。
          */}
          {canEdit && (
            <>
              <button type="button" onClick={save} disabled={busy || diff !== 0}
                className="w-full h-11 md:h-9 rounded-lg bg-mor-slate text-white text-sm font-medium disabled:opacity-40">
                {busy ? '處理中…' : expense.deferred ? '更新遞延明細' : '設定遞延認列'}
              </button>
              {diff !== 0 && (
                <div className="text-[11px] text-amber-700 text-center">
                  明細合計要剛好等於實付總額才能儲存
                  {diff > 0 ? `（還差 $${fmt(diff)}）` : `（多了 $${fmt(-diff)}）`}
                </div>
              )}
            </>
          )}
          <div className="text-[11px] text-gray-400 leading-relaxed">
            子單會繼承這筆的科目、用途、物業、憑證等欄位。要修改一律回到這張母單 ——
            子單在列表上不能單獨編輯或刪除。
          </div>
        </div>
      )}
    </div>
  );
}
