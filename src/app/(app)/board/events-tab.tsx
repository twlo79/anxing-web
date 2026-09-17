'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase';
import { useOnce } from '@/lib/once';
import {
  EVENT_KINDS, KIND_LABEL, parseEventKind, kindLabel,
  eventOrder, nextEvent, isPast, untilLabel, fmtEventWhen,
  FILE_ACCEPT, fileKind, KIND_BADGE, canPreview, whyNoPreview,
  fmtSize, fileTooBig, type EventKind,
} from '@/lib/board';

/*
 * ══════════════════════════════════════════════════════════
 * 佈告欄 → 活動（2026-09-17 使用者指定）
 *
 * 「開會 與 團聚 合再一起 一條一條 最新排在上方」
 * 「分標籤 開會 團聚」
 * 「+ 活動 可以存兩種活動」
 *
 * ★★ 兩種活動**同一條列表**，不是兩欄。分的是標籤不是位置 ——
 *   分成兩欄的話，「這個月有什麼事」要看兩個地方。
 *
 * ══════════════════════════════════════════════════════════
 * 【★★★ 檔案：PDF 是原樣，Word 是預覽】
 *
 *   PDF 　瀏覽器內建，點開**跟原檔一模一樣**
 *   Word　靠 mammoth 解成網頁。解得出標題、段落、粗體、清單、表格、圖片；
 *   　　　解不出頁首頁尾、頁碼、文字方塊、分欄、字型、合併儲存格
 *
 * ★ 所以每一份檔案旁邊都標著「原樣」或「預覽」，而且點開之後**視窗裡再講一次**。
 *   不講的話會有人照著預覽去開會，漏掉一個被吃掉的表格 ——
 *   而那種錯沒有人會來報。
 *
 * ★★ `.doc`（舊版）解不開，`.docx` 才行。所以那種檔直接說「請下載或另存」，
 *   不要畫一個點了沒反應的連結。
 * ══════════════════════════════════════════════════════════
 */

const BUCKET = 'board';

type Ev = {
  id: string;
  kind: string;
  title: string;
  starts_at: string;
  all_day: boolean;
  note: string | null;
  created_by: string | null;
  created_at: string;
};

type Fl = {
  id: string;
  event_id: string;
  path: string;
  name: string;
  size_bytes: number | null;
  uploaded_by: string | null;
  created_at: string;
};

type Draft = {
  id?: string;
  kind: EventKind;
  title: string;
  /** yyyy-mm-dd */
  date: string;
  /** hh:mm，空的＝整天 */
  time: string;
  note: string;
};

const blank = (): Draft => ({ kind: 'meeting', title: '', date: '', time: '', note: '' });

const KIND_CLS: Record<EventKind, string> = {
  meeting: 'bg-mor-bluelight text-mor-slatedark border-mor-slate/30',
  gathering: 'bg-[#F6EEDD] text-[#8a6d1f] border-[#C9A227]/40',
};

