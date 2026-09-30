'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase';
import { useOnce } from '@/lib/once';
import { softDelete } from '@/lib/trash';
import {
  canWriteContacts, sortContacts, matchContact, telHref, mailHref,
  contactProblem, contactBody, BLANK_CONTACT,
  type Contact, type ContactDraft,
} from '@/lib/board-contacts';
import { savedToast, savedText, SAVED_HL, justRow } from '@/lib/saved-feedback';
import { useJustSaved } from '@/lib/use-just-saved';
import { SavedBadge } from '@/components/SavedToast';

/*
 * ══════════════════════════════════════════════════════════
 * 佈告欄 → 電話簿（2026-09-30 使用者：「多一個電話簿的功能：姓名／公司名・電話・email・備註」）
 *
 * 【全部攤在清單上】使用者 2026-09-30：「可以盡量把資訊都顯示出來嗎？email 與備註」——
 *   一列就是一筆的全部，沒有詳細頁。電話與 email 直接是連結（撥／寄），沒有「複製」（使用者：「不用複製」）。
 *
 * 【編輯在自己的頁】使用者：「右邊顯示 › ，按了編輯頁裡編輯才能編輯」——
 *   能寫的人每列右邊有 ›，按進去是一頁表單（← 回清單）；儲存、刪都在那一頁。
 *   看的人（房務、管家）沒有 ›、沒有「＋ 新增」。
 *
 * 【誰能寫問資料庫】RLS 用 can_write_board_contacts()；這裡的 canWriteContacts() 只是決定要不要畫按鈕。
 *   存檔一律接 `.select('id')` —— RLS 擋下來回的是「成功、0 列」。
 *
 * 【刪除進回收桶】softDelete('board_contacts')，跟訂單契約同一套，救得回來。
 *   刪是那一頁底下一行紅色小字（anxing-ui 四-3），不跟「取消／儲存」排一起。
 * ══════════════════════════════════════════════════════════
 */

