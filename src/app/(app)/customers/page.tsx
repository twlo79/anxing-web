'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase';
import { fetchAll } from '@/lib/fetch-all';
import { twToday } from '@/lib/attendance-ui';

/**
 * 客戶管理。
 *
 * 【資料是彙整來的，不是另一份主檔】
 * 姓名、房源、住宿起訖來自訂單與契約，由 sync_customers() 覆蓋；
 * 電話、email、備註是人在這裡填的，同步永遠不動。
 * 想改姓名或日期要去那張訂單改 —— 在這裡改會被下一次同步打回去，
 * 所以資料庫直接擋住並說明原因（migration_105 的 customers_guard）。
 *
 * 【一位客戶一列】
 * 訂了三次的常客如果佔三列，電話要填三次、備註要填三次，
 * 而下次要看的時候不知道該看哪一列。
 *
 * 【預設只顯示尚未退房的】（使用者指定）
 * 上面有開關可以切到全部。全部載入是幾千列，手機上會很慢。
 */

const CARD = 'rounded-xl glass';
const INPUT = 'rounded-lg border border-mor-line px-3 py-2 text-sm w-full';

type Customer = {
  id: string;
  estate_id: string | null;
  property_id: string | null;
  property_label: string | null;
  name: string;
  stay_from: string | null;
  stay_to: string | null;
  stay_count: number;
  src_kind: string | null;
  src_phone: string | null;
  phone: string | null;
  email: string | null;
  note: string | null;
  stale: boolean;
};

type Estate = { id: string; name: string; sort: number; active: boolean };

const NO_ESTATE = '__none__';

