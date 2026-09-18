'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase';
import { useOnce } from '@/lib/once';
import {
  FORM_CATS, canEditForms, parseFormCat, formIcon,
  sortForms, matchForm, formHasFile,
  FILE_ACCEPT, fileKind, fmtSize, fileTooBig, FILE_BADGE, KIND_EXTS,
} from '@/lib/board';

/*
 * ══════════════════════════════════════════════════════════
 * 佈告欄 → 表單下載（2026-09-18 使用者指定）
 *
 *   「加一個 表單下載 / 可上傳 共用公司文件 之後的人 可以下載使用
 *     1. 可以編輯 換檔案 > 總經理 | 會計 | 主管
 *     2. 其他人有權限可以下載
 *     3. 能上傳 word pdf」
 *
 * ══════════════════════════════════════════════════════════
 * 【★★★ 這一格的規則跟「帳密」不一樣】
 *
 *   帳密　　看：房務以外　　　改：同上
 *   表單　　看：**全公司，含房務**　　改：總經理・會計・主管
 *
 * ★ 請假單、報帳單這種本來就是發給大家填的 —— 房務看不到的話沒有意義。
 * ★★ 所以**不共用** `SECRET_ROLES`。共用的話改其中一格會連帶改掉另一格，
 *   而那件事不會有人發現（README:同一條規則在三個地方各寫一次）。
 *
 * ══════════════════════════════════════════════════════════
 * 【★★ 不能改的人，那些鈕整顆不出現，不是灰掉】
 *
 * 灰掉的鈕會讓人一直點然後問「為什麼我不能用」——
 * 跟權限管理頁同一個處理（anxing-ui 二-6）。
 *
 * ★ 而且**真正擋住的是 RLS 不是這裡**（migration_273 的
 *   `can_edit_board_forms()`）。前端這一份被改掉也沒有用。
 *
 * ══════════════════════════════════════════════════════════
 * 【★★★ 換檔案時 id 不動】
 *
 * 換掉整列的話，「誰上傳的、什麼時候」那段歷史會跟著不見
 * （README:整批刪掉重建有 id 的東西）。所以換檔案 ＝
 * 傳新檔 → 改 `file_path` → 刪舊檔，同一列。
 *
 * ★ 舊檔**最後才刪**。先刪的話，新檔傳失敗就兩個都沒了。
 * ══════════════════════════════════════════════════════════
 */

type Form = {
  id: string;
  title: string;
  category: string | null;
  note: string | null;
  file_path: string | null;
  file_name: string | null;
  file_size: number | null;
  created_by: string | null;
  updated_at: string;
  updated_by: string | null;
};

type Draft = {
  id?: string;
  title: string;
  category: string;
  note: string;
  /** 新選的檔案。編輯時留 null ＝ 不換檔案 */
  file: File | null;
  /** 編輯時原本那份叫什麼 —— 給畫面顯示「現在是這一份」 */
  oldName?: string | null;
};

const BLANK: Draft = { title: '', category: '人事', note: '', file: null };
const BUCKET = 'board-forms';

/*
 * 圖示的底色。★ 一眼看得出是哪一種 ——
 *   綠＝試算表（Excel 的顏色）、紅＝PDF、藍＝Word、紫＝圖片。
 *   顏色有語意，借用會讓它失去意思（anxing-ui 五）。
 */
const BADGE_BG: Record<string, string> = {
  pdf: 'bg-red-600', word: 'bg-blue-600', excel: 'bg-mor-greendark',
  csv: 'bg-mor-greendark', image: 'bg-violet-500', other: 'bg-gray-400',
};

/**
 * 「可以傳哪些」那一行字。
 *
 * ★★ 從 `KIND_EXTS` 長出來，**不要自己再打一次** ——
 *   打第二次的話，哪天加了一種格式，畫面上那一行會留在舊的，
 *   而使用者會照著它以為傳不了（README:同一條規則在三個地方各寫一次）。
 */
const ACCEPT_HINT = Object.values(KIND_EXTS).flat().join('　');

