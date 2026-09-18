'use client';
/**
 * 會計報表（2026-09-18 使用者指定，migration_275）。
 *
 *   「多一個 叫 會計報表 / 會計可上傳 月報 401報表 /
 *     檔案形式 PDF excel word / 參考 這個（表單下載）/
 *     權限：會計 主管 總經理 可以來讀 / 種類 月報 401 其他 /
 *     日期 期別 種類 / 401 兩月一期」
 *   「401 可以選 之後月份嗎 可以 dropdown 自己選 不用再新增」
 *   「還是有標題 可以自己輸入」「下載檔案 和標題一樣」
 *
 * ══════════════════════════════════════════════════════════
 * 【★★★ 跟「表單下載」不一樣的地方】
 *
 *   表單下載　看：全公司，含房務　　　改：總經理・會計・主管
 *   會計報表　看：總經理・會計・主管　改：同一組
 *
 * ★ 所以側欄那一項對房務與管家**整項不出現**（layout.tsx 的 roles）——
 *   畫一個點進去說「沒有權限」的選項，等於每天提醒他有個地方他進不去。
 * ★★ 真正擋住的是 RLS（`can_use_accounting_reports()`），不是這裡。
 *
 * ══════════════════════════════════════════════════════════
 * 【★★★ 期別存一支欄位，中文是算出來的】
 *
 * 算式全部在 `lib/report.ts`（有測試）—— 寫在這支 `.tsx` 裡的話測不到，
 * 而「401 標成 5-6 月」這種錯**不會報錯**，兩年後才會有人發現。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase';
import { useOnce } from '@/lib/once';
import { fmtSize, fileTooBig } from '@/lib/board';
import {
  REPORT_KINDS, parseKind, periodText, options401, defaultStartFor,
  monthToStart, startToMonth, validateReport, suggestTitle, reportTitle,
  sortReports, yearOf, matchReport, fileLine, metaLine,
  reportFileKind, FILE_BADGE, reportFileName, REPORT_ACCEPT,
  type Report,
} from '@/lib/report';

const BUCKET = 'accounting-reports';

type Row = Report & { id: string };

type Draft = Report & {
  /** 新選的檔案。編輯時留 null ＝ 不換檔案 */
  file: File | null;
  oldName?: string | null;
  /**
   * 使用者自己動過標題了沒。
   *
   * ★★ 動過就**不要再覆蓋** —— 換一次期別就把他打的字蓋掉，
   *   是最惱人的那種 bug（暫付頁的收款帳戶同一條規矩）。
   */
  titleTouched?: boolean;
};

const CTRL = 'h-11 md:h-10 rounded-lg border border-mor-line px-3 text-ui bg-white w-full';

const KIND_CLASS: Record<string, string> = {
  月報: 'bg-mor-bluelight text-mor-slatedark',
  '401': 'bg-violet-50 text-violet-700',
  其他: 'bg-mor-sand text-gray-600',
};
const BADGE_CLASS: Record<string, string> = {
  pdf: 'bg-red-600', excel: 'bg-mor-greendark', word: 'bg-blue-600', other: 'bg-gray-400',
};

const blank = (): Draft => ({
  kind: '401', period_start: defaultStartFor('401'),
  title: suggestTitle('401', defaultStartFor('401')),
  /* ★ 申報日預設空的 —— 剛傳上來的那一刻通常還沒申報 */
  filed_on: '', note: '', file: null,
});

