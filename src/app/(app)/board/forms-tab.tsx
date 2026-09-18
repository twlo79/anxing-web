'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase';
import { useOnce } from '@/lib/once';
import {
  FORM_CATS, canEditForms, parseFormCat, formIcon,
  sortForms, matchForm, formHasFile,
  FILE_ACCEPT, fileKind, fmtSize, fileTooBig, FILE_BADGE, KIND_EXTS,
} from '@/lib/board';
import { deleteMatches, whyDeleteBlocked, DELETE_READY } from '@/lib/confirm-delete';

/*
 * ══════════════════════════════════════════════════════════
 * 佈告欄 → 檔案下載（2026-09-18 使用者指定，同日改名:表單→檔案）
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
  /** 使用說明（migration_276）。null ＝ 沒有，那一列不畫那顆 ▸ */
  usage_note: string | null;
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
  usage_note: string;
  /** 新選的檔案。編輯時留 null ＝ 不換檔案 */
  file: File | null;
  /** 編輯時原本那份叫什麼 —— 給畫面顯示「現在是這一份」 */
  oldName?: string | null;
};

const BLANK: Draft = { title: '', category: '人事', note: '', usage_note: '', file: null };
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
 * ══════════════════════════════════════════════════════════
 * 【★★ 寫種類，不寫副檔名】（2026-09-18 使用者:「爆版」）
 *
 * 十二個副檔名排成一行會超出對話框（`.pdf .doc .docx .xls .xlsx
 * .csv .jpg .jpeg .png .gif .webp .heic`）。**而且沒有人需要讀完** ——
 * 手上那份是 Excel 還是圖片，他自己知道。
 *
 * ★ 真的傳錯格式時，錯誤訊息**還是會把完整的副檔名列出來**
 *   （`ACCEPT_FULL`）—— 那時候他才需要知道到底收哪幾種。
 *
 * ★★ 兩份都從 `KIND_EXTS` 長出來，不要自己再打一次 ——
 *   打第二次的話，哪天加了一種格式，畫面上那一行會留在舊的
 *   （README:同一條規則在三個地方各寫一次）。
 * ══════════════════════════════════════════════════════════
 */