export default function EventsTab({ meId, isAdmin, onMsg }: {
  meId: string;
  isAdmin: boolean;
  onMsg: (t: string, err?: boolean) => void;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [events, setEvents] = useState<Ev[]>([]);
  const [files, setFiles] = useState<Fl[]>([]);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [view, setView] = useState<Fl | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [{ data: ev, error }, { data: fl }, { data: pf }] = await Promise.all([
      supabase.from('board_events').select('*'),
      supabase.from('board_files').select('*').order('created_at'),
      supabase.from('profiles').select('id, name'),
    ]);
    /*
     * ★★ RLS 擋下來的查詢回的是「成功、0 列」不是錯誤（README 坑 C）——
     *   所以 error 之外，「一筆都沒有」也要講話，
     *   不然畫面只是一片空白，看起來像還沒建資料。
     */
    if (error) onMsg('讀不到活動：' + error.message, true);
    setEvents((ev ?? []) as Ev[]);
    setFiles((fl ?? []) as Fl[]);
    setNames(new Map((pf ?? []).map((p) => [p.id as string, p.name as string])));
    setLoading(false);
  }, [supabase, onMsg]);

  useEffect(() => { load(); }, [load]);

  /* ★ 排序與「下一場」全部走 lib —— 這裡不自己算 */
  const rows = useMemo(() => eventOrder(events), [events]);
  const next = useMemo(() => nextEvent(events), [events]);
  const filesOf = useCallback(
    (id: string) => files.filter((f) => f.event_id === id),
    [files],
  );

  const save = async (d: Draft) => {
    if (!d.date) return onMsg('要選一個日期。', true);
    /*
     * ★★ 沒填時間就存當天 00:00 並把 all_day 打勾 ——
     *   畫面上照 all_day 決定畫不畫時間。
     *   不記這個旗標的話，「7/19 慶功」會被畫成「7/19 00:00」，
     *   看起來像半夜要集合。
     */
    const allDay = !d.time;
    const iso = new Date(`${d.date}T${d.time || '00:00'}:00`).toISOString();
    const body = {
      kind: d.kind,
      title: d.title.trim(),
      starts_at: iso,
      all_day: allDay,
      note: d.note.trim() || null,
    };
    /* ★★★ `.select('id')` 不能省 —— RLS 擋下來回的是「成功、0 列」 */
    const { data, error } = d.id
      ? await supabase.from('board_events').update(body).eq('id', d.id).select('id')
      : await supabase.from('board_events')
          .insert({ ...body, created_by: meId }).select('id');
    if (error) return onMsg((d.id ? '存不起來：' : '建不起來：') + error.message, true);
    if (!data?.length) {
      return onMsg(
        d.id
          ? '沒有存進去 —— 只有排這一場的人跟主管改得動。'
          : '沒有建起來 —— 你的帳號沒有這個權限。', true);
    }
    setDraft(null);
    load();
  };

  const del = async (e: Ev) => {
    const n = filesOf(e.id).length;
    if (!confirm(`刪掉「${e.title}」？${n ? `\n\n底下那 ${n} 份資料會一起不見。` : ''}`)) return;
    const { data, error } = await supabase.from('board_events')
      .delete().eq('id', e.id).select('id');
    if (error) return onMsg('刪不掉：' + error.message, true);
    if (!data?.length) return onMsg('沒有刪掉 —— 只有排這一場的人跟主管刪得掉。', true);
    load();
  };

  /** 上傳（可以一次選好幾份） */
  const upload = async (ev: Ev, picked: FileList) => {
    const list = Array.from(picked);
    for (const f of list) {
      const tooBig = fileTooBig(f.size);
      if (tooBig.bad) { onMsg(`${f.name}：${tooBig.why}`, true); continue; }
      if (fileKind(f.name) === 'other') {
        onMsg(`${f.name} 不是 PDF 也不是 Word —— 這裡只收這兩種。`, true);
        continue;
      }
      /*
       * ★★ 路徑用 uuid，不是原始檔名。中文檔名在 storage 上會被轉義，
       *   而同一場會兩個人傳同名的檔會互相蓋掉。
       *   原始檔名存在 `board_files.name`，畫面上顯示那一個。
       */
      const ext = (f.name.split('.').pop() || 'bin').toLowerCase().slice(0, 5);
      const path = `${ev.id}/${Date.now()}_${crypto.randomUUID()}.${ext}`;
      const { error: ue } = await supabase.storage.from(BUCKET)
        .upload(path, f, { contentType: f.type || undefined, upsert: false });
      if (ue) { onMsg(`${f.name} 傳不上去：${ue.message}`, true); continue; }
      const { data, error } = await supabase.from('board_files').insert({
        event_id: ev.id, path, name: f.name, size_bytes: f.size, uploaded_by: meId,
      }).select('id');
      if (error || !data?.length) {
        /*
         * ★ 檔案已經在 storage 上但資料庫那一列沒建起來 ——
         *   留著的話是一份看不到、刪不掉、但佔著空間的孤兒。收回去。
         */
        await supabase.storage.from(BUCKET).remove([path]);
        onMsg(`${f.name} 沒有掛上去：${error?.message ?? '你的帳號沒有這個權限。'}`, true);
        continue;
      }
    }
    load();
  };

  const delFile = async (f: Fl) => {
    if (!confirm(`刪掉「${f.name}」？`)) return;
    const { data, error } = await supabase.from('board_files')
      .delete().eq('id', f.id).select('id');
    if (error) return onMsg('刪不掉：' + error.message, true);
    if (!data?.length) return onMsg('沒有刪掉 —— 只有傳的人跟主管刪得掉。', true);
    /* ★ 資料庫那一列刪掉了才收 storage —— 反過來的話列還在但檔沒了 */
    await supabase.storage.from(BUCKET).remove([f.path]);
    load();
  };

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <button onClick={() => setDraft(blank())}
          className="h-9 rounded-lg bg-mor-slate text-white px-3.5 text-uisub font-medium
                     hover:bg-mor-slatedark">＋ 活動</button>
        {/*
          ★★ 列表照「最新在上」排，所以最上面那筆是**日期最遠**的那一場，
            不是下一場。所以下一場要在這裡另外講一次 ——
            不然「下禮拜要開會」被埋在中間。
        */}
        <span className="ml-auto text-xs text-gray-500">
          {next
            ? <>下一場　<b className="text-mor-ink">{kindLabel(next.kind)}・
                {fmtEventWhen(next.starts_at, !next.all_day)}</b>
                <span className="ml-1.5 text-gray-400">{untilLabel(next.starts_at)}</span></>
            : <>沒有排定的活動</>}
        </span>
      </div>

      {loading && <div className="text-sm text-gray-400 py-8 text-center">載入中…</div>}

      {!loading && !rows.length && (
        <div className="rounded-xl border border-mor-line bg-white py-12 text-center text-sm text-gray-400">
          還沒有活動 —— 按上面的「＋ 活動」排一場。
        </div>
      )}

      <div className="grid gap-2">
        {rows.map((e) => (
          <EventRow key={e.id} ev={e} files={filesOf(e.id)} names={names} meId={meId}
            isAdmin={isAdmin}
            onEdit={() => setDraft({
              id: e.id, kind: parseEventKind(e.kind), title: e.title,
              date: dateOf(e.starts_at), time: e.all_day ? '' : timeOf(e.starts_at),
              note: e.note ?? '',
            })}
            onDel={() => del(e)}
            onUpload={(fl) => upload(e, fl)}
            onDelFile={delFile}
            onView={setView} />
        ))}
      </div>

      {draft && <EventForm draft={draft} onChange={setDraft}
        onClose={() => setDraft(null)} onSave={save} />}

      {view && <FileViewer file={view} onClose={() => setView(null)} onMsg={onMsg} />}
    </div>
  );
}