export default function ReportsPage() {
  const supabase = useMemo(() => createClient(), []);
  const [rows, setRows] = useState<Row[]>([]);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<{ t: string; err?: boolean } | null>(null);
  const [q, setQ] = useState('');
  const [fk, setFk] = useState('');
  const [fy, setFy] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  /*
   * ★★★ 現在登入的是誰。**不抓的話 `created_by` 永遠是 null** ——
   *   而列上「誰傳的」那一格就會一直是空的
   *   （2026-09-18 使用者圈著它問「第一個空白是甚麼？」）。
   */
  const [meId, setMeId] = useState<string | null>(null);
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setMeId(data.user?.id ?? null));
  }, [supabase]);

  const onMsg = useCallback((t: string, err?: boolean) => {
    setMsg({ t, err });
    if (!err) setTimeout(() => setMsg(null), 4000);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    const [{ data, error }, { data: pf }] = await Promise.all([
      supabase.from('accounting_reports').select('*'),
      supabase.from('profiles').select('id, name'),
    ]);
    if (error) onMsg('讀不到報表：' + error.message, true);
    setRows((data ?? []) as Row[]);
    setNames(new Map((pf ?? []).map((p) => [p.id as string, p.name as string])));
    setLoading(false);
  }, [supabase, onMsg]);

  useEffect(() => { load(); }, [load]);

  /* ══════════════ 下載 ══════════════ */

  /**
   * ★★★ 用 `download()` 抓成 blob，不是 `createSignedUrl(..., {download})`。
   *
   *   那條路會把檔名塞進 HTTP 的 content-disposition，而**中文在那裡沒有
   *   被正確編碼** —— 使用者下載下來看到 `æ¯åºè­æå®.docx`
   *   （2026-09-18 表單下載那邊回報的）。
   *
   *   `<a download="115年 7-8月.pdf">` 是純文字，中文不會壞。
   */
  const download = async (r: Row) => {
    if (!r.file_path) return onMsg('這一份還沒有檔案。', true);
    setBusyId(r.id);
    const { data, error } = await supabase.storage.from(BUCKET).download(r.file_path);
    setBusyId(null);
    if (error || !data) return onMsg('下載不了：' + (error?.message ?? '拿不到檔案'), true);
    const url = URL.createObjectURL(data);
    const a = document.createElement('a');
    a.href = url;
    a.download = reportFileName(r);     // ★ 就是標題（使用者指定）
    document.body.appendChild(a);
    a.click();
    a.remove();
    /* ★ 立刻 revoke 會讓某些瀏覽器抓不到，等一下再放 */
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  /* ══════════════ 存檔 ══════════════ */

  const save = async (d: Draft) => {
    const err = validateReport(d);
    if (err) return onMsg(err, true);
    if (!d.id && !d.file) return onMsg('要選一個檔案（PDF、Excel 或 Word）。', true);

    /*
     * ══════════════════════════════════════════════════════════
     * 【★★★ 不再問「已經有一份了，要換掉嗎」】（2026-09-18「開放多個」）
     *
     * 原本同一期傳第二份會跳一句確認。使用者:
     * 「401 可以重複上傳」「會有不同公司」「月報 401 不必一對一」「開放多個」。
     *
     * 同一期的 401，正隆一份、愛皮一份、洪鯊一份 —— **每一份都是對的**，
     * 每次都問一句只是擋路。要換掉舊的就在那一列按「編輯」。
     *
     * ★ 資料庫那條唯一索引也拿掉了（migration_279）。
     * ══════════════════════════════════════════════════════════
     */
    const targetId = d.id;

    let path: string | null = null;
    let oldPath: string | null = null;

    if (d.file) {
      const big = fileTooBig(d.file.size);
      if (big.bad) return onMsg(big.why, true);
      if (reportFileKind(d.file.name) === 'other') {
        return onMsg('只收 PDF、Excel 與 Word（.pdf .xls .xlsx .doc .docx）。', true);
      }
      /* ★ 路徑帶時間戳 —— 同名檔案換兩次不會互相蓋掉 */
      const safe = d.file.name.replace(/[^\w.\-]+/g, '_');
      path = `${Date.now()}_${safe}`;
      const up = await supabase.storage.from(BUCKET).upload(path, d.file);
      if (up.error) return onMsg('檔案傳不上去：' + up.error.message, true);
      if (targetId) oldPath = rows.find((x) => x.id === targetId)?.file_path ?? null;
    }

    const body: Record<string, unknown> = {
      kind: parseKind(d.kind),
      period_start: d.period_start || null,
      title: d.title.trim(),
      /*
       * ★★ 申報日是**人填的**，空的就存 null（不是空字串）——
       *   `date` 欄位收到 '' 會直接爆 `invalid input syntax for type date`。
       * ★ 這裡不自動帶今天:上傳日回答「檔案什麼時候進來」可以自動，
       *   申報日回答「什麼時候送出去」，猜不得（README:對不上的不猜）。
       */
      filed_on: d.filed_on || null,
      note: d.note?.trim() || null,
      updated_at: new Date().toISOString(),
      updated_by: meId,
    };
    if (d.file && path) {
      body.file_path = path;
      body.file_name = d.file.name;
      body.file_size = d.file.size;
      /*
       * ★★★ 上傳日**自動帶**（2026-09-18 使用者:「不用上傳日，自動吃」）。
       *   只在真的換了檔案時更新 —— 改個標題不該讓上傳日跳到今天，
       *   那個日期回答的是「這份檔案什麼時候進來的」。
       * ★ 用本地時間組，不要 `toISOString()` —— 那是 UTC，
       *   台灣時間晚上八點之後會變成前一天（README 的 todayStr 同一件事）。
       */
      const t = new Date();
      body.uploaded_on = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}`
        + `-${String(t.getDate()).padStart(2, '0')}`;
    }
    if (!targetId) body.created_by = meId;

    /*
     * ★★★ `.select('id')` 不能省。RLS 擋下來的寫入**回成功且影響 0 列**，
     *   不是錯誤（README）。只接 error 的話，畫面說存好了、重整什麼都沒有。
     */
    const { data, error } = targetId
      ? await supabase.from('accounting_reports').update(body).eq('id', targetId).select('id')
      : await supabase.from('accounting_reports').insert(body).select('id');

    if (error || !data?.length) {
      /* ★ 寫不進去的話，剛剛傳上去的那個檔要清掉 —— 不然 bucket 裡會留孤兒 */
      if (path) await supabase.storage.from(BUCKET).remove([path]);
      if (error) return onMsg((targetId ? '存不起來：' : '建不起來：') + error.message, true);
      return onMsg('沒有存進去 —— 你的帳號沒有上傳報表的權限。', true);
    }

    /* ★ 舊檔最後才刪。先刪的話，新檔傳失敗就兩個都沒了 */
    if (oldPath && oldPath !== path) {
      const rm = await supabase.storage.from(BUCKET).remove([oldPath]);
      if (rm.error) console.warn('[reports] 舊檔沒刪掉：', rm.error.message);
    }
    setDraft(null);
    onMsg('已儲存');
    load();
  };

  const del = async (r: Row) => {
    if (!confirm(`刪掉「${reportTitle(r)}」？\n\n檔案會一起不見，而且救不回來。`)) return;
    const { data, error } = await supabase.from('accounting_reports')
      .delete().eq('id', r.id).select('id');
    if (error) return onMsg('刪不掉：' + error.message, true);
    if (!data?.length) return onMsg('沒有刪掉 —— 你的帳號沒有這個權限。', true);
    if (r.file_path) {
      const rm = await supabase.storage.from(BUCKET).remove([r.file_path]);
      if (rm.error) console.warn('[reports] 檔案沒刪掉：', rm.error.message);
    }
    load();
  };

  /* ══════════════ 篩選 ══════════════ */

  /* ★ 年度是**從資料長出來的**，不是一份要維護的清單 */
  const years = useMemo(
    () => [...new Set(rows.map(yearOf).filter(Boolean))].sort().reverse(), [rows]);

  const shown = useMemo(() => sortReports(rows).filter((r) =>
    (!fk || parseKind(r.kind) === fk)
    && (!fy || yearOf(r) === fy)
    && matchReport(r, q)) as Row[], [rows, fk, fy, q]);

  return (
    <div>
      <h1 className="mb-3">會計報表</h1>

      {msg && (
        <div className={`mb-3 rounded-lg px-4 py-3 text-sm flex items-start gap-2 ${
          msg.err ? 'bg-red-50 border border-red-200 text-red-700'
                  : 'bg-mor-greenlight text-mor-greendark'}`}>
          <span className="shrink-0">{msg.err ? '⚠' : '✓'}</span>
          <span className="flex-1">{msg.t}</span>
          <button onClick={() => setMsg(null)} className="text-xs underline shrink-0">關閉</button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 mb-3">
        <button onClick={() => setDraft(blank())}
          className="h-11 md:h-10 rounded-lg bg-mor-slate text-white px-4 text-ui font-medium
                     hover:bg-mor-slatedark">＋ 上傳報表</button>
        <input value={q} onChange={(e) => setQ(e.target.value)}
          placeholder="關鍵字找報表..."
          className="h-11 md:h-10 rounded-lg border border-mor-line px-3 text-ui flex-1 min-w-[170px]" />
        <span className="text-uisub text-gray-500 whitespace-nowrap">
          共 <b className="text-mor-ink">{shown.length}</b> 份
        </span>
      </div>

      {/*
        ★ 藥丸:點一下開、再點一下清除。上排種類、下排年度，兩排之間是「且」。
          一顆都沒亮就是沒有篩選 —— 不用另外做一顆「全部」（anxing-ui 四-1）。
        ★★ 數字算在**套這顆之前**的清單上，不然按下去數字就不再變。
      */}
      <div className="flex flex-wrap gap-1.5 mb-2">
        {REPORT_KINDS.map((k) => {
          const n = rows.filter((r) => parseKind(r.kind) === k && (!fy || yearOf(r) === fy)).length;
          return (
            <button key={k} onClick={() => setFk(fk === k ? '' : k)}
              className={`rounded-full border px-3 py-1.5 text-uisub ${
                fk === k ? 'bg-mor-slate border-mor-slate text-white font-medium'
                         : 'bg-white border-mor-line text-gray-600'}`}>
              {k}　{n}
            </button>
          );
        })}
      </div>
      {years.length > 1 && (
        <div className="flex flex-wrap gap-1.5 mb-3">
          {years.map((y) => (
            <button key={y} onClick={() => setFy(fy === y ? '' : y)}
              className={`rounded-full border px-3 py-1.5 text-uisub ${
                fy === y ? 'bg-mor-slate border-mor-slate text-white font-medium'
                         : 'bg-white border-mor-line text-gray-600'}`}>
              {Number(y) - 1911} 年
            </button>
          ))}
        </div>
      )}

      {loading && <div className="text-uisub text-gray-400 py-10 text-center">載入中…</div>}

      {!loading && !shown.length && (
        <div className="rounded-xl border border-mor-line bg-white py-14 text-center text-ui text-gray-400">
          {rows.length ? '這個篩選沒有報表' : '還沒有報表 —— 按上面的「＋ 上傳報表」。'}
        </div>
      )}

      {!loading && shown.length > 0 && (
        <div className="rounded-xl border border-mor-line bg-white overflow-hidden">
          {shown.map((r) => {
            const k = parseKind(r.kind);
            const fkd = reportFileKind(r.file_name);
            const per = periodText(r.kind, r.period_start);
            return (
              <div key={r.id}
                className="flex items-start gap-2.5 px-4 py-3 border-t border-mor-line/60 first:border-t-0">
                <span className={`w-9 h-9 shrink-0 rounded-lg flex items-center justify-center
                                  text-[11px] font-bold text-white ${BADGE_CLASS[fkd]}`}>
                  {FILE_BADGE[fkd]}
                </span>

                <span className="flex-1 min-w-0 block">
                  {/*
                    ★ 種類那顆籤畫在**標題前面**（2026-09-18 使用者:「放到表頭」）——
                      一眼看得出這一列是哪一種，不用往右找。
                  */}
                  <span className="block">
                    <span className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium mr-1.5
                                      align-middle ${KIND_CLASS[k] ?? ''}`}>{k}</span>
                    <span className="text-ui font-medium align-middle">{reportTitle(r)}</span>
                  </span>
                  {/*
                    ★ 標題跟期別一樣的話不重複寫一次（README:重複的數字不要寫第二次）——
                      使用者改過標題時才把期別補在底下。
                  */}
                  {/*
                    第二行:期別 ＋ 備註。
                    ★ 標題跟期別一樣時不重複寫（README:重複的數字不要寫第二次）。
                    ★★ 「（沒填上傳日）」那句拿掉了 —— 上傳日現在自動帶，
                      沒有「忘了填」這回事，印出來只是噪音。
                  */}
                  {(() => {
                    /*
                      ★★★ 第二行講的是**這份報表本身**:哪一期、什麼時候送出去的、備註
                        （2026-09-18 使用者:「申報 和 備註 資訊放一起」）。
                        檔案的事（誰傳的、多大、什麼時候進來）在第三行。
                      ★ 標題跟期別一樣時不重複寫（README:重複的數字不要寫第二次）。
                    */
                    const line = metaLine({
                      period: per && per !== reportTitle(r) ? per : '',
                      filedOn: r.filed_on,
                      note: r.note,
                    });
                    return line
                      ? <span className="block text-uisub text-gray-500 truncate">{line}</span>
                      : null;
                  })()}
                  {/*
                    第三行:誰傳的・檔名・大小・上傳日。
                    ★★ 申報日**不在這裡** —— 它跟期別、備註同一類,在上面那一行
                      (2026-09-18 使用者:「申報 和 備註 資訊放一起」)。
                    ★ 排法在 `fileLine`（lib，有測試）—— 空的那幾段整段不見，
                      不是留一個講不出自己是什麼的「—」。
                  */}
                  {(() => {
                    const line = fileLine({
                      who: names.get(r.updated_by ?? r.created_by ?? '') ?? '',
                      fileName: r.file_name,
                      size: r.file_size ? fmtSize(r.file_size) : '',
                      uploadedOn: r.uploaded_on,
                    });
                    return line
                      ? <span className="block text-xs text-gray-400 truncate">{line}</span>
                      : null;
                  })()}
                </span>

                <button onClick={() => setDraft({
                  ...r, file: null, oldName: r.file_name, titleTouched: true,
                  uploaded_on: r.uploaded_on ?? '', filed_on: r.filed_on ?? '',
                  note: r.note ?? '',
                })} className="shrink-0 mt-1 text-uisub text-mor-slate hover:text-mor-slatedark">編輯</button>
                <button onClick={() => del(r)}
                  className="shrink-0 mt-1 text-uisub text-red-400 hover:text-red-600">刪掉</button>

                {/*
                  ★★★ 沒有檔案的那幾筆，鈕**不畫成「下載」** ——
                    畫了就是一顆按了沒反應的鈕，而使用者的結論是系統壞了。
                */}
                <button onClick={() => download(r)} disabled={busyId === r.id}
                  title={r.file_path ? '下載' : '這一份還沒有檔案'}
                  className={`shrink-0 h-10 rounded-lg border px-4 text-uisub font-medium
                              disabled:opacity-50 ${
                    r.file_path ? 'border-mor-greendark text-mor-greendark hover:bg-mor-greenlight'
                                : 'border-amber-300 text-amber-700 bg-amber-50'}`}>
                  {busyId === r.id ? '準備中⋯' : r.file_path ? '下載' : '沒有檔案'}
                </button>
              </div>
            );
          })}
        </div>
      )}

      {draft && (
        <ReportDialog draft={draft} onChange={setDraft}
          onClose={() => setDraft(null)} onSave={save} />
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════ */

function ReportDialog({ draft, onChange, onClose, onSave }: {
  draft: Draft;
  onChange: (d: Draft) => void;
  onClose: () => void;
  onSave: (d: Draft) => Promise<void> | void;
}) {
  const [save, saving] = useOnce(async () => { await onSave(draft); });
  const pick = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [fileErr, setFileErr] = useState<string | null>(null);

  const k = parseKind(draft.kind);
  const bad = validateReport(draft) ?? (!draft.id && !draft.file ? '要先選一個檔案' : null);

  /** 種類或期別換掉時，標題跟著建議 —— **但使用者自己打過就不覆蓋**。 */
  function retitle(next: Draft): Draft {
    if (next.titleTouched) return next;
    return { ...next, title: suggestTitle(next.kind, next.period_start) };
  }

  function take(files: FileList | null) {
    setFileErr(null);
    const list = Array.from(files ?? []);
    if (!list.length) return;
    /* ★ 一次只收一份，而且要講一句 —— 不講的話他以為三個都傳了 */
    if (list.length > 1) setFileErr(`一次一份，先放了「${list[0].name}」。`);
    const f = list[0];
    if (reportFileKind(f.name) === 'other') {
      return setFileErr(`「${f.name}」不是 PDF／Excel／Word，放不進去。`);
    }
    const big = fileTooBig(f.size);
    if (big.bad) return setFileErr(big.why);
    onChange({ ...draft, file: f });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative bg-white w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl shadow-xl
                      max-h-[92vh] sm:max-h-[85vh] overflow-y-auto">
        <div className="sticky top-0 bg-white px-5 py-3.5 border-b border-mor-line font-bold text-ui
                        flex items-center justify-between">
          {draft.id ? '編輯報表' : '上傳報表'}
          <button onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-xl leading-none">✕</button>
        </div>

        <div className="px-5 py-4 grid gap-3">
          {/* ── 檔案（拖拉或點選）── */}
          <div className="flex flex-col gap-1">
            <span className="text-uisub text-gray-500 flex items-center">
              檔案{!draft.id && <span className="text-red-500 ml-0.5">*</span>}
            </span>
            <input ref={pick} type="file" accept={REPORT_ACCEPT} className="hidden"
              onChange={(e) => take(e.target.files)} />
            {/*
              ★★★ `onDragOver` 一定要 preventDefault —— 不擋的話瀏覽器會
                **直接用新分頁打開那個檔案**，而對話框裡填一半的東西全部不見。
            */}
            <button
              onClick={() => pick.current?.click()}
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
                  <span className="block text-xs text-gray-400 mt-0.5">.pdf　.xls　.xlsx　.doc　.docx</span>
                </>
              )}
            </button>
            {/* ★★ 錯誤留在這個框旁邊，不要丟到頁面最上方（README 2026-09-02） */}
            {fileErr && <span className="text-xs text-red-600">{fileErr}</span>}
            {draft.id && !draft.file && (
              <span className="text-xs text-gray-400">
                現在是「{draft.oldName || '（沒有檔案）'}」—— 不選新檔案就不會換。
              </span>
            )}
          </div>

          {/* ── 種類 ＋ 期別 ── */}
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-uisub text-gray-500 flex items-center">
                種類<span className="text-red-500 ml-0.5">*</span></span>
              <select value={k} className={CTRL}
                onChange={(e) => {
                  const kind = e.target.value;
                  onChange(retitle({ ...draft, kind, period_start: defaultStartFor(kind) }));
                }}>
                {REPORT_KINDS.map((x) => <option key={x} value={x}>{x}</option>)}
              </select></label>

            <label className="flex flex-col gap-1">
              <span className="text-uisub text-gray-500 flex items-center">
                期別{k !== '其他' && <span className="text-red-500 ml-0.5">*</span>}</span>
              {k === '401' ? (
                /*
                 * ★★★ 跨四年一次列完 —— **沒有「新增年度」這個動作**
                 *   （2026-09-18 使用者:「可以 dropdown 自己選 不用再新增」）。
                 *   清單在 lib/report.ts，有測試釘住「明年也選得到」。
                 */
                <select value={draft.period_start ?? ''} className={CTRL}
                  onChange={(e) => onChange(retitle({ ...draft, period_start: e.target.value || null }))}>
                  {options401().map((o) => <option key={o.start} value={o.start}>{o.label}</option>)}
                </select>
              ) : k === '月報' ? (
                <input type="month" value={startToMonth(draft.period_start)} className={CTRL}
                  onChange={(e) => onChange(retitle({
                    ...draft, period_start: monthToStart(e.target.value),
                  }))} />
              ) : (
                <input type="month" value={startToMonth(draft.period_start)} className={CTRL}
                  onChange={(e) => onChange(retitle({
                    ...draft, period_start: monthToStart(e.target.value),
                  }))} />
              )}
            </label>
          </div>
          {k === '其他' && (
            <span className="text-xs text-gray-400 -mt-1">期別沒有就留空。</span>
          )}

          {/* ── 標題 ── */}
          <label className="flex flex-col gap-1">
            <span className="text-uisub text-gray-500 flex items-center">
              標題<span className="text-red-500 ml-0.5">*</span></span>
            <input value={draft.title} className={CTRL}
              placeholder={k === '其他' ? '114 年度財簽報告' : '115年 7-8月'}
              onChange={(e) => onChange({ ...draft, title: e.target.value, titleTouched: true })} />
            {/* ★ 一句話講完，寫給不知道前因後果的人看 */}
            <span className="text-xs text-gray-400">下載下來的檔名就是這一行。</span>
          </label>

          {/*
            ── 申報日 ＋ 備註 ──
            ★★ 沒有上傳日那一格 —— 它自動帶（使用者:「不用上傳日，自動吃」）。
              這一格是**申報日**,送出去給國稅局那一天,不一樣的東西。
            ★ 沒有紅星就是非必填,不用再寫一次「(非必填)」（anxing-ui 二-10）。
            ★★★ 手機上直接疊成兩排 —— 日期輸入框在窄螢幕上擠不進三分之一。
          */}
          {/*
            ★★★ 申報日與備註**各自一行**（2026-09-18 使用者:「表單 備註分開一行」）。
              並排時備註只剩三分之二寬,「留底數：30,748」這種就已經快滿了 ——
              而備註本來就是會愈寫愈長的那一欄。
            ★ 申報日是日期框,不需要整行寬,所以留在左邊三分之一。
          */}
          <label className="flex flex-col gap-1 md:w-1/3">
            <span className="text-uisub text-gray-500">申報日</span>
            <input type="date" value={draft.filed_on ?? ''} className={CTRL}
              onChange={(e) => onChange({ ...draft, filed_on: e.target.value })} />
            {/* ★ 一句話講完,寫給不知道前因後果的人看 */}
            <span className="text-xs text-gray-400">還沒申報就留空。</span>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-uisub text-gray-500">備註</span>
            <input value={draft.note ?? ''} className={CTRL}
              placeholder="留底數 30,748"
              onChange={(e) => onChange({ ...draft, note: e.target.value })} />
          </label>

          <div className="text-xs text-gray-400 leading-relaxed">
            只有總經理、會計、主管看得到與上傳。
          </div>
        </div>

        <div className="sticky bottom-0 bg-white px-5 py-3 border-t border-mor-line flex justify-end gap-2">
          <button onClick={onClose}
            className="h-11 md:h-10 rounded-lg border border-mor-line px-5 text-uisub">取消</button>
          {/* ★ 灰掉要說得出為什麼（anxing-ui 二-6） */}
          <button onClick={save} disabled={saving || !!bad} title={bad ?? ''}
            className="h-11 md:h-10 rounded-lg bg-mor-slate text-white px-5 text-uisub font-medium
                       hover:bg-mor-slatedark disabled:opacity-50">
            {saving ? '上傳中⋯' : draft.id ? '儲存' : '上傳'}</button>
        </div>
      </div>
    </div>
  );
}