export default function ContactsTab({ role, meId, onMsg }: {
  role: string;
  meId: string;
  onMsg: (t: string, err?: boolean) => void;
}) {
  const supabase = useMemo(() => createClient(), []);
  const canWrite = canWriteContacts(role);

  const [list, setList] = useState<Contact[]>([]);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  /** 正在編輯的那一筆（沒有 id ＝ 新增）。null ＝ 停在清單 */
  const [draft, setDraft] = useState<ContactDraft | null>(null);
  const { markSaved, isJust } = useJustSaved(list);

  const load = useCallback(async () => {
    setLoading(true);
    const [{ data, error }, { data: pf }] = await Promise.all([
      supabase.from('board_contacts').select('*'),
      supabase.from('profiles').select('id, name'),
    ]);
    if (error) onMsg('讀不到通訊：' + error.message, true);
    setList((data ?? []) as Contact[]);
    setNames(new Map((pf ?? []).map((p) => [p.id as string, p.name as string])));
    setLoading(false);
  }, [supabase, onMsg]);
  useEffect(() => { load(); }, [load]);

  const save = async (d: ContactDraft) => {
    const body = contactBody(d);
    const { data, error } = d.id
      ? await supabase.from('board_contacts')
          .update({ ...body, updated_by: meId, updated_at: new Date().toISOString() })
          .eq('id', d.id).select('id')
      : await supabase.from('board_contacts')
          .insert({ ...body, created_by: meId, updated_by: meId }).select('id');
    if (error) return onMsg((d.id ? '存不起來：' : '建不起來：') + error.message, true);
    if (!data?.length) {
      return onMsg('沒有存進去 —— 你的帳號沒有這個權限。\n如果你認為應該有，請總經理確認角色設定。', true);
    }
    savedToast(savedText(d.id ? '已儲存' : '已新增', d.name));
    markSaved(data[0].id);
    setDraft(null);
    load();
  };

  const del = async (d: ContactDraft) => {
    if (!d.id) return;
    if (!confirm(`刪掉「${d.name}」？\n\n會移到回收桶，可以復原。`)) return;
    const r = await softDelete(supabase, 'board_contacts', d.id, '通訊');
    if (!r.ok) return onMsg(r.message, true);
    savedToast(savedText('已刪除', d.name));
    setDraft(null);
    load();
  };

  /* ══════════════ 編輯頁 ══════════════ */
  if (draft) {
    const cur = draft.id ? list.find((c) => c.id === draft.id) : undefined;
    return (
      <ContactForm draft={draft} onChange={setDraft}
        who={cur ? `${names.get(cur.updated_by ?? '') ?? '—'} · ${cur.updated_at.slice(5, 10).replace('-', '/')}` : null}
        onBack={() => setDraft(null)} onSave={save} onDel={del} />
    );
  }

  /* ══════════════ 清單 ══════════════ */
  const rows = sortContacts(list).filter((c) => matchContact(c, q));
  const edit = (c: Contact) => setDraft({ id: c.id, name: c.name, phone: c.phone ?? '', email: c.email ?? '', note: c.note ?? '' });

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-3">
        {canWrite && (
          <button onClick={() => setDraft({ ...BLANK_CONTACT })}
            className="h-11 md:h-10 rounded-lg bg-mor-slate text-white px-4 text-ui font-medium
                       hover:bg-mor-slatedark">＋ 新增</button>
        )}
        <input value={q} onChange={(e) => setQ(e.target.value)}
          placeholder="找人、公司、電話、email…"
          className="h-11 md:h-10 rounded-lg border border-mor-line px-3 text-ui flex-1 min-w-[170px]" />
        <span className="text-uisub text-gray-500 whitespace-nowrap">
          共 <b className="text-mor-ink">{rows.length}</b> 筆
        </span>
      </div>

      {loading && <div className="text-uisub text-gray-400 py-10 text-center">載入中…</div>}

      {!loading && !rows.length && (
        <div className="rounded-xl border border-mor-line bg-white py-14 text-center text-ui text-gray-400">
          {list.length ? `找不到「${q}」` : canWrite ? '還沒有任何一筆 —— 按上面的「＋ 新增」。' : '還沒有任何一筆。'}
        </div>
      )}

      {!loading && rows.length > 0 && (
        <div className="rounded-xl border border-mor-line bg-white overflow-hidden">
          {rows.map((c) => {
            const tel = telHref(c.phone), mail = mailHref(c.email);
            const inner = (
              <>
                <span className="w-9 h-9 shrink-0 rounded-lg bg-mor-sand mt-0.5
                                 flex items-center justify-center text-[14px] font-bold text-[#6b5b3f]">
                  {c.name.trim().charAt(0)}
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block text-ui font-semibold leading-snug">{isJust(c.id) && <SavedBadge />}{c.name}</span>
                  {(c.phone || c.email) && (
                    <span className="flex flex-wrap gap-x-4 gap-y-0.5 mt-0.5 text-ui tabular-nums">
                      {c.phone && (
                        <span><span className="text-gray-400 text-xs mr-1">☎</span>
                          {/* ★ 連結要 stopPropagation —— 不然點電話會連帶打開編輯頁 */}
                          {tel ? <a href={tel} onClick={(e) => e.stopPropagation()} className="text-mor-slate hover:text-mor-slatedark">{c.phone}</a> : c.phone}
                        </span>
                      )}
                      {c.email && (
                        <span className="min-w-0 break-all"><span className="text-gray-400 text-xs mr-1">✉</span>
                          {mail ? <a href={mail} onClick={(e) => e.stopPropagation()} className="text-mor-slate hover:text-mor-slatedark">{c.email}</a> : c.email}
                        </span>
                      )}
                    </span>
                  )}
                  {c.note && (
                    <span className="block mt-0.5 text-uisub text-gray-500 whitespace-pre-wrap leading-relaxed">{c.note}</span>
                  )}
                </span>
                {/*
                  ★ 手機一鍵撥（2026-09-30 使用者：「手機上有一個打電話按鈕，直接按就撥」）。
                    只在手機出現（md:hidden）—— 電腦撥不出去，電話本身還是連結。
                    電話欄不是號碼（「LINE 找她」）就不畫。stopPropagation：按 📞 不會打開編輯頁。
                */}
                {tel && (
                  <a href={tel} onClick={(e) => e.stopPropagation()} title={`撥打 ${c.phone}`} aria-label={`撥打 ${c.phone}`}
                    className="md:hidden shrink-0 self-center w-11 h-11 rounded-full border-[1.5px] border-mor-slate
                               text-mor-slate flex items-center justify-center text-lg active:bg-mor-bluelight">📞</a>
                )}
                {canWrite && (
                  <button type="button" title="編輯" onClick={(e) => { e.stopPropagation(); edit(c); }}
                    className="shrink-0 self-center w-9 h-9 -mr-2 rounded-lg text-gray-300 hover:text-mor-slate hover:bg-mor-sand/60 text-xl leading-none">›</button>
                )}
              </>
            );
            /*
             * ★ 列是 div 不是 button —— 裡面有電話與 email 的 <a>，互動元素不能套互動元素。
             *   能寫的人整列可點（跟 › 同一個動作）；看的人的列只是一列字。
             */
            return (
              <div key={c.id} {...justRow(isJust(c.id))} role={canWrite ? 'button' : undefined} tabIndex={canWrite ? 0 : undefined}
                onClick={canWrite ? () => edit(c) : undefined}
                onKeyDown={canWrite ? (e) => { if (e.key === 'Enter') edit(c); } : undefined}
                className={`flex items-start gap-3 px-4 py-3 border-t border-mor-line/60 first:border-t-0 ${
                  isJust(c.id) ? SAVED_HL + ' ' : ''}${canWrite ? 'cursor-pointer hover:bg-mor-sand/50' : ''}`}>
                {inner}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════ */

/**
 * 編輯頁（新增也是它）。← 回清單；儲存在底下；刪是最底一行紅色小字。
 */
function ContactForm({ draft, who, onChange, onBack, onSave, onDel }: {
  draft: ContactDraft;
  who: string | null;
  onChange: (d: ContactDraft) => void;
  onBack: () => void;
  onSave: (d: ContactDraft) => Promise<void> | void;
  onDel: (d: ContactDraft) => Promise<void> | void;
}) {
  const [save, saving] = useOnce(async () => { await onSave(draft); });
  const problem = contactProblem(draft);
  const inCls = 'h-11 md:h-10 rounded-lg border border-mor-line px-3 text-ui w-full';

  return (
    <div>
      <button onClick={onBack} className="flex items-center gap-2.5 mb-3 text-left hover:opacity-70">
        <span className="text-xl text-gray-500">←</span>
        <span className="text-xl font-bold">{draft.id ? draft.name || '編輯' : '新增一筆'}</span>
      </button>

      <div className="rounded-xl border border-mor-line bg-white p-4 md:p-5 grid gap-3 md:grid-cols-2">
        <label className="flex flex-col gap-1 md:col-span-2">
          <span className="text-uisub text-gray-500 flex items-center">姓名／公司名<Star /></span>
          <input value={draft.name} onChange={(e) => onChange({ ...draft, name: e.target.value })}
            placeholder="輸入姓名或公司名" className={inCls} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-uisub text-gray-500">電話</span>
          <input value={draft.phone} onChange={(e) => onChange({ ...draft, phone: e.target.value })}
            placeholder="輸入電話" inputMode="tel" autoComplete="off" className={inCls} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-uisub text-gray-500">email</span>
          <input value={draft.email} onChange={(e) => onChange({ ...draft, email: e.target.value })}
            placeholder="輸入 email" inputMode="email" autoComplete="off" spellCheck={false} className={inCls} />
        </label>
        <label className="flex flex-col gap-1 md:col-span-2">
          <span className="text-uisub text-gray-500">備註</span>
          <textarea value={draft.note} onChange={(e) => onChange({ ...draft, note: e.target.value })}
            placeholder="輸入備註"
            className="rounded-lg border border-mor-line px-3 py-2 text-ui min-h-[80px] resize-y" />
        </label>

        <div className="md:col-span-2 mt-1 pt-4 border-t border-mor-line flex items-center gap-2">
          <button onClick={onBack} className="h-11 md:h-10 rounded-lg border border-mor-line px-5 text-uisub">取消</button>
          {/* ★ 灰掉要說得出為什麼（anxing-ui 二-6） */}
          <button onClick={save} disabled={saving || !!problem} title={problem ?? ''}
            className="h-11 md:h-10 rounded-lg bg-mor-slate text-white px-5 text-uisub font-medium
                       hover:bg-mor-slatedark disabled:opacity-50">
            {saving ? '儲存中⋯' : draft.id ? '儲存' : '建立'}</button>
          {who && <span className="ml-auto text-xs text-gray-400 whitespace-nowrap">{who}</span>}
        </div>
      </div>

      {draft.id && (
        <div className="mt-3 text-center">
          <button onClick={() => onDel(draft)} className="text-xs text-red-400 underline hover:text-red-600">
            刪掉這筆（會移到回收桶，可以復原）
          </button>
        </div>
      )}
    </div>
  );
}

/** 必填星號。★ 接在文字後面不換行（anxing-ui 二-1） */
const Star = () => <span className="text-red-500 ml-0.5">*</span>;