/* ── 日期字串（★ 表單用本地時間，跟使用者選的那一格一致） ───────── */
const two = (n: number) => String(n).padStart(2, '0');
function dateOf(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}
function timeOf(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${two(d.getHours())}:${two(d.getMinutes())}`;
}

/* ══════════════════════════════════════════════════════════ */

function EventRow({ ev, files, names, meId, isAdmin,
  onEdit, onDel, onUpload, onDelFile, onView }: {
  ev: Ev; files: Fl[]; names: Map<string, string>; meId: string; isAdmin: boolean;
  onEdit: () => void; onDel: () => void;
  onUpload: (f: FileList) => void;
  onDelFile: (f: Fl) => void;
  onView: (f: Fl) => void;
}) {
  const pick = useRef<HTMLInputElement>(null);
  const kind = parseEventKind(ev.kind);
  const past = isPast(ev.starts_at);
  const mine = ev.created_by === meId;

  return (
    <div className={`rounded-xl border bg-white px-4 py-3 ${
      past ? 'border-mor-line opacity-60' : 'border-mor-line border-l-[3px] border-l-mor-slate'}`}>

      <div className="flex items-start gap-2 flex-wrap">
        {/* ★ 標籤 —— 兩種活動同一條列表，分的是標籤不是位置 */}
        <span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold shrink-0 ${
          KIND_CLS[kind]}`}>{KIND_LABEL[kind]}</span>
        <span className="font-semibold text-sm tabular-nums">
          {fmtEventWhen(ev.starts_at, !ev.all_day)}
        </span>
        <span className="text-[11px] text-gray-400 ml-auto whitespace-nowrap">
          {untilLabel(ev.starts_at)}
        </span>
      </div>

      <div className="mt-1 text-sm">{ev.title}</div>
      {ev.note && (
        <div className="mt-0.5 text-xs text-gray-600 whitespace-pre-wrap leading-relaxed">{ev.note}</div>
      )}

      {/* ── 資料 ── */}
      <div className="mt-2 border-t border-dashed border-mor-line pt-2">
        {files.map((f) => {
          const k = fileKind(f.name);
          const badge = KIND_BADGE[k];
          const canOpen = canPreview(f.name);
          return (
            <div key={f.id} className="flex items-center gap-1.5 py-[3px] text-xs">
              <span className="w-4 text-center shrink-0">{k === 'pdf' ? '📕' : '📘'}</span>
              {canOpen ? (
                <button onClick={() => onView(f)}
                  className="flex-1 min-w-0 truncate text-left text-mor-slate hover:underline">
                  {f.name}
                </button>
              ) : (
                <span className="flex-1 min-w-0 truncate text-gray-500" title={whyNoPreview(f.name)}>
                  {f.name}
                </span>
              )}
              {/*
                ★★★ 「原樣」／「預覽」—— 這兩個字是整個檔案功能的重點。
                  沒有它的話，Word 的預覽會被當成原檔的樣子。
              */}
              {badge && (
                <span title={badge.hint.replace(/\*\*/g, '')}
                  className={`rounded px-1 text-[9.5px] font-bold shrink-0 ${
                    k === 'pdf' ? 'bg-[#FDE7E5] text-[#B3423C]' : 'bg-[#EDE7F6] text-[#5E35B1]'}`}>
                  {badge.t}
                </span>
              )}
              <span className="text-[10.5px] text-gray-400 shrink-0">
                {names.get(f.uploaded_by ?? '') ?? '—'}
                {fmtSize(f.size_bytes) && ` · ${fmtSize(f.size_bytes)}`}
              </span>
              {(f.uploaded_by === meId || isAdmin) && (
                <button onClick={() => onDelFile(f)} title="刪掉"
                  className="text-gray-300 hover:text-red-500 shrink-0">✕</button>
              )}
            </div>
          );
        })}

        {/*
          ★ 「大家上傳」（使用者 2026-09-17）—— 所以這個框每個人都看得到，
            不分角色、也不管這場會是誰排的。
        */}
        <input ref={pick} type="file" accept={FILE_ACCEPT} hidden multiple
          onChange={(e) => { if (e.target.files?.length) onUpload(e.target.files); e.target.value = ''; }} />
        <button onClick={() => pick.current?.click()}
          className="mt-1 w-full rounded-lg border border-dashed border-mor-line py-1.5
                     text-[11.5px] text-gray-500 hover:bg-mor-sand/50">
          ＋ 上傳資料　<span className="text-gray-400">PDF・Word</span>
        </button>
      </div>

      <div className="mt-2 flex gap-3">
        {(mine || isAdmin) && <>
          <button onClick={onEdit}
            className="text-[11px] text-mor-slate hover:text-mor-slatedark">編輯</button>
          <button onClick={onDel}
            className="text-[11px] text-red-400 hover:text-red-600">刪掉</button>
        </>}
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════ */