export default function CustomersPage() {
  const supabase = useMemo(() => createClient(), []);
  const [rows, setRows] = useState<Customer[]>([]);
  const [estates, setEstates] = useState<Estate[]>([]);
  const [tab, setTab] = useState<string>('');
  const [onlyStaying, setOnlyStaying] = useState(true);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ t: string; err?: boolean } | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const today = twToday();

  function ok(t: string) { setMsg({ t }); setTimeout(() => setMsg(null), 3000); }
  function fail(t: string) { setMsg({ t, err: true }); }

  const load = useCallback(async () => {
    // fetchAll：Supabase 預設只回 1000 列而且不會報錯 ——
    // 客戶數已經超過那個數字，直接查會靜靜地少掉一截。
    const [cs, es] = await Promise.all([
      fetchAll<Customer>((f, t) =>
        supabase.from('customers').select('*').order('name').range(f, t)),
      supabase.from('estates').select('id, name, sort, active').order('sort').order('name'),
    ]);
    if (cs.error) fail('客戶清單讀取失敗：' + cs.error);
    setRows(cs.rows);
    setEstates((es.data ?? []) as Estate[]);
    setLoading(false);
  }, [supabase]);

  /**
   * 同步。
   *
   * 進頁面時在背景跑一次 —— 訂單天天在進，不同步的話新客戶不會出現，
   * 而使用者只會覺得「這頁的資料是舊的」然後不再相信它。
   * 先把現有資料畫出來再同步，不讓人等。
   */
  const sync = useCallback(async (loud = false) => {
    setSyncing(true);
    const { data, error } = await supabase.rpc('sync_customers');
    setSyncing(false);
    if (error) { if (loud) fail('同步失敗：' + error.message); return; }
    const r = data as { inserted: number; updated: number; stale: number };
    if (loud) ok(`已更新：新增 ${r?.inserted ?? 0} 位、更新 ${r?.updated ?? 0} 位`);
    if ((r?.inserted ?? 0) > 0 || loud) load();
  }, [supabase, load]);

  useEffect(() => { load().then(() => sync()); /* eslint-disable-next-line */ }, []);

  async function save(c: Customer, patch: Partial<Customer>) {
    const { data, error } = await supabase.from('customers')
      .update(patch).eq('id', c.id).select('id');
    if (error) {
      // customers_guard 擋下來的訊息本身就寫好了，原樣顯示
      return fail(error.message.replace(/^.*?ERROR:\s*/i, ''));
    }
    // RLS 擋掉的 UPDATE 不會回錯誤，只會影響 0 列
    if (!data?.length) return fail('沒有存進去 —— 你的帳號沒有編輯權限，請聯絡總經理。');
    setRows((rs) => rs.map((r) => (r.id === c.id ? { ...r, ...patch } : r)));
    ok('已儲存');
  }

  // 分頁：有客戶的物業才出現。空分頁只會讓人點進去看到「沒有資料」。
  const tabs = useMemo(() => {
    const used = new Set(rows.map((r) => r.estate_id ?? NO_ESTATE));
    const list = estates.filter((e) => used.has(e.id)).map((e) => ({ id: e.id, name: e.name }));
    if (used.has(NO_ESTATE)) list.push({ id: NO_ESTATE, name: '未指定物業' });
    return list;
  }, [rows, estates]);

  const cur = tabs.some((t) => t.id === tab) ? tab : (tabs[0]?.id ?? '');

  const shown = useMemo(() => {
    const kw = q.trim().toLowerCase();
    return rows.filter((r) => {
      if ((r.estate_id ?? NO_ESTATE) !== cur) return false;
      // 「尚未退房」而不是「今天在住」—— 下週才入住的客人也要看得到，
      // 不然剛訂完房的人在這頁上不存在。
      if (onlyStaying && !(r.stay_to && r.stay_to >= today)) return false;
      if (!kw) return true;
      return [r.name, r.property_label, r.phone, r.email, r.note]
        .some((v) => (v ?? '').toLowerCase().includes(kw));
    });
  }, [rows, cur, onlyStaying, q, today]);

  const staleCount = rows.filter((r) => r.stale && (r.estate_id ?? NO_ESTATE) === cur).length;

  return (
    <div>
      <div className="flex items-center gap-3 mb-3">
        <h1 className="hidden md:block">客戶管理</h1>
        <div className="flex-1" />
        <button onClick={() => sync(true)} disabled={syncing}
          className="rounded-lg border border-mor-line px-3 py-1.5 text-xs hover:bg-mor-sand/60 disabled:opacity-40">
          {syncing ? '同步中…' : '↻ 從訂單契約更新'}
        </button>
      </div>

      {/* 物業分頁 */}
      <div className="flex flex-wrap gap-1 mb-3 border-b border-mor-line">
        {tabs.map((t) => (
          <button key={t.id} onClick={() => { setTab(t.id); setOpen(null); }}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px whitespace-nowrap ${
              cur === t.id ? 'border-mor-slate text-mor-slate'
                           : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
            {t.name}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-3">
        <input placeholder="搜尋姓名、房號、電話、備註…" value={q} onChange={(e) => setQ(e.target.value)}
          className={`${INPUT} max-w-xs`} />
        <label className="flex items-center gap-1.5 text-sm">
          <input type="checkbox" checked={onlyStaying}
            onChange={(e) => setOnlyStaying(e.target.checked)} />
          只看尚未退房
        </label>
        <span className="text-xs text-gray-400">{shown.length} 位</span>
      </div>

      {msg && (
        <div className={`mb-3 rounded-lg px-4 py-3 text-sm flex items-start gap-2 ${
          msg.err ? 'bg-red-50 border border-red-200 text-red-700' : 'bg-mor-greenlight text-mor-green'}`}>
          <span className="shrink-0">{msg.err ? '⚠' : '✓'}</span>
          <span className="flex-1 whitespace-pre-line leading-relaxed">{msg.t}</span>
          {msg.err && (
            <button onClick={() => setMsg(null)} className="text-red-400 hover:text-red-600 shrink-0">✕</button>
          )}
        </div>
      )}

      {staleCount > 0 && !onlyStaying && (
        <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-xs text-amber-800 leading-relaxed">
          有 <b>{staleCount} 位</b>客戶對不到訂單或契約（多半是訂單那邊改了客戶名）。
        </div>
      )}

      {/* ── 桌機：表格 ───────────────────────────── */}
      <div className={`${CARD} overflow-hidden hidden md:block`}>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-gray-500 border-b border-mor-line bg-white/45">
              <th className="px-4 py-2.5">客戶名</th>
              <th className="px-4 py-2.5">房源</th>
              <th className="px-4 py-2.5">住宿起訖</th>
              <th className="px-4 py-2.5">電話</th>
              <th className="px-4 py-2.5">Email</th>
              <th className="px-4 py-2.5">備註</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((c) => (
              <RowPair key={c.id} c={c} today={today}
                open={open === c.id} onToggle={() => setOpen(open === c.id ? null : c.id)}
                onSave={(p) => save(c, p)} />
            ))}
            {!shown.length && (
              <tr><td colSpan={6} className="px-4 py-10 text-center text-sm text-gray-400">
                {loading ? '載入中…' : onlyStaying ? '這個物業目前沒有在住的客戶。取消「只看尚未退房」看歷史。' : '沒有資料'}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* ── 手機：卡片 ───────────────────────────── */}
      <div className="md:hidden space-y-2">
        {shown.map((c) => (
          <div key={c.id} className={CARD}>
            <button onClick={() => setOpen(open === c.id ? null : c.id)}
              className="w-full px-4 py-3 text-left">
              <div className="flex items-center gap-2">
                <span className="font-medium text-sm flex-1 min-w-0 truncate">{c.name}</span>
                {c.stale && <span className="text-[10px] text-amber-600 shrink-0">來源已不存在</span>}
                <span className="text-xs text-gray-400 shrink-0">{c.property_label ?? '—'}</span>
              </div>
              <div className="text-xs text-gray-500 mt-0.5">
                {stayText(c)}　{c.phone || '（無電話）'}
              </div>
              {c.note && <div className="text-xs text-mor-slate mt-1 line-clamp-2">{c.note}</div>}
            </button>
            {open === c.id && <EditBox c={c} onSave={(p) => save(c, p)} />}
          </div>
        ))}
        {!shown.length && !loading && (
          <div className={`${CARD} px-4 py-10 text-center text-sm text-gray-400`}>
            {onlyStaying ? '這個物業目前沒有在住的客戶' : '沒有資料'}
          </div>
        )}
      </div>
    </div>
  );
}

function stayText(c: Customer): string {
  if (!c.stay_from && !c.stay_to) return '—';
  const f = (c.stay_from ?? '').replace(/-/g, '/').slice(2);
  const t = (c.stay_to ?? '').replace(/-/g, '/').slice(2);
  return c.stay_count > 1 ? `${f} ~ ${t}（${c.stay_count} 次）` : `${f} ~ ${t}`;
}

/** 表格列 ＋ 展開的編輯區（同一個 key 下的兩個 <tr>） */
function RowPair({ c, today, open, onToggle, onSave }: {
  c: Customer; today: string; open: boolean;
  onToggle: () => void; onSave: (p: Partial<Customer>) => void;
}) {
  const staying = !!c.stay_to && c.stay_to >= today;
  return (
    <>
      <tr onClick={onToggle}
        className={`border-b border-mor-line/60 cursor-pointer hover:bg-white/45 ${
          open ? 'bg-white/45' : ''}`}>
        <td className="px-4 py-2.5">
          <div className="flex items-center gap-1.5">
            {/* 在住的標一個綠點 —— 一整頁歷史客戶裡要一眼認出現在還在的 */}
            {staying && <span className="w-1.5 h-1.5 rounded-full bg-mor-green shrink-0" />}
            <span className="font-medium">{c.name}</span>
            {c.stale && (
              <span className="text-[10px] text-amber-600 border border-amber-200 rounded px-1">
                來源已不存在
              </span>
            )}
          </div>
        </td>
        <td className="px-4 py-2.5 text-gray-600">{c.property_label ?? '—'}</td>
        <td className="px-4 py-2.5 text-gray-600 tabular-nums whitespace-nowrap">{stayText(c)}</td>
        <td className="px-4 py-2.5 tabular-nums">{c.phone || <span className="text-gray-300">—</span>}</td>
        <td className="px-4 py-2.5 text-gray-600">{c.email || <span className="text-gray-300">—</span>}</td>
        <td className="px-4 py-2.5 text-gray-600 max-w-[16rem]">
          <div className="truncate">{c.note || <span className="text-gray-300">—</span>}</div>
        </td>
      </tr>
      {open && (
        <tr className="border-b border-mor-line/60 bg-mor-sand/20">
          <td colSpan={6} className="px-4 py-3"><EditBox c={c} onSave={onSave} /></td>
        </tr>
      )}
    </>
  );
}

/**
 * 編輯區。
 *
 * 【備註刻意做大】（使用者指定）
 * 備註是這一頁真正的價值 —— 「不吃辣」「隔壁投訴過」「續約意願高」
 * 這種東西寫不進訂單。一行的輸入框會讓人只寫五個字。
 *
 * 【存檔是明確的按鈕，不是 onBlur】
 * 長文字用失焦自動存的話，寫到一半點別的地方會存下半句，
 * 而且不知道到底存了沒。
 */
function EditBox({ c, onSave }: { c: Customer; onSave: (p: Partial<Customer>) => void }) {
  const [phone, setPhone] = useState(c.phone ?? '');
  const [email, setEmail] = useState(c.email ?? '');
  const [note, setNote] = useState(c.note ?? '');

  useEffect(() => {
    setPhone(c.phone ?? ''); setEmail(c.email ?? ''); setNote(c.note ?? '');
  }, [c.id, c.phone, c.email, c.note]);

  const dirty = phone !== (c.phone ?? '') || email !== (c.email ?? '') || note !== (c.note ?? '');

  return (
    <div className="p-1 space-y-3" onClick={(e) => e.stopPropagation()}>
      <div className="grid md:grid-cols-2 gap-3">
        <label className="text-sm">
          <span className="text-xs text-gray-500 block mb-0.5">電話</span>
          <input value={phone} onChange={(e) => setPhone(e.target.value)}
            placeholder="0912-345-678" className={`${INPUT} tabular-nums`} />
        </label>
        <label className="text-sm">
          <span className="text-xs text-gray-500 block mb-0.5">Email</span>
          <input value={email} onChange={(e) => setEmail(e.target.value)}
            placeholder="name@example.com" className={INPUT} />
        </label>
      </div>

      <label className="text-sm block">
        <span className="text-xs text-gray-500 block mb-0.5">備註</span>
        <textarea rows={8} value={note} onChange={(e) => setNote(e.target.value)}
          placeholder={'例：\n・電梯壞掉那次有反映過，處理完了\n・希望續約，下次提早一個月問\n・退房時鑰匙少一支，押金已扣'}
          className={`${INPUT} leading-relaxed resize-y min-h-[9rem]`} />
      </label>

      <div className="flex flex-wrap items-center gap-3">
        <button onClick={() => onSave({ phone: phone || null, email: email || null, note: note || null })}
          disabled={!dirty}
          className="rounded-lg px-4 py-2 text-sm font-medium bg-mor-slate text-white
                     hover:bg-mor-slatedark disabled:opacity-40">
          {dirty ? '儲存' : '已儲存'}
        </button>
        <span className="text-xs text-gray-400">
          {c.src_kind === 'contract' ? '來自契約'
            : c.src_kind === 'order' ? '來自訂單'
            : c.src_kind === 'both' ? '契約與訂單都有' : ''}
          {c.stay_count > 1 && `・住過 ${c.stay_count} 次`}
        </span>
      </div>

      {c.stale && (
        <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800 leading-relaxed">
          <b>對不到任何訂單或契約。</b>多半是訂單那邊改了客戶名，備註留在這一列。
        </div>
      )}
    </div>
  );
}