const KIND_NAME: Record<string, string> = {
  pdf: 'PDF', word: 'Word', excel: 'Excel', csv: 'CSV', image: '圖片',
};
const ACCEPT_HINT = Object.keys(KIND_EXTS).map((k) => KIND_NAME[k] ?? k).join('　');
/** 被擋下來的時候才印這一份 —— 完整的副檔名 */
const ACCEPT_FULL = Object.values(KIND_EXTS).flat().join(' ');

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
  /*
   * 哪幾列的「使用說明」展開了（2026-09-18 使用者選的乙案）。
   *
   * ★ 用 id 當 key，不是用索引 —— 換一次篩選索引就全對不上，
   *   而症狀是「我點的是 A，展開的是 B」。
   */
  const [open, setOpen] = useState<Record<string, true>>({});

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
    if (!title) return onMsg('「檔案名稱」要填。', true);

    /* 新增時一定要有檔案 —— 沒檔案的「檔案下載」是一顆按了沒反應的鈕 */
    if (!d.id && !d.file) return onMsg('要選一個檔案（PDF 或 Word）。', true);

    let path: string | null = null;
    let oldPath: string | null = null;

    if (d.file) {
      const big = fileTooBig(d.file.size);
      if (big.bad) return onMsg(big.why, true);
      if (fileKind(d.file.name) === 'other') {
        return onMsg('這種檔案收不了。可以傳：' + ACCEPT_FULL, true);
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
      /*
       * ★ 空的存 null，不要存空字串 —— 「沒有使用說明」只能有一種形狀，
       *   不然畫面要判兩次（migration_276 的註解寫了同一件事）。
       */
      usage_note: d.usage_note.trim() || null,
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
      return onMsg('沒有存進去 —— 你的帳號沒有上傳檔案的權限。', true);
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
    /*
     * ★★★ 這裡**沒有 `confirm()`**（2026-09-18 使用者:「不要那麼容易被刪掉」）。
     *   瀏覽器的 confirm **按 Enter 就過了**。擋在前面的是編輯視窗裡
     *   那一段:要點紅字展開、**要把檔案名稱打一次**
     *   （`lib/confirm-delete.ts`，有測試）。
     */
    const { data, error } = await supabase.from('board_forms')
      .delete().eq('id', f.id).select('id');
    if (error) return onMsg('刪不掉：' + error.message, true);
    if (!data?.length) return onMsg('沒有刪掉 —— 你的帳號沒有這個權限。', true);
    if (f.file_path) {
      const rm = await supabase.storage.from(BUCKET).remove([f.file_path]);
      if (rm.error) console.warn('[board] 檔案沒刪掉：', rm.error.message);
    }
    setDraft(null);
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
                       hover:bg-mor-slatedark">＋ 檔案上傳</button>
        )}
        <input value={q} onChange={(e) => setQ(e.target.value)}
          placeholder="關鍵字找檔案..."
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
              ? '還沒有任何檔案 —— 按上面的「＋ 檔案上傳」。'
              : '還沒有任何檔案。要放請假單、報帳單這些的話，請會計或主管上傳。'}
        </div>
      )}

      {!loading && rows.length > 0 && (
        <div className="rounded-xl border border-mor-line bg-white overflow-hidden">
          {rows.map((f) => {
            const cat = parseFormCat(f.category);
            const k = fileKind(f.file_name ?? '');
            const has = formHasFile(f);
            return (
              <div key={f.id} className="border-t border-mor-line/60 first:border-t-0">
              {/*
                ══════════════════════════════════════════════
                一列的骨架（2026-09-18 使用者過審的最終版）——
                **跟會計報表那一頁一模一樣**，兩頁就是同一種列。
                ══════════════════════════════════════════════
                　圖示 ／ 內容(封頂 30rem) ／ 下載 ／ 彈性空白 ／ 編輯
                　由上往下四行:標題 → 簡單說明 → 使用說明 ▸ → 檔案的資料。

                ★★★ 2026-09-18 使用者:「說明放第三行 / 簡單說明是副標 前面不用打說明」。
                  原本「使用說明 ▸」是接在副標**後面**的 —— 兩件不同的東西擠在同一行，
                  副標長一點就把那顆鈕推出畫面外，而它是唯一可以點的東西。
              */}
              <div className="grid items-center gap-y-0.5 gap-x-3 md:gap-x-5 px-4 py-2.5
                              hover:bg-[#FAFAF9] transition-colors
                              [grid-template-columns:2.25rem_minmax(0,1fr)_auto]
                              [grid-template-areas:'ico_mid_mid'_'ico_note_note'_'ico_use_use'_'ico_file_file'_'._dl_acts']
                              md:[grid-template-columns:2.25rem_minmax(0,1fr)_16rem_auto_auto]
                              md:[grid-template-areas:'ico_mid_file_dl_acts'_'ico_note_note_dl_acts'_'ico_use_use_dl_acts']">
                {/*
                  ★ 用副檔名當圖示，一眼看得出是 Word 還是 PDF ——
                    下載之前就知道等一下要用什麼開。
                */}
                <span className={`w-9 h-9 rounded-lg flex items-center justify-center self-start mt-0.5
                                  text-[11px] font-bold text-white [grid-area:ico] ${BADGE_BG[k]}`}>
                  {FILE_BADGE[k]}
                </span>

                {/*
                  ★ 每一段各自一整排（2026-09-18 使用者:「資訊獨立一排」
                    「使用說明 獨立一行」）—— 擠成一行的話讀起來像壞掉的。
                */}
                {/*
                  ★★★ 分類籤畫在**標題前面**（2026-09-18 使用者過審）——
                    跟會計報表的「月報」「401」同一個位置。
                  ★★ 標題是這一列唯一要「認出來」的東西，所以它是**唯一的黑字**;
                    底下那幾行一律灰的（2026-09-18 排字體）。
                */}
                <span className="min-w-0 flex items-center gap-1.5 [grid-area:mid]">
                  <span className="shrink-0 rounded px-1.5 py-0.5 text-xs font-medium
                                   bg-mor-bluelight text-mor-slatedark">
                    {formIcon(cat)} {cat}
                  </span>
                  <span className="text-ui font-semibold truncate">{f.title}</span>
                </span>

                {/*
                  ★★★ 沒有檔案的那幾筆，鈕**不畫成「下載」** ——
                    畫了就是一顆按了沒反應的鈕，而使用者的結論是系統壞了。
                  ★ 綠框不是實心（2026-09-18 使用者:「綠框好了」）。
                */}
                <button onClick={() => download(f)} disabled={busyId === f.id}
                  title={has ? '下載' : '這一份還沒有檔案'}
                  className={`h-11 md:h-10 rounded-lg border px-4 text-uisub font-medium mt-2 md:mt-0
                              justify-self-stretch md:justify-self-end
                              [grid-area:dl] disabled:opacity-50 ${
                    has ? 'border-mor-greendark text-mor-greendark hover:bg-mor-greenlight'
                        : 'border-amber-300 text-amber-700 bg-amber-50'}`}>
                  {busyId === f.id ? '準備中⋯' : has ? '↓ 下載' : '沒有檔案'}
                </button>

                {/*
                  ★★★ 列上**只剩「編輯」**（2026-09-18 使用者:「檔案下載 也把刪除放進 編輯」）。
                    刪掉在編輯視窗最底下，而且要把檔案名稱打一次才按得下去。
                */}
                {canEdit && (
                  <span className="[grid-area:acts] self-center mt-2 md:mt-0 pl-3 md:pl-0">
                    <button onClick={() => setDraft({
                      id: f.id, title: f.title, category: parseFormCat(f.category),
                      note: f.note ?? '', usage_note: f.usage_note ?? '',
                      file: null, oldName: f.file_name,
                    })} className="text-uisub text-gray-400 hover:text-mor-slate">編輯</button>
                  </span>
                )}

                {/*
                  ★★★ 第二行:簡單說明，**自己一行、橫跨整列**（2026-09-18 使用者選的甲）。
                    有 870px —— 擠在上面那一欄只有 30rem，稍長就被截成「⋯」，
                    而說明是自由輸入的，多長都有可能。
                  ★★ 「說明」兩個字的標籤拿掉了（2026-09-18 使用者:「簡單說明是副標
                    前面不用打說明」）—— 它就在標題底下，**位置本身已經說了它是副標**，
                    再寫兩個字只是把每一列都多印一次同樣的東西。
                  ★ 沒有就整段不畫，那一列的高度一格都不會變。
                */}
                {f.note?.trim() && (
                  <span className="[grid-area:note] min-w-0 truncate text-sm text-gray-500">
                    {f.note.trim()}
                  </span>
                )}

                {/*
                  ★★★ 第三行:「使用說明」自己一行（2026-09-18 使用者:「說明放第三行」）。
                  ★★ 箭頭**收起來時向右 ▸、展開之後向下 ▾**（使用者指定）——
                    向右是「這裡面還有東西，點開」，向下是「已經開了，就在下面」。
                    兩種狀態長得一樣的話，那顆箭頭就沒有在報告任何事。
                  ★ **有內容才畫** —— 沒有內容還畫的話，那是一顆點了什麼都不會發生的鈕。
                */}
                {f.usage_note?.trim() && (
                  <span className="[grid-area:use] min-w-0">
                    <button onClick={() => setOpen((p) => {
                      const n = { ...p };
                      if (n[f.id]) delete n[f.id]; else n[f.id] = true;
                      return n;
                    })}
                      className="text-sm text-mor-slate hover:text-mor-slatedark">
                      使用說明 {open[f.id] ? '▾' : '▸'}
                    </button>
                  </span>
                )}

                {/*
                  ★★★ 檔案的資料放**最下面**（2026-09-18 使用者:「檔案 資料最下面」）——
                    跟會計報表那一頁同一個順序。
                    這一列由上往下讀是:這是什麼 → 說明 → **最後才是這個檔案本身**。
                  ★★ 日期印**年月日**、西元（2026-09-18 使用者:「顯示年月日」＋選了甲）。
                    這一頁的檔案會放好幾年，只寫 09/18 的話，
                    明年再看就分不出是今年傳的還是去年傳的。
                */}
                <span className="[grid-area:file] min-w-0 truncate text-xs text-gray-400 tabular-nums">
                  {names.get(f.updated_by ?? f.created_by ?? '') ?? '—'}
                  {'　·　'}{f.updated_at.slice(0, 10).replace(/-/g, '/')}
                  {f.file_size ? `　·　${fmtSize(f.file_size)}` : ''}
                </span>
              </div>

              {/*
                ★ 展開的內容縮排到跟標題對齊（左邊讓出圖示的寬度），
                  用虛線隔開 —— 實線會看起來像兩個不同的區塊（anxing-ui 二-7）。
                ★★ `whitespace-pre-wrap` 不能省:使用者打的換行要留著，
                  不然「① ② ③」會全部黏成一段。
              */}
              {open[f.id] && (
                <div className="px-4 pb-3 pl-[3.25rem] text-uisub text-gray-600 leading-relaxed
                                whitespace-pre-wrap border-t border-dashed border-mor-line pt-2.5">
                  {f.usage_note}
                </div>
              )}
              </div>
            );
          })}
        </div>
      )}

      {draft && (
        <FormDialog draft={draft} onChange={setDraft}
          onClose={() => setDraft(null)} onSave={save}
          /* ★ 新增的時候沒有東西可以刪 —— 整段不畫，不是灰掉 */
          /*
           * ★ 新增的時候沒有東西可以刪 —— 整段不畫，不是灰掉。
           * ★★ 從清單裡撈**那一筆原始資料**，不要拿 `draft` 拼一個假的 ——
           *   `del()` 要用 `file_path` 去清儲存桶，而 `draft` 沒有那一欄。
           *   拼一個 `file_path: null` 進去的話，資料列刪掉了、檔案留在桶子裡，
           *   而且**不會有任何地方叫**。
           */
          onDelete={(() => {
            const f = draft.id ? list.find((x) => x.id === draft.id) : null;
            return f ? () => del(f) : null;
          })()} />
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════ */

function FormDialog({ draft, onChange, onClose, onSave, onDelete }: {
  draft: Draft;
  onChange: (d: Draft) => void;
  onClose: () => void;
  onSave: (d: Draft) => Promise<void> | void;
  /** 只有編輯既有的那一份才有 —— 新增時沒有東西可以刪 */
  onDelete: (() => Promise<void> | void) | null;
}) {
  const [save, saving] = useOnce(async () => { await onSave(draft); });
  const [over, setOver] = useState(false);
  const [fileErr, setFileErr] = useState<string | null>(null);

  /*
   * 收下一個檔案（點選的、拖進來的都走這一支）。
   *
   * ★★★ **擋在這裡，不是等到按儲存**（2026-09-18）——
   *   拖了一個 .zip 進來，要到按下儲存才說收不了的話，
   *   中間他已經把標題、分類、說明全部打完了。
   * ★ 錯誤留在這個框旁邊，不要丟到頁面最上方（CLAUDE.md 2026-09-02:
   *   訊息要出現在動作發生的地方）。
   */
  const take = (fs: FileList | null) => {
    const f = fs?.[0];
    if (!f) return;
    if (fileKind(f.name) === 'other') {
      return setFileErr('這種檔案收不了。可以傳：' + ACCEPT_FULL);
    }
    const big = fileTooBig(f.size);
    if (big.bad) return setFileErr(big.why);
    setFileErr(null);
    onChange({ ...draft, file: f });
  };

  /*
   * ══════════════════════════════════════════════════════════
   * 刪掉（2026-09-18 使用者:「檔案下載 也把刪除放進 編輯」「不要那麼容易被刪掉」）
   * ══════════════════════════════════════════════════════════
   * 跟會計報表那一頁**一模一樣**，只有要打的字不同（這裡是檔案名稱）。
   * 判斷式在 `lib/confirm-delete.ts`（有測試）—— 這裡只負責畫。
   */
  const [delOpen, setDelOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const delTarget = draft.title?.trim() ?? '';
  const delBad = whyDeleteBlocked(typed, delTarget);
  const [doDelete, deleting] = useOnce(async () => {
    /* ★★ 再擋一次 —— 畫面那一層灰掉了，但這一支是真的會刪東西的 */
    if (!deleteMatches(typed, delTarget) || !onDelete) return;
    await onDelete();
  });
  const pick = useRef<HTMLInputElement>(null);
  const bad = !draft.title.trim() || (!draft.id && !draft.file);

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative bg-white w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl shadow-xl
                      max-h-[92vh] sm:max-h-[85vh] overflow-y-auto">
        <div className="sticky top-0 bg-white px-5 py-3.5 border-b border-mor-line font-bold text-ui
                        flex items-center justify-between">
          {draft.id ? '編輯檔案' : '檔案上傳'}
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
              onChange={(e) => { take(e.target.files); e.target.value = ''; }} />
            {/*
              ★★★ `onDragOver` 一定要 preventDefault —— 不擋的話瀏覽器會
                **直接用新分頁打開那個檔案**，而對話框裡填一半的東西全部不見。
              ★★ `onDragEnter` 也要 —— 只擋 over 的話，某些瀏覽器在進入的
                那一瞬間就已經接手了。
              ★ 這一段跟會計報表那一頁**一模一樣**（2026-09-18 使用者:「無法拖拉耶」）。
                那邊早就能拖，這邊漏了 —— 同一個功能在兩頁不一樣，
                使用者的結論是「這個系統有時候可以有時候不行」。
            */}
            <button onClick={() => pick.current?.click()}
              onDragOver={(e) => { e.preventDefault(); setOver(true); }}
              onDragEnter={(e) => { e.preventDefault(); setOver(true); }}
              onDragLeave={() => setOver(false)}
              onDrop={(e) => { e.preventDefault(); setOver(false); take(e.dataTransfer.files); }}
              className={`rounded-lg border-[1.5px] border-dashed px-4 py-5 text-center transition-colors ${
                over ? 'border-mor-slate bg-mor-bluelight border-2'
                     : draft.file ? 'border-mor-greendark bg-mor-greenlight'
                                  : 'border-mor-line bg-[#FAFAF9] hover:border-mor-slate'}`}>
              {draft.file ? (
                <>
                  <span className="block text-ui text-mor-greendark break-all">{draft.file.name}</span>
                  <span className="block text-xs text-gray-500 mt-0.5">
                    {fmtSize(draft.file.size)}・點一下換別份
                  </span>
                </>
              ) : over ? (
                <span className="block text-ui text-mor-slatedark font-medium">放開就放進來</span>
              ) : (
                <>
                  <span className="block text-ui text-mor-slate">把檔案拖進來，或點一下選擇</span>
                  <span className="block text-xs text-gray-400 mt-0.5">{ACCEPT_HINT}</span>
                </>
              )}
            </button>
            {/* ★★ 錯誤留在這個框旁邊，不要丟到頁面最上方（CLAUDE.md 2026-09-02） */}
            {fileErr && <span className="text-xs text-red-600">{fileErr}</span>}
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
              檔案名稱<span className="text-red-500 ml-0.5">*</span>
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

          {/*
            使用說明（2026-09-18 使用者選的乙案）。
            ★ 跟上面那格「說明」是**兩件事**:
              說明　　一行，列上一直看得到，回答「這是什麼」
              使用說明 一段，收起來，回答「怎麼填、填完交給誰」
            ★★ 用 textarea 不是 input —— 換行要留得住。
          */}
          <label className="flex flex-col gap-1">
            <span className="text-uisub text-gray-500">使用說明（怎麼填、填完交給誰）</span>
            <textarea value={draft.usage_note} rows={5}
              onChange={(e) => onChange({ ...draft, usage_note: e.target.value })}
              placeholder={'沒有發票或收據的支出才用這一份。\n① 填寫金額、用途、日期\n② 找主管簽名\n③ 掃描後連同支出一起送會計'}
              className="rounded-lg border border-mor-line px-3 py-2 text-ui leading-relaxed" />
            <span className="text-xs text-gray-400">留空就不會出現那顆「使用說明 ▸」。</span>
          </label>

          <div className="text-xs text-gray-400 leading-relaxed">
            全公司都下載得到（含房務）。只有總經理、會計、主管可以上傳與換檔案。
          </div>

          {/*
            ══════════════════════════════════════════════════
            刪掉這一份（2026-09-18 使用者過審）——
            **跟會計報表那一頁同一種做法**，只有字不同。
            ══════════════════════════════════════════════════
            ★★★ 不跟「取消／儲存」排同一排:那一排讀起來會變成
              「毀掉它／算了／存起來」，而人進這個視窗是為了改東西然後存檔
              （anxing-ui 四-3）。
            ★★ 三道關:① 先進這個視窗 ② 點那行紅字 ③ 把檔案名稱打一次。
              原本是列上一顆鈕 ＋ 瀏覽器的 `confirm()`，而那個 **按 Enter 就過了**。
          */}
          {onDelete && (
            <div className="border-t border-mor-line pt-3">
              {!delOpen ? (
                <div className="text-center">
                  <button onClick={() => setDelOpen(true)}
                    className="text-xs text-red-400 underline hover:text-red-600">
                    刪掉這一份檔案
                  </button>
                </div>
              ) : (
                <div className="rounded-xl border border-red-200 bg-red-50 p-3">
                  <div className="text-xs font-bold text-red-700 leading-relaxed">
                    ⚠ 刪掉之後<b>救不回來</b> —— 檔案會一起不見。
                  </div>
                  <div className="mt-1.5 text-xs text-red-900 leading-relaxed">
                    確定的話，把檔案名稱打一次：
                    <span className="block mt-1 w-fit rounded border border-red-200 bg-white
                                     px-2 py-0.5 font-mono text-mor-ink">{delTarget || '（沒有名稱）'}</span>
                  </div>
                  <input value={typed} onChange={(e) => setTyped(e.target.value)}
                    placeholder="把上面那一行打進來"
                    className="mt-2 h-11 md:h-10 w-full rounded-lg border border-red-200 bg-white
                               px-3 text-ui" />
                  <div className="mt-2 flex gap-2">
                    <button onClick={() => { setDelOpen(false); setTyped(''); }}
                      className="flex-1 h-11 md:h-10 rounded-lg border border-mor-line text-uisub">算了</button>
                    {/* ★ 灰掉要說得出為什麼 —— 底下那一行就是（anxing-ui 二-6） */}
                    <button onClick={doDelete} disabled={!!delBad || deleting} title={delBad ?? ''}
                      className="flex-1 h-11 md:h-10 rounded-lg border border-red-300 text-uisub
                                 text-red-600 enabled:hover:bg-red-600 enabled:hover:text-white
                                 disabled:opacity-40">
                      {deleting ? '刪除中⋯' : '刪掉'}</button>
                  </div>
                  <div className="mt-1.5 text-center text-xs text-gray-400">
                    {delBad ?? DELETE_READY}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="sticky bottom-0 bg-white px-5 py-3 border-t border-mor-line flex justify-end gap-2">
          <button onClick={onClose}
            className="h-11 md:h-10 rounded-lg border border-mor-line px-5 text-uisub">取消</button>
          {/* ★ 灰掉要說得出為什麼（anxing-ui 二-6） */}
          <button onClick={save} disabled={saving || bad}
            title={!draft.title.trim() ? '「檔案名稱」要填'
                 : (!draft.id && !draft.file) ? '要先選一個檔案' : ''}
            className="h-11 md:h-10 rounded-lg bg-mor-slate text-white px-5 text-uisub font-medium
                       hover:bg-mor-slatedark disabled:opacity-50">
            {saving ? '上傳中⋯' : draft.id ? '儲存' : '上傳'}</button>
        </div>
      </div>
    </div>
  );
}