export default function FormsTab({ role, meId, onMsg }: {
  role: string;
  meId: string;
  onMsg: (t: string, err?: boolean) => void;
}) {
  const supabase = useMemo(() => createClient(), []);
  const canEdit = canEditForms(role);

  const [list, setList] = useState<Form[]>([]);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [{ data, error }, { data: pf }] = await Promise.all([
      /* ★ 排序交給 `sortForms`（lib，有測試）—— 「照分類」那個順序 SQL 排不出來 */
      supabase.from('board_forms').select('*'),
      supabase.from('profiles').select('id, name'),
    ]);
    if (error) onMsg('讀不到表單：' + error.message, true);
    setList((data ?? []) as Form[]);
    setNames(new Map((pf ?? []).map((p) => [p.id as string, p.name as string])));
    setLoading(false);
  }, [supabase, onMsg]);

  useEffect(() => { load(); }, [load]);

  /**
   * 下載。
   *
   * ★★ 走 `createSignedUrl` —— bucket 是私有的，直接拼公開網址抓不到。
   * ★★★ 拿不到網址時**要講話**。不講的話按下去整頁沒反應，
   *   而使用者的結論是「按鈕壞了」（README 2026-09-02）。
   */
  const download = async (f: Form) => {
    if (!formHasFile(f)) {
      return onMsg('這一份還沒有檔案 —— 請會計或主管上傳。', true);
    }
    setBusyId(f.id);
    const { data, error } = await supabase.storage.from(BUCKET)
      .createSignedUrl(f.file_path as string, 60, { download: f.file_name ?? undefined });
    setBusyId(null);
    if (error || !data?.signedUrl) {
      return onMsg('下載不了：' + (error?.message ?? '拿不到檔案網址'), true);
    }
    window.open(data.signedUrl, '_blank', 'noopener');
  };

  const save = async (d: Draft) => {
    const title = d.title.trim();
    if (!title) return onMsg('「表單名稱」要填。', true);

    /* 新增時一定要有檔案 —— 沒檔案的「表單下載」是一顆按了沒反應的鈕 */
    if (!d.id && !d.file) return onMsg('要選一個檔案（PDF 或 Word）。', true);

    let path: string | null = null;
    let oldPath: string | null = null;

    if (d.file) {
      const big = fileTooBig(d.file.size);
      if (big.bad) return onMsg(big.why, true);
      if (fileKind(d.file.name) === 'other') {
        return onMsg('這種檔案收不了。可以傳：' + ACCEPT_HINT, true);
      }
      /*
       * ★ 路徑帶時間戳 —— 同名檔案換兩次不會互相蓋掉，
       *   而且舊檔還在的那一瞬間也不會衝突。
       */
      const safe = d.file.name.replace(/[^\w.\-]+/g, '_');
      path = `${Date.now()}_${safe}`;
      const up = await supabase.storage.from(BUCKET).upload(path, d.file);
      if (up.error) return onMsg('檔案傳不上去：' + up.error.message, true);
      if (d.id) oldPath = list.find((x) => x.id === d.id)?.file_path ?? null;
    }

    const body: Record<string, unknown> = {
      title,
      category: parseFormCat(d.category),
      note: d.note.trim() || null,
      updated_by: meId,
      updated_at: new Date().toISOString(),
    };
    if (d.file && path) {
      body.file_path = path;
      body.file_name = d.file.name;
      body.file_size = d.file.size;
    }

    /*
     * ★★★ `.select('id')` 不能省。RLS 擋下來的寫入**回成功且影響 0 列**，
     *   不是錯誤（README 坑 C）。只接 error 的話，
     *   畫面說存好了、重新整理什麼都沒有。
     */
    const { data, error } = d.id
      ? await supabase.from('board_forms').update(body).eq('id', d.id).select('id')
      : await supabase.from('board_forms')
          .insert({ ...body, created_by: meId }).select('id');

    if (error || !data?.length) {
      /* ★ 寫不進去的話，剛剛傳上去的那個檔要清掉 —— 不然 bucket 裡會留孤兒 */
      if (path) await supabase.storage.from(BUCKET).remove([path]);
      if (error) return onMsg((d.id ? '存不起來：' : '建不起來：') + error.message, true);
      return onMsg('沒有存進去 —— 你的帳號沒有上傳表單的權限。', true);
    }

    /* ★ 舊檔最後才刪。刪失敗只留一行 console —— 不擋住人做事 */
    if (oldPath) {
      const rm = await supabase.storage.from(BUCKET).remove([oldPath]);
      if (rm.error) console.warn('[board] 舊檔沒刪掉：', rm.error.message);
    }
    setDraft(null);
    load();
  };

  const del = async (f: Form) => {
    if (!confirm(`刪掉「${f.title}」？\n\n檔案會一起不見，而且救不回來。`)) return;
    const { data, error } = await supabase.from('board_forms')
      .delete().eq('id', f.id).select('id');
    if (error) return onMsg('刪不掉：' + error.message, true);
    if (!data?.length) return onMsg('沒有刪掉 —— 你的帳號沒有這個權限。', true);
    if (f.file_path) {
      const rm = await supabase.storage.from(BUCKET).remove([f.file_path]);
      if (rm.error) console.warn('[board] 檔案沒刪掉：', rm.error.message);
    }
    load();
  };

  const rows = sortForms(list).filter((f) => matchForm(f, q));

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-3">
        {/* ★★ 不能改的人這顆**整顆不出現**，不是灰掉 */}
        {canEdit && (
          <button onClick={() => setDraft({ ...BLANK })}
            className="h-11 md:h-10 rounded-lg bg-mor-slate text-white px-4 text-ui font-medium
                       hover:bg-mor-slatedark">＋ 上傳表單</button>
        )}
        <input value={q} onChange={(e) => setQ(e.target.value)}
          placeholder="關鍵字找表單..."
          className="h-11 md:h-10 rounded-lg border border-mor-line px-3 text-ui flex-1 min-w-[170px]" />
        <span className="text-uisub text-gray-500 whitespace-nowrap">
          共 <b className="text-mor-ink">{rows.length}</b> 份
        </span>
      </div>

      {loading && <div className="text-uisub text-gray-400 py-10 text-center">載入中…</div>}

      {!loading && !rows.length && (
        <div className="rounded-xl border border-mor-line bg-white py-14 text-center text-ui text-gray-400">
          {list.length
            ? `找不到「${q}」`
            : canEdit
              ? '還沒有任何表單 —— 按上面的「＋ 上傳表單」。'
              : '還沒有任何表單。要放請假單、報帳單這些的話，請會計或主管上傳。'}
        </div>
      )}

      {!loading && rows.length > 0 && (
        <div className="rounded-xl border border-mor-line bg-white overflow-hidden">
          {rows.map((f) => {
            const cat = parseFormCat(f.category);
            const k = fileKind(f.file_name ?? '');
            const has = formHasFile(f);
            return (
              <div key={f.id}
                className="flex items-center gap-3 px-4 py-3 border-t border-mor-line/60 first:border-t-0">
                {/*
                  ★ 用副檔名當圖示，一眼看得出是 Word 還是 PDF ——
                    下載之前就知道等一下要用什麼開。
                */}
                <span className={`w-9 h-9 shrink-0 rounded-lg flex items-center justify-center
                                  text-[11px] font-bold text-white ${BADGE_BG[k]}`}>
                  {FILE_BADGE[k]}
                </span>

                <span className="flex-1 min-w-0">
                  <span className="block text-ui font-medium truncate">{f.title}</span>
                  {f.note && <span className="block text-uisub text-gray-500 truncate">{f.note}</span>}
                  <span className="block text-xs text-gray-400 truncate">
                    {names.get(f.updated_by ?? f.created_by ?? '') ?? '—'}
                    {' · '}{f.updated_at.slice(5, 10).replace('-', '/')}
                    {f.file_size ? ` · ${fmtSize(f.file_size)}` : ''}
                  </span>
                </span>

                <span className="shrink-0 rounded px-2 py-0.5 text-xs
                                 bg-mor-bluelight text-mor-slatedark">
                  {formIcon(cat)} {cat}
                </span>

                {canEdit && (
                  <>
                    <button onClick={() => setDraft({
                      id: f.id, title: f.title, category: parseFormCat(f.category),
                      note: f.note ?? '', file: null, oldName: f.file_name,
                    })} className="shrink-0 text-uisub text-mor-slate hover:text-mor-slatedark">編輯</button>
                    <button onClick={() => del(f)}
                      className="shrink-0 text-uisub text-red-400 hover:text-red-600">刪掉</button>
                  </>
                )}

                {/*
                  ★★★ 沒有檔案的那幾筆，鈕**不畫成「下載」** ——
                    畫了就是一顆按了沒反應的鈕，而使用者的結論是系統壞了。
                */}
                <button onClick={() => download(f)} disabled={busyId === f.id}
                  title={has ? '下載' : '這一份還沒有檔案'}
                  className={`shrink-0 h-10 rounded-lg border px-4 text-uisub font-medium
                              disabled:opacity-50 ${
                    has ? 'border-mor-greendark text-mor-greendark hover:bg-mor-greenlight'
                        : 'border-amber-300 text-amber-700 bg-amber-50'}`}>
                  {busyId === f.id ? '準備中⋯' : has ? '下載' : '沒有檔案'}
                </button>
              </div>
            );
          })}
        </div>
      )}

      {draft && (
        <FormDialog draft={draft} onChange={setDraft}
          onClose={() => setDraft(null)} onSave={save} />
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════ */

function FormDialog({ draft, onChange, onClose, onSave }: {
  draft: Draft;
  onChange: (d: Draft) => void;
  onClose: () => void;
  onSave: (d: Draft) => Promise<void> | void;
}) {
  const [save, saving] = useOnce(async () => { await onSave(draft); });
  const pick = useRef<HTMLInputElement>(null);
  const bad = !draft.title.trim() || (!draft.id && !draft.file);

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative bg-white w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl shadow-xl
                      max-h-[92vh] sm:max-h-[85vh] overflow-y-auto">
        <div className="sticky top-0 bg-white px-5 py-3.5 border-b border-mor-line font-bold text-ui
                        flex items-center justify-between">
          {draft.id ? '編輯表單' : '上傳表單'}
          <button onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-xl leading-none">✕</button>
        </div>

        <div className="px-5 py-4 grid gap-3">
          {/* ── 檔案 ── */}
          <div className="flex flex-col gap-1">
            <span className="text-uisub text-gray-500 flex items-center">
              檔案{!draft.id && <span className="text-red-500 ml-0.5">*</span>}
            </span>
            <input ref={pick} type="file" accept={FILE_ACCEPT} className="hidden"
              onChange={(e) => onChange({ ...draft, file: e.target.files?.[0] ?? null })} />
            <button onClick={() => pick.current?.click()}
              className="rounded-lg border-[1.5px] border-dashed border-mor-line bg-[#FAFAF9]
                         px-4 py-4 text-center hover:border-mor-slate">
              {draft.file ? (
                <>
                  <span className="block text-ui text-mor-ink break-all">{draft.file.name}</span>
                  <span className="block text-xs text-gray-400 mt-0.5">
                    {fmtSize(draft.file.size)}・點一下換別份
                  </span>
                </>
              ) : (
                <>
                  <span className="block text-ui text-mor-slate">選擇檔案</span>
                  <span className="block text-xs text-gray-400 mt-0.5">{ACCEPT_HINT}</span>
                </>
              )}
            </button>
            {/*
              ★★ 編輯時**要說出現在是哪一份**。不說的話，
                看到一個空的「選擇檔案」會以為原本的檔案不見了。
            */}
            {draft.id && !draft.file && (
              <span className="text-xs text-gray-400">
                現在是「{draft.oldName || '（沒有檔案）'}」—— 不選新檔案就不會換。
              </span>
            )}
          </div>

          <label className="flex flex-col gap-1">
            <span className="text-uisub text-gray-500 flex items-center">
              表單名稱<span className="text-red-500 ml-0.5">*</span>
            </span>
            <input value={draft.title} onChange={(e) => onChange({ ...draft, title: e.target.value })}
              placeholder="請假單"
              className="h-11 md:h-10 rounded-lg border border-mor-line px-3 text-ui" /></label>

          <label className="flex flex-col gap-1">
            <span className="text-uisub text-gray-500">分類</span>
            <select value={draft.category} onChange={(e) => onChange({ ...draft, category: e.target.value })}
              className="h-11 md:h-10 rounded-lg border border-mor-line px-2 text-ui bg-white">
              {FORM_CATS.map((c) => <option key={c} value={c}>{c}</option>)}
            </select></label>

          <label className="flex flex-col gap-1">
            <span className="text-uisub text-gray-500">說明（什麼時候要用、填完交給誰）</span>
            <input value={draft.note} onChange={(e) => onChange({ ...draft, note: e.target.value })}
              placeholder="填完交給芊，人事單月底前送出"
              className="h-11 md:h-10 rounded-lg border border-mor-line px-3 text-ui" /></label>

          <div className="text-xs text-gray-400 leading-relaxed">
            全公司都下載得到（含房務）。只有總經理、會計、主管可以上傳與換檔案。
          </div>
        </div>

        <div className="sticky bottom-0 bg-white px-5 py-3 border-t border-mor-line flex justify-end gap-2">
          <button onClick={onClose}
            className="h-11 md:h-10 rounded-lg border border-mor-line px-5 text-uisub">取消</button>
          {/* ★ 灰掉要說得出為什麼（anxing-ui 二-6） */}
          <button onClick={save} disabled={saving || bad}
            title={!draft.title.trim() ? '「表單名稱」要填'
                 : (!draft.id && !draft.file) ? '要先選一個檔案' : ''}
            className="h-11 md:h-10 rounded-lg bg-mor-slate text-white px-5 text-uisub font-medium
                       hover:bg-mor-slatedark disabled:opacity-50">
            {saving ? '上傳中⋯' : draft.id ? '儲存' : '上傳'}</button>
        </div>
      </div>
    </div>
  );
}
