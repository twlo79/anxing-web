'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase';
import { FEE_TYPES } from '@/lib/fee-types';
import { ymShow } from '@/lib/period';

/**
 * 定期收費。
 *
 * 【這一頁在解決什麼】
 * 洗衣機、烘衣機、垃圾代收費這類收入每個月都會發生,但以前只能一筆一筆開
 * 「一次性收入」。三筆的會計科目都是清潔費,營收報表按科目分組就併成一格,
 * 看不出組成;而且漏掉某個月沒有任何跡象。
 *
 * 設定一次,每個月自動長出一列(source='oneoff'、imported_via='recurring')。
 * 產生出來的就是一般訂單,營收報表與 Excel 都照舊吃得到。
 *
 * 【金額為什麼是可以改的】
 * 垃圾代收費每月固定 5,070,設一次就不用管。
 * 洗衣機是 2,150 / 2,050 / 2,600…,要當月結束才知道。
 * 所以產生時帶預設金額,之後在下面的月份表格逐月改。
 *
 * 這個機制保證的是「不會漏掉哪個月」,不是「金額不用填」。
 *
 * 【只產到本月】
 * 未來月份不先產生 —— 先產的話 12 月的垃圾費現在就會計入年度營收,
 * 而那筆錢還沒發生。營收看的是已發生的認列,不是預估。
 */

type Rc = {
  id: string;
  estate_id: string; property_id: string | null; property_raw: string | null;
  fee_type: string; item_name: string; amount: number;
  start_ym: string; end_ym: string | null; active: boolean; note: string | null;
};
type Ord = {
  id: string; order_key: string; checkin: string; amount: number; paid: boolean;
};
type Estate = { id: string; name: string };
type Property = { id: string; name: string; estate_id: string | null };

const fmt = (n: number | null | undefined) => (n == null ? '0' : Math.round(Number(n)).toLocaleString('en-US'));
const thisYm = () => {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
};
/** 'RC_<uuid>_202601' → '202601' */
const ymOfKey = (k: string) => k.slice(-6);