function EventForm({ draft, onChange, onClose, onSave }: {
  draft: Draft;
  onChange: (d: Draft) => void;
  onClose: () => void;
  onSave: (d: Draft) => Promise<void> | void;
}) {
  const [save, saving] = useOnce(async () => { await onSave(draft); });
  const bad = !draft.title.trim() || !draft.date;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-sm max-h-[85vh] overflow-y-auto">
        <div className="sticky top-0 bg-white px-5 py-3.5 border-b border-mor-line font-bold
                        flex items-center justify-between">
          {draft.id ? '編輯活動' : '排一場活動'}
          <button onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-xl leading-none">✕</button>
        </div>

        <div className="px-5 py-4 grid gap-3 text-sm">
          {/* ★ 兩種活動用同一個「＋活動」進來，在這裡分（使用者 2026-09-17） */}
          <div className="flex flex-col gap-1">
            <span className="text-xs text-gray-500">哪一種</span>
            <div className="flex gap-2">
              {EVENT_KINDS.map((k) => (
                <button key={k} onClick={() => onChange({ ...draft, kind: k })}
                  className={`flex-1 rounded-lg border px-3 py-1.5 text-uisub ${
                    k === draft.kind
                      ? 'bg-mor-slate border-mor-slate text-white font-semibold'
                      : 'bg-white border-gray-300 text-gray-600 hover:bg-mor-sand/60'}`}>
                  {KIND_LABEL[k]}
                </button>
              ))}
            </div>
          </div>

          <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">名稱</span>
            <input value={draft.title} onChange={(e) => onChange({ ...draft, title: e.target.value })}
              placeholder={draft.kind === 'meeting' ? 'Q4 房源檢討' : '中秋聚餐・大直海霸王'}
              className="rounded-lg border border-gray-300 px-2 py-1.5" /></label>

          <div className="flex gap-2.5">
            <label className="flex-1 flex flex-col gap-1"><span className="text-xs text-gray-500">日期</span>
              <input type="date" value={draft.date}
                onChange={(e) => onChange({ ...draft, date: e.target.value })}
                className="rounded-lg border border-gray-300 px-2 py-1.5" /></label>
            <label className="flex-1 flex flex-col gap-1">
              <span className="text-xs text-gray-500">時間（可以不填）</span>
              <input type="time" value={draft.time}
                onChange={(e) => onChange({ ...draft, time: e.target.value })}
                className="rounded-lg border border-gray-300 px-2 py-1.5" /></label>
          </div>
          <div className="text-[11px] text-gray-400 -mt-1">
            不填時間就只顯示日期 —— 不會變成「00:00」。
          </div>

          <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">備註</span>
            <textarea value={draft.note} onChange={(e) => onChange({ ...draft, note: e.target.value })}
              placeholder="地點、誰要到、要準備什麼"
              className="rounded-lg border border-gray-300 px-2 py-1.5 min-h-[58px] resize-y" /></label>

          {draft.kind === 'meeting' && (
            <div className="text-[11px] text-gray-400 leading-relaxed">
              建好之後，每個人都可以在這一場底下上傳資料（PDF 或 Word）。
            </div>
          )}
        </div>

        <div className="sticky bottom-0 bg-white px-5 py-3 border-t border-mor-line flex justify-end gap-2">
          <button onClick={onClose}
            className="rounded-lg border border-gray-300 px-4 py-1.5 text-sm">取消</button>
          <button onClick={save} disabled={saving || bad}
            title={bad ? '名稱與日期都要填' : ''}
            className="rounded-lg bg-mor-slate text-white px-4 py-1.5 text-sm font-medium
                       hover:bg-mor-slatedark disabled:opacity-50">
            {saving ? '儲存中⋯' : draft.id ? '儲存' : '建立'}</button>
        </div>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════ */

/**
 * 點開一份檔案。
 *
 * ★★★ PDF 走 `<iframe>`（瀏覽器內建，**原樣**）。
 *   Word 走 mammoth 解成 HTML（**預覽**，排版會走樣）——
 *   而視窗裡一定要再講一次那句話。
 *
 * ★★ mammoth 是**動態載入**的。它只有點開 Word 檔的時候才需要，
 *   放進主包的話每個人載這一頁都要多背它一份。
 */
function FileViewer({ file, onClose, onMsg }: {
  file: Fl; onClose: () => void; onMsg: (t: string, err?: boolean) => void;
}) {
  const supabase = useMemo(() => createClient(), []);
  const k = fileKind(file.name);
  const [url, setUrl] = useState<string | null>(null);
  const [html, setHtml] = useState<string | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    let dead = false;
    (async () => {
      const { data, error } = await supabase.storage.from(BUCKET)
        .createSignedUrl(file.path, 3600);
      if (dead) return;
      if (error || !data?.signedUrl) {
        setErr('拿不到這份檔案：' + (error?.message ?? '網址是空的'));
        return;
      }
      if (k === 'pdf') { setUrl(data.signedUrl); return; }

      /* ── Word ── */
      try {
        const res = await fetch(data.signedUrl);
        const buf = await res.arrayBuffer();
        /*
         * ★ `import('mammoth')` 會解析到它的 browser build（package.json 的
         *   `browser` 欄位）。要先 `npm i mammoth`，沒裝的話 build 會失敗。
         */
        const mammoth: any = await import('mammoth');
        const out = await (mammoth.default ?? mammoth)
          .convertToHtml({ arrayBuffer: buf });
        if (dead) return;
        setHtml(out?.value || '<p>（這份 Word 裡沒有文字）</p>');
      } catch (e: any) {
        if (dead) return;
        setErr('這份 Word 打不開：' + (e?.message ?? e) + '\n請下載，或另存成 PDF 再傳一次。');
      }
    })();
    return () => { dead = true; };
  }, [supabase, file.path, k]);

  const download = async () => {
    const { data, error } = await supabase.storage.from(BUCKET)
      .createSignedUrl(file.path, 60, { download: file.name });
    if (error || !data?.signedUrl) return onMsg('下載不了：' + (error?.message ?? ''), true);
    window.open(data.signedUrl, '_blank');
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-3"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-full max-w-[900px] h-[92vh] rounded-2xl bg-white overflow-hidden flex flex-col">
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-mor-line">
          <span className="shrink-0">{k === 'pdf' ? '📕' : '📘'}</span>
          <span className="font-semibold text-sm flex-1 min-w-0 truncate">{file.name}</span>
          <button onClick={download}
            className="rounded-lg border border-mor-line px-2.5 py-1 text-[11.5px]">下載原檔</button>
          <button onClick={onClose} title="關閉"
            className="text-gray-400 hover:text-mor-ink text-lg leading-none">✕</button>
        </div>

        {/*
          ★★★ Word 的那句話**在內容上面**，不是在角落的小字。
            人會直接往下讀內容 —— 警語放在他讀完之後才看得到的地方，
            等於沒寫（README:訊息要出現在動作發生的地方）。
        */}
        {k === 'word' && (
          <div className="px-4 py-2 bg-amber-50 border-b border-amber-200
                          text-[11.5px] text-amber-900 leading-relaxed">
            這是<b>解出來的內容</b>，<b>排版跟原檔不一樣</b> ——
            頁首頁尾、頁碼、文字方塊、分欄、字型都不會出現。要看原樣請按右上角「下載原檔」。
          </div>
        )}

        <div className="flex-1 min-h-0 overflow-auto bg-[#F6F5F2]">
          {err && (
            <div className="p-6 text-sm text-red-600 whitespace-pre-line leading-relaxed">{err}</div>
          )}
          {!err && k === 'pdf' && (
            url
              ? <iframe src={url} title={file.name} className="w-full h-full border-0" />
              : <div className="p-6 text-sm text-gray-400">載入中…</div>
          )}
          {!err && k === 'word' && (
            html
              ? (
                /*
                 * ★ mammoth 的輸出是**它自己產的 HTML**（來源是使用者傳的 docx）。
                 *   它不會把 docx 裡的巨集或腳本帶出來 —— 轉出來的只有
                 *   p / h1-6 / strong / em / ul / ol / table / img 這些標籤。
                 */
                <div className="p-6 bg-white m-4 rounded-xl shadow-sm docx-preview
                                text-[14px] leading-relaxed"
                  dangerouslySetInnerHTML={{ __html: html }} />
              )
              : <div className="p-6 text-sm text-gray-400">解檔中…</div>
          )}
        </div>
      </div>
    </div>
  );
}