export default function RecurringPage() {
  const supabase = useMemo(() => createClient(), []);
  const [rows, setRows] = useState<Rc[]>([]);
  const [estates, setEstates] = useState<Estate[]>([]);
  const [properties, setProperties] = useState<Property[]>([]);
  const [orders, setOrders] = useState<Record<string, Ord[]>>({});   // rc.id → 該設定產生的訂單
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');
  const [edit, setEdit] = useState<Rc | null>(null);
  const [open, setOpen] = useState<string | null>(null);             // 展開哪一筆的月份表
  const [busy, setBusy] = useState('');
  const [role, setRole] = useState('');

  function flash(t: string) { setMsg(t); setTimeout(() => setMsg(''), 3000); }
  const canEdit = ['accountant', 'manager', 'super_admin'].includes(role);

  const load = useCallback(async () => {
    setLoading(true);
    const [rc, es, pr, prof] = await Promise.all([
      supabase.from('recurring_charges').select('*').order('item_name'),
      supabase.from('estates').select('id, name').eq('active', true).order('sort').order('name'),
      supabase.from('properties').select('id, name, estate_id').order('name'),
      supabase.auth.getUser().then(({ data: { user } }) =>
        user ? supabase.from('profiles').select('role').eq('id', user.id).single() : null),
    ]);
    const list = (rc.data ?? []) as Rc[];
    setRows(list);
    setEstates((es.data ?? []) as Estate[]);
    setProperties((pr.data ?? []) as Property[]);
    setRole((prof as any)?.data?.role ?? '');

    // 每筆設定產生的訂單。用 order_key 的前綴撈 —— 那是它們唯一的關聯。
    if (list.length) {
      const { data: od } = await supabase.from('orders')
        .select('id, order_key, checkin, amount, paid')
        .eq('imported_via', 'recurring')
        .order('checkin');
      const m: Record<string, Ord[]> = {};
      for (const o of (od ?? []) as Ord[]) {
        const rid = o.order_key.slice(3, 39);   // RC_ + uuid(36)
        (m[rid] ??= []).push(o);
      }
      setOrders(m);
    } else setOrders({});
    setLoading(false);
  }, [supabase]);
  useEffect(() => { load(); }, [load]);

  const estateName = useMemo(() => Object.fromEntries(estates.map((e) => [e.id, e.name])), [estates]);
  /** 用過的項目名稱,給 datalist 提示。防止「洗衣機」跟「洗衣機費」變成報表上兩列。 */
  const usedItems = useMemo(
    () => Array.from(new Set(rows.map((r) => r.item_name).filter(Boolean))).sort(), [rows]);

  function blank(): Rc {
    return {
      id: '', estate_id: estates[0]?.id ?? '', property_id: null, property_raw: null,
      fee_type: '清潔費', item_name: '', amount: 0,
      start_ym: thisYm(), end_ym: null, active: true, note: null,
    };
  }

  async function save() {
    if (!edit) return;
    if (!edit.estate_id) return flash('請選物業');
    if (!edit.item_name.trim()) return flash('請填項目名稱');
    if (!/^\d{6}$/.test(edit.start_ym)) return flash('起始月份格式要是 YYYYMM');
    setBusy('save');
    const payload = {
      estate_id: edit.estate_id, property_id: edit.property_id, property_raw: edit.property_raw,
      fee_type: edit.fee_type, item_name: edit.item_name.trim(), amount: edit.amount || 0,
      start_ym: edit.start_ym, end_ym: edit.end_ym || null, active: edit.active, note: edit.note || null,
    };
    const { error } = edit.id
      ? await supabase.from('recurring_charges').update(payload).eq('id', edit.id)
      : await supabase.from('recurring_charges').insert(payload);
    setBusy('');
    if (error) return flash('儲存失敗:' + error.message);
    setEdit(null); flash('已儲存,月份已產生'); load();
  }

  async function del(r: Rc) {
    if (!confirm(
      `刪除定期收費「${r.item_name}」?\n\n`
      + `已經產生但還沒收款的月份會一併刪除。\n`
      + `已收款的月份會留著 —— 那是真的收過的錢,不該因為設定被刪就消失。`
    )) return;
    const { error } = await supabase.from('recurring_charges').delete().eq('id', r.id);
    if (error) return flash('刪除失敗:' + error.message);
    flash('已刪除'); load();
  }

  /** 補產到本月。冪等 —— 重複按只會補上缺的月份,已有的金額不會被蓋掉。 */
  async function rebuild() {
    setBusy('rebuild');
    const { data, error } = await supabase.rpc('rebuild_recurring_orders');
    setBusy('');
    if (error) return flash('產生失敗:' + error.message);
    flash(`已補到本月（涵蓋 ${data ?? 0} 個月份）`); load();
  }

  /** 改某個月的實際金額。這是這一頁最常做的事,所以直接在表格上改。 */
  async function setAmount(o: Ord, v: number) {
    setOrders((prev) => {
      const next: Record<string, Ord[]> = {};
      for (const [k, list] of Object.entries(prev)) next[k] = list.map((x) => x.id === o.id ? { ...x, amount: v } : x);
      return next;
    });
    const { error } = await supabase.from('orders').update({ amount: v }).eq('id', o.id);
    if (error) { flash('存不進去:' + error.message); load(); }
  }

  return (
    <div>
      {msg && <div className="mb-3 rounded-lg bg-mor-greenlight text-mor-green px-4 py-2 text-sm">{msg}</div>}
      <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
        <div>
          <h1 className="text-xl font-bold">定期收費</h1>
          <p className="text-xs text-gray-500 mt-1">
            每個月自動產生一筆一次性收入。金額可逐月調整 —— 固定的設一次就好,變動的至少不會漏掉哪個月。
          </p>
        </div>
        {canEdit && (
          <div className="flex gap-2">
            <button onClick={rebuild} disabled={!!busy}
              className="rounded-lg border border-mor-line bg-white px-4 py-1.5 text-sm font-medium hover:bg-mor-sand/60 disabled:opacity-40">
              {busy === 'rebuild' ? '產生中…' : '補產到本月'}
            </button>
            <button onClick={() => setEdit(blank())}
              className="rounded-lg bg-mor-slate text-white px-4 py-1.5 text-sm font-medium hover:bg-mor-slatedark">
              + 新增定期收費
            </button>
          </div>
        )}
      </div>

      {loading ? <div className="rounded-xl border border-mor-line bg-white py-16 text-center text-gray-400 text-sm">載入中…</div>
        : rows.length === 0 ? (
          <div className="rounded-xl border border-mor-line bg-white py-16 text-center">
            <div className="text-gray-400 text-sm">還沒有定期收費</div>
            <div className="text-gray-300 text-xs mt-1">洗衣機、烘衣機、垃圾代收費這類每月都會發生的收入適合放這裡</div>
          </div>
        ) : (
          <div className="space-y-3">
            {rows.map((r) => {
              const os = orders[r.id] ?? [];
              const total = os.reduce((a, o) => a + Number(o.amount || 0), 0);
              const zero = os.filter((o) => !Number(o.amount)).length;
              const isOpen = open === r.id;
              return (
                <div key={r.id} className={`rounded-xl border bg-white overflow-hidden ${r.active ? 'border-mor-line' : 'border-dashed border-gray-300 opacity-60'}`}>
                  <div className="px-4 py-3 flex flex-wrap items-center gap-x-4 gap-y-1 cursor-pointer hover:bg-mor-sand/30"
                    onClick={() => setOpen(isOpen ? null : r.id)}>
                    <div className="min-w-0 flex-1">
                      <div className="font-medium">
                        {r.item_name}
                        <span className="ml-2 rounded px-1.5 py-0.5 text-[11px] bg-mor-bluelight text-mor-slate">{r.fee_type}</span>
                        {!r.active && <span className="ml-2 text-xs text-gray-400">已停用</span>}
                      </div>
                      <div className="text-xs text-gray-500 mt-0.5">
                        {estateName[r.estate_id] ?? '—'}・{r.property_raw || '整棟'}
                        ・{ymShow(r.start_ym)} ~ {r.end_ym ? ymShow(r.end_ym) : '無限期'}
                        ・預設 ${fmt(r.amount)}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="font-bold">${fmt(total)}</div>
                      <div className="text-[11px] text-gray-400">
                        {os.length} 個月
                        {/* 金額還是 0 的月份要標出來 —— 那是「產生了但還沒填」,不是真的收 0 */}
                        {zero > 0 && <span className="text-amber-600 ml-1">・{zero} 個月未填金額</span>}
                      </div>
                    </div>
                    {canEdit && (
                      <div className="flex gap-2 shrink-0" onClick={(e) => e.stopPropagation()}>
                        <button onClick={() => setEdit({ ...r })} className="text-xs text-mor-slate underline">設定</button>
                        <button onClick={() => del(r)} className="text-xs text-red-500 underline">刪除</button>
                      </div>
                    )}
                  </div>

                  {isOpen && (
                    <div className="border-t border-mor-line px-4 py-3">
                      {os.length === 0 ? (
                        <div className="text-xs text-gray-400 py-4 text-center">還沒產生任何月份 —— 按上面的「補產到本月」</div>
                      ) : (
                        <div className="flex flex-wrap gap-2">
                          {os.map((o) => (
                            <div key={o.id} className={`rounded-lg border px-2 py-1.5 ${
                              o.paid ? 'border-mor-greenlight bg-mor-greenlight/30'
                                : Number(o.amount) ? 'border-mor-line' : 'border-amber-300 bg-amber-50/50'}`}>
                              <div className="text-[11px] text-gray-500">{ymShow(ymOfKey(o.order_key))}</div>
                              <input type="number" value={Number(o.amount) || ''} placeholder="0"
                                disabled={!canEdit || o.paid}
                                onChange={(e) => setAmount(o, parseFloat(e.target.value) || 0)}
                                className="w-24 rounded border border-gray-300 px-1.5 py-0.5 text-sm text-right disabled:bg-gray-100 disabled:text-gray-500" />
                            </div>
                          ))}
                        </div>
                      )}
                      <p className="text-[11px] text-gray-400 mt-2">
                        已收款的月份不能改金額 —— 錢收了之後金額是既成事實。要改請先到短租訂單頁取消收款。
                      </p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

      {/* 設定視窗 */}
      {edit && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={() => setEdit(null)}>
          <div className="absolute inset-0 bg-black/30" />
          <div onClick={(e) => e.stopPropagation()} className="relative bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[85vh] overflow-y-auto">
            <div className="sticky top-0 bg-white border-b border-mor-line px-6 py-4 font-bold flex items-center justify-between">
              {edit.id ? '編輯定期收費' : '新增定期收費'}
              <button onClick={() => setEdit(null)} className="text-gray-400 hover:text-gray-600 text-xl">✕</button>
            </div>
            <div className="px-6 py-4 grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
              <label className="flex flex-col gap-1">物業
                <select value={edit.estate_id}
                  onChange={(e) => setEdit({ ...edit, estate_id: e.target.value, property_id: null, property_raw: null })}
                  className="rounded-lg border border-gray-300 px-2 py-1.5">
                  {estates.map((es) => <option key={es.id} value={es.id}>{es.name}</option>)}
                </select></label>
              {/* 房源選填。留白 = 整棟 —— 垃圾代收、公區清潔本來就不屬於某一間房。 */}
              <label className="flex flex-col gap-1">房源<span className="text-xs text-gray-400 ml-1">(非必填)</span>
                <select value={edit.property_raw ?? ''}
                  onChange={(e) => {
                    const nm = e.target.value;
                    const pr = properties.find((x) => x.estate_id === edit.estate_id && x.name === nm);
                    setEdit({ ...edit, property_raw: nm || null, property_id: pr?.id ?? null });
                  }}
                  className="rounded-lg border border-gray-300 px-2 py-1.5">
                  <option value="">整棟(不指定房源)</option>
                  {properties.filter((x) => x.estate_id === edit.estate_id).map((x) => <option key={x.id} value={x.name}>{x.name}</option>)}
                </select></label>
              <label className="flex flex-col gap-1">會計科目
                <select value={edit.fee_type} onChange={(e) => setEdit({ ...edit, fee_type: e.target.value })}
                  className="rounded-lg border border-gray-300 px-2 py-1.5">
                  {FEE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select></label>
              {/* 自由輸入,但提示用過的 —— 「洗衣機」跟「洗衣機費」會變成報表上兩列 */}
              <label className="flex flex-col gap-1">項目
                <input list="rc-items" value={edit.item_name} placeholder="例:洗衣機"
                  onChange={(e) => setEdit({ ...edit, item_name: e.target.value })}
                  className="rounded-lg border border-gray-300 px-2 py-1.5" />
                <datalist id="rc-items">{usedItems.map((i) => <option key={i} value={i} />)}</datalist>
              </label>
              <label className="flex flex-col gap-1">預設金額
                <input type="number" value={edit.amount || ''} placeholder="0"
                  onChange={(e) => setEdit({ ...edit, amount: parseFloat(e.target.value) || 0 })}
                  className="rounded-lg border border-gray-300 px-2 py-1.5" />
                <span className="text-xs text-gray-400">每月產生時帶的金額,之後可以逐月改。變動的填 0 就好。</span>
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="flex flex-col gap-1">起始月
                  <input type="month" value={edit.start_ym ? `${edit.start_ym.slice(0, 4)}-${edit.start_ym.slice(4)}` : ''}
                    onChange={(e) => setEdit({ ...edit, start_ym: e.target.value.replace('-', '') })}
                    className="rounded-lg border border-gray-300 px-2 py-1.5" /></label>
                <label className="flex flex-col gap-1">結束月<span className="text-xs text-gray-400">(空=無限期)</span>
                  <input type="month" value={edit.end_ym ? `${edit.end_ym.slice(0, 4)}-${edit.end_ym.slice(4)}` : ''}
                    onChange={(e) => setEdit({ ...edit, end_ym: e.target.value ? e.target.value.replace('-', '') : null })}
                    className="rounded-lg border border-gray-300 px-2 py-1.5" /></label>
              </div>
              <label className="flex flex-col gap-1 col-span-1 md:col-span-2">備註
                <input value={edit.note ?? ''} onChange={(e) => setEdit({ ...edit, note: e.target.value })}
                  className="rounded-lg border border-gray-300 px-2 py-1.5" /></label>
              <label className="flex items-center gap-2 col-span-1 md:col-span-2">
                <input type="checkbox" checked={edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} />
                <span>啟用中<span className="text-xs text-gray-400 ml-1">停用會清掉還沒收款的月份,已收款的留著</span></span>
              </label>
            </div>
            <div className="sticky bottom-0 bg-white border-t border-mor-line px-6 py-3 flex justify-end gap-2">
              <button onClick={() => setEdit(null)} className="rounded-lg border border-gray-300 px-4 py-1.5 text-sm">取消</button>
              <button onClick={save} disabled={!!busy}
                className="rounded-lg bg-mor-slate text-white px-4 py-1.5 text-sm font-medium hover:bg-mor-slatedark disabled:opacity-40">
                {busy === 'save' ? '儲存中…' : '儲存'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
