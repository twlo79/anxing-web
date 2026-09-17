'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase';
import { useOnce } from '@/lib/once';
import { ReqMark } from '@/components/Req';
import {
  EVENT_KINDS, KIND_LABEL, parseEventKind, kindLabel,
  eventOrder, nextEvent, isPast, untilLabel, fmtEventWhen,
  FILE_ACCEPT, fileKind, KIND_BADGE, canPreview, whyNoPreview,
  fmtSize, fileTooBig, type EventKind,
  linkify, urlHref, urlLabel, eventShareText, lineShareUrl, shareVia, type ShareVia,
  canUpload, filesByPerson,
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
  /** 開會才有意義：true 才收得了檔案（migration_265） */
  uploads_open: boolean;
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
  /** 誰按的上傳 —— 出事要查是誰傳錯的 */
  uploaded_by: string | null;
  /**
   * 這份資料是**誰的**（migration_265）。代傳時跟 uploaded_by 不同。
   * ★ 畫面照這一欄分組，`uploaded_by` 顯示成「芊代傳」的小標。
   */
  author_id: string | null;
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
  /** 「傳給誰」下拉用的在職名單 */
  const [people, setPeople] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [view, setView] = useState<Fl | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [{ data: ev, error }, { data: fl }, { data: pf }] = await Promise.all([
      supabase.from('board_events').select('*'),
      supabase.from('board_files').select('*').order('created_at'),
      supabase.from('profiles').select('id, name, active').order('name'),
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
    setPeople((pf ?? [])
      .filter((p) => (p as { active?: boolean }).active !== false)
      .map((p) => ({ id: p.id as string, name: (p.name as string) ?? '—' })));
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
    /*
     * ★ 日期與時間都必填（使用者 2026-09-17）。
     *   按鈕本來就會擋，但這裡再守一次 —— 按鈕的 disabled 只是畫面。
     */
    if (!d.date || !d.time) return onMsg('日期與時間都要填。', true);
    /*
     * ★★ `all_day` 已停用（migration_265），新的列一律 false。
     *   欄位留著是為了舊資料 —— 畫面讀到 true 時還是照它不畫時間。
     */
    const iso = new Date(`${d.date}T${d.time}:00`).toISOString();
    const body = {
      kind: d.kind,
      title: d.title.trim(),
      starts_at: iso,
      all_day: false,
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

  /*
   * ★ 確認畫面在 `EventForm` 裡就地展開,這裡不再叫 `confirm()` ——
   *   那個灰框長得跟系統警告一樣,而且手機上很醜。
   */
  const del = async (e: Ev) => {
    const { data, error } = await supabase.from('board_events')
      .delete().eq('id', e.id).select('id');
    if (error) return onMsg('刪不掉：' + error.message, true);
    if (!data?.length) return onMsg('沒有刪掉 —— 只有排這一場的人跟主管刪得掉。', true);
    load();
  };

  /**
   * 開／關「開放上傳」。
   *
   * ★★ 這只是畫面上的方便 —— 真正擋住上傳的是資料庫的 policy
   *   （migration_265：要 kind='meeting' 且 uploads_open）。
   *   只改這裡的話，開關關著照樣傳得進去而畫面上看不到那些檔案。
   */
  const toggleUploads = async (ev: Ev) => {
    const want = !ev.uploads_open;
    const { data, error } = await supabase.from('board_events')
      .update({ uploads_open: want }).eq('id', ev.id).select('id');
    if (error) return onMsg('改不動：' + error.message, true);
    if (!data?.length) return onMsg('沒有改到 —— 只有排這一場的人跟主管動得了這個開關。', true);
    setEvents((xs) => xs.map((x) => (x.id === ev.id ? { ...x, uploads_open: want } : x)));
  };

  /** 上傳（可以一次選好幾份） */
  const upload = async (ev: Ev, picked: FileList, authorId: string) => {
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
        event_id: ev.id, path, name: f.name, size_bytes: f.size,
        /* ★ 誰按的上傳 vs 這是誰的 —— 代傳時兩個不一樣 */
        uploaded_by: meId, author_id: authorId || meId,
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
            isAdmin={isAdmin} people={people}
            onEdit={() => setDraft({
              id: e.id, kind: parseEventKind(e.kind), title: e.title,
              date: dateOf(e.starts_at), time: e.all_day ? '' : timeOf(e.starts_at),
              note: e.note ?? '',
            })}
            onToggle={() => toggleUploads(e)}
            onUpload={(fl, who) => upload(e, fl, who)}
            onDelFile={delFile}
            onView={setView} />
        ))}
      </div>

      {draft && (() => {
        const cur = events.find((x) => x.id === draft.id) ?? null;
        const mine = cur ? cur.created_by === meId : true;
        return (
          <EventForm draft={draft} onChange={setDraft}
            onClose={() => setDraft(null)} onSave={save}
            /* ★ 刪除只給排這場的人跟主管 —— 做不到的時候整顆不出現（anxing-ui 四-3） */
            canDelete={!!draft.id && (mine || isAdmin)}
            files={draft.id ? filesOf(draft.id) : []}
            names={names}
            onDelete={async () => { if (cur) { await del(cur); setDraft(null); } }} />
        );
      })()}

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

function EventRow({ ev, files, names, meId, isAdmin, people,
  onEdit, onToggle, onUpload, onDelFile, onView }: {
  ev: Ev; files: Fl[]; names: Map<string, string>; meId: string; isAdmin: boolean;
  people: { id: string; name: string }[];
  onEdit: () => void;
  onToggle: () => void;
  /** 第二個參數是「這份資料是誰的」—— 代傳時不等於自己 */
  onUpload: (f: FileList, authorId: string) => void;
  onDelFile: (f: Fl) => void;
  onView: (f: Fl) => void;
}) {
  const pick = useRef<HTMLInputElement>(null);
  /** 「傳給誰」。預設自己 —— 九成的情況零個額外動作 */
  const [forWho, setForWho] = useState(meId);
  const kind = parseEventKind(ev.kind);
  const past = isPast(ev.starts_at);
  const mine = ev.created_by === meId;
  const canEdit = mine || isAdmin;
  const open = canUpload(ev);
  const who = (id: string | null) => names.get(id ?? '') ?? '—';

  return (
    <div className={`rounded-xl border bg-white px-4 py-3 ${
      past ? 'border-mor-line opacity-60'
           : `border-mor-line border-l-[3px] ${
               kind === 'meeting' ? 'border-l-mor-slate' : 'border-l-[#C9A227]'}`}`}>

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

      {/*
        ★★ 誰排的。使用者問「是大家都可以看／編輯嗎」—— 會問就代表畫面上看不出來。
          看到「芊 排的」而自己不是芊，就知道為什麼沒有「編輯」那顆；
          不寫的話，沒有編輯鍵的人只會覺得是系統壞了。
      */}
      <div className="text-[11px] text-gray-400 mt-0.5">{who(ev.created_by)} 排的</div>

      {ev.note && <Note text={ev.note} />}

      {/*
        ── 資料 ──
        ★★★ 只有**開會**才有這一塊（使用者:「團聚 不用上傳資料」）。
          團聚整塊不出現 —— 不是灰掉。灰掉的東西人會一直去點。
      */}
      {kind === 'meeting' && (
        <div className="mt-2 border-t border-dashed border-mor-line pt-2">
          <div className="flex items-center gap-2">
            {canEdit ? (
              <button onClick={onToggle} role="switch" aria-checked={ev.uploads_open}
                className={`w-9 h-5 rounded-full relative shrink-0 transition-colors ${
                  ev.uploads_open ? 'bg-mor-greendark' : 'bg-[#D6D3CC]'}`}>
                <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${
                  ev.uploads_open ? 'left-[18px]' : 'left-0.5'}`} />
              </button>
            ) : (
              <span className={`w-9 h-5 rounded-full relative shrink-0 ${
                ev.uploads_open ? 'bg-mor-greendark' : 'bg-[#D6D3CC]'}`}>
                <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow ${
                  ev.uploads_open ? 'left-[18px]' : 'left-0.5'}`} />
              </span>
            )}
            <span className="text-[12.5px]">開放上傳資料</span>
            <span className="text-[11px] text-gray-400">
              {ev.uploads_open ? '已開放' : '開了大家才能傳'}
            </span>
          </div>

          {/*
            ★ 關著的時候要說出**為什麼**不能傳、**誰**能打開 ——
              一塊沒有解釋的空白會被當成壞掉。
          */}
          {!ev.uploads_open && (
            <div className="mt-1.5 rounded-lg bg-[#FAFAF8] px-2.5 py-1.5 text-[11.5px] text-gray-500">
              還沒開放 —— 由{mine ? '你' : `排這場會的人（${who(ev.created_by)}）`}或主管打開。
            </div>
          )}

          {/* ★★ 照「這是誰的」分組，不是照誰按的按鈕 */}
          {filesByPerson(files.map((f) => ({ ...f, uploaded_by: f.author_id ?? f.uploaded_by })))
            .map((g) => (
              <div key={g.who ?? '—'}>
                <div className="text-[11.5px] font-bold text-gray-600 mt-2 mb-0.5">
                  {who(g.who)}
                  <span className="font-normal text-gray-400 ml-1.5">· {g.items.length} 份</span>
                </div>
                {g.items.map((f) => {
                  const k = fileKind(f.name);
                  const badge = KIND_BADGE[k];
                  const canOpen = canPreview(f.name);
                  /* 代傳：這份的作者不是按上傳的那個人 */
                  const proxy = f.author_id && f.uploaded_by && f.author_id !== f.uploaded_by;
                  return (
                    <div key={f.id} className="flex items-center gap-1.5 py-[3px] pl-2.5 text-xs">
                      <span className="w-4 text-center shrink-0">{k === 'pdf' ? '📕' : '📘'}</span>
                      {canOpen ? (
                        <button onClick={() => onView(f)}
                          className="flex-1 min-w-0 truncate text-left text-mor-slate hover:underline">
                          {f.name}
                        </button>
                      ) : (
                        <span className="flex-1 min-w-0 truncate text-gray-500"
                          title={whyNoPreview(f.name)}>{f.name}</span>
                      )}
                      {badge && (
                        <span title={badge.hint.replace(/\*\*/g, '')}
                          className={`rounded px-1 text-[9.5px] font-bold shrink-0 ${
                            k === 'pdf' ? 'bg-[#FDE7E5] text-[#B3423C]'
                                        : 'bg-[#EDE7F6] text-[#5E35B1]'}`}>{badge.t}</span>
                      )}
                      {proxy && (
                        <span className="rounded bg-[#F5F4F1] px-1.5 text-[10px] text-gray-400 shrink-0">
                          {who(f.uploaded_by)}代傳
                        </span>
                      )}
                      <span className="text-[10.5px] text-gray-400 shrink-0">{fmtSize(f.size_bytes)}</span>
                      {(f.uploaded_by === meId || isAdmin) && (
                        <button onClick={() => onDelFile(f)} title="刪掉"
                          className="text-gray-300 hover:text-red-500 shrink-0">✕</button>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}

          {/*
            ★ 「可以讓大家上傳」—— 所以不分角色、也不管這場會是誰排的。
              但要開關打開（資料庫那邊同一條規則）。
          */}
          {open && (
            <div className="mt-2 flex gap-2 items-center">
              <select value={forWho} onChange={(e) => setForWho(e.target.value)}
                title="代別人傳的話改這裡"
                className="rounded-lg border border-mor-line px-2 py-1.5 text-[11.5px]
                           bg-white text-gray-600 max-w-[8.5rem]">
                <option value={meId}>傳給　我自己</option>
                {people.filter((p) => p.id !== meId).map((p) => (
                  <option key={p.id} value={p.id}>傳給　{p.name}</option>
                ))}
              </select>
              <input ref={pick} type="file" accept={FILE_ACCEPT} hidden multiple
                onChange={(e) => {
                  if (e.target.files?.length) onUpload(e.target.files, forWho);
                  e.target.value = '';
                }} />
              <button onClick={() => pick.current?.click()}
                className="flex-1 rounded-lg border border-dashed border-mor-line py-1.5
                           text-[11.5px] text-gray-500 hover:bg-mor-sand/50">
                ＋ 上傳資料　<span className="text-gray-400">PDF・Word</span>
              </button>
            </div>
          )}
        </div>
      )}

      {/*
        ── 動作 ──
        ★★★ 刪除**不在這裡** —— 它搬進「編輯」視窗了（anxing-ui 四-3：
          刪除是底下一行紅色小字，而且刪這一場會連檔案一起帶走）。
        ★ 連結不帶底線（四-4）。
      */}
      <div className="mt-2.5 flex items-center gap-3">
        {canEdit && (
          <button onClick={onEdit}
            className="text-xs text-mor-slate hover:text-mor-slatedark">編輯</button>
        )}
        <ShareButton ev={ev} />
      </div>
    </div>
  );
}

/**
 * 分享一場活動。
 *
 * ══════════════════════════════════════════════════════════
 * 【2026-09-17 使用者：「點分享跑到 https://www.line.me/en/」】
 *
 * 原本一律 `window.open(line.me/R/share?text=…)`。那是 LINE 的
 * **URL scheme** —— 官方文件寫著「isn't supported in LINE for PC」。
 * 桌機瀏覽器打開它，就是被導去 LINE 官網叫你下載 App。
 *
 * ★★ 網頁版那支（`social-plugins.line.me/lineit/share`）也不行:
 *   `url` 是必填，而佈告欄要登入才看得到 —— 貼出去是一條點開變登入畫面
 *   的連結，而且它的 `text` 在 iPhone Safari 上會被忽略。
 *
 * ══════════════════════════════════════════════════════════
 * 【所以分成兩條路（規則在 lib/board.ts 的 `shareVia`，有測試）】
 *
 *   手機　`navigator.share()` → 系統分享面板，LINE 就在裡面。
 *        文字原樣帶過去，換行也留得住。
 *   桌機　複製到剪貼簿 → 自己貼進 LINE 桌機版。
 *        **這比任何 LINE 網址都好** —— PC 版本來就不吃 URL scheme。
 *
 * ★★★ 按鈕上的字跟著路徑變。一律寫「分享」的話，
 *   桌機按下去只會複製，而畫面上沒有任何地方說過這件事 ——
 *   人會以為按鈕壞了（那正是這次的原型）。
 *
 * ★ 能力在 `useEffect` 裡量，不是 render 當下。
 *   伺服器那一輪沒有 `navigator`，直接讀會讓兩邊算出不同的字，
 *   React 會丟 hydration 警告。先用桌機那條當預設，掛載後再修正。
 */
function ShareButton({ ev }: { ev: Ev }) {
  const [via, setVia] = useState<ShareVia>('copy');
  const [done, setDone] = useState('');

  useEffect(() => {
    setVia(shareVia({
      hasNativeShare: typeof navigator !== 'undefined' && typeof navigator.share === 'function',
      hasClipboard: typeof navigator !== 'undefined' && !!navigator.clipboard?.writeText,
    }));
  }, []);

  function flash(t: string) { setDone(t); setTimeout(() => setDone(''), 4000); }

  async function go() {
    const text = eventShareText(ev);
    try {
      if (via === 'native') { await navigator.share({ text }); return; }
      if (via === 'copy') {
        await navigator.clipboard.writeText(text);
        flash('已複製 —— 貼到 LINE 就好');
        return;
      }
      window.open(lineShareUrl(text), '_blank', 'noopener');
    } catch (e) {
      /*
       * ★ 在系統面板上按取消也會走到這裡（AbortError）——
       *   那不是失敗，不要跳訊息嚇人。
       */
      if ((e as { name?: string })?.name === 'AbortError') return;
      flash('分享不了 —— 手動選取上面那幾行複製');
    }
  }

  return (
    <div className="ml-auto flex items-center gap-2">
      {/*
        ★★ 訊息要出現在**動作發生的地方**（anxing-ui 二-5）。
          跳在頁面最上方的話，這張卡片在畫面下半部的人看不到 ——
          他按了鈕、什麼都沒發生，結論是「按鈕壞了」。
      */}
      {done && <span className="text-[11px] text-mor-greendark">{done}</span>}
      <button onClick={go}
        title={via === 'copy' ? '複製活動資訊，貼到 LINE 就好' : '開分享面板，訊息已經打好了'}
        className="rounded-lg border border-mor-line bg-white px-3.5 py-1
                   text-xs text-gray-600 hover:bg-mor-sand/60">
        {via === 'copy' ? '複製' : '分享'}
      </button>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════ */

/**
 * 備註：文字與網址混在一起。
 *
 * ★★★ 走 `linkify()` 切成段落再畫，**不是** `dangerouslySetInnerHTML`。
 *   那一欄是使用者自己打的字 —— 轉成 HTML 就得先證明裡面沒有別的東西，
 *   而那件事很難證明。切成段落之後用 React 元素畫，天生就跳不出去。
 *
 * ★ `whitespace-pre-wrap` 讓換行照原樣顯示（文字段落裡留著 `\n`）。
 */
function Note({ text }: { text: string }) {
  return (
    <div className="mt-1 text-xs text-gray-600 leading-relaxed whitespace-pre-wrap break-words">
      {linkify(text).map((p, i) => (
        p.kind === 'url'
          ? <a key={i} href={urlHref(p.v)} target="_blank" rel="noopener noreferrer"
              title={p.v}
              className="text-mor-slate underline break-all">{urlLabel(p.v)}</a>
          : <span key={i}>{p.v}</span>
      ))}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════ */

function EventForm({ draft, onChange, onClose, onSave, canDelete, files, names, onDelete }: {
  draft: Draft;
  onChange: (d: Draft) => void;
  onClose: () => void;
  onSave: (d: Draft) => Promise<void> | void;
  /** 做不到的時候整顆不出現，不是灰掉（anxing-ui 四-3） */
  canDelete: boolean;
  /** 這一場底下有哪些檔案 —— 確認文字要講出「是誰的幾份」 */
  files: Fl[];
  names: Map<string, string>;
  onDelete: () => Promise<void> | void;
}) {
  const [save, saving] = useOnce(async () => { await onSave(draft); });
  const [asking, setAsking] = useState(false);
  const [wiping, wiping2] = useOnce(async () => { await onDelete(); });
  /* ★ 日期與時間都必填（使用者 2026-09-17） */
  const bad = !draft.title.trim() || !draft.date || !draft.time;

  /*
   * ★★ 確認文字裡把檔案**是誰的**講出來。
   *   只寫「3 份資料」的話，刪的人不知道自己順手毀掉的是別人的東西。
   */
  const byWho = filesByPerson(files.map((f) => ({ ...f, uploaded_by: f.author_id ?? f.uploaded_by })))
    .map((g) => `${names.get(g.who ?? '') ?? '—'} ${g.items.length} 份`)
    .join('、');

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
          {/* ★ 兩種活動用同一個「＋活動」進來，在這裡分 */}
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

          {/* ★ 沒有範例文字（使用者 2026-09-17:「名稱都不用範例」） */}
          <label className="flex flex-col gap-1">
            <span className="flex items-center text-xs text-gray-500">名稱<ReqMark /></span>
            <input value={draft.title} onChange={(e) => onChange({ ...draft, title: e.target.value })}
              className="rounded-lg border border-gray-300 px-2 py-1.5" /></label>

          <div className="flex gap-2.5">
            <label className="flex-1 flex flex-col gap-1">
              <span className="flex items-center text-xs text-gray-500">日期<ReqMark /></span>
              <input type="date" value={draft.date}
                onChange={(e) => onChange({ ...draft, date: e.target.value })}
                className="rounded-lg border border-gray-300 px-2 py-1.5" /></label>
            <label className="flex-1 flex flex-col gap-1">
              <span className="flex items-center text-xs text-gray-500">時間<ReqMark /></span>
              <input type="time" value={draft.time}
                onChange={(e) => onChange({ ...draft, time: e.target.value })}
                className="rounded-lg border border-gray-300 px-2 py-1.5" /></label>
          </div>

          <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">備註</span>
            <textarea value={draft.note} onChange={(e) => onChange({ ...draft, note: e.target.value })}
              className="rounded-lg border border-gray-300 px-2 py-1.5 min-h-[58px] resize-y" />
            {/* ★ 這是**行為說明**不是範例 —— 不講的話沒有人知道可以貼網址 */}
            <span className="text-[11px] text-gray-400">貼網址會自動變成可以點的</span></label>

          {draft.kind === 'meeting' && !draft.id && (
            <div className="text-[11px] text-gray-400 leading-relaxed">
              建好之後，把「開放上傳資料」打開，大家就可以傳 PDF 或 Word。
            </div>
          )}

          {/*
            ══════════ 刪除 ══════════
            ★★★ 在**內容區的最後一格**，不是跟底下的「取消／儲存」排一起
              （anxing-ui 四-3）——那一排讀起來是「毀掉它／算了／存起來」，
              而人來這個視窗是為了改東西然後存檔。中間隔著一條線。
            ★ 跟「社群模擬」的編輯視窗同一個做法，人不用學第二次。
          */}
          {canDelete && !asking && (
            <div className="text-center pt-1">
              <button onClick={() => setAsking(true)}
                className="text-xs text-red-400 underline hover:text-red-600">
                刪掉這場活動{files.length ? `（連同 ${files.length} 份資料，不可復原）` : '（不可復原）'}
              </button>
            </div>
          )}
          {canDelete && asking && (
            <div className="rounded-lg border border-dashed border-red-300 bg-red-50/60 px-3 py-2.5">
              <div className="text-[12.5px] text-red-800 leading-relaxed">
                <b>確定要刪掉「{draft.title || '這場活動'}」？</b><br />
                {files.length
                  ? <>底下<b>{byWho}</b>共 {files.length} 份資料會一起不見，<b>救不回來</b>。</>
                  : <><b>救不回來</b>。</>}
              </div>
              <div className="mt-2 flex justify-end gap-2">
                <button onClick={() => setAsking(false)}
                  className="rounded-lg border border-gray-300 bg-white px-3 py-1 text-xs">算了</button>
                <button onClick={wiping} disabled={wiping2}
                  className="rounded-lg border border-red-300 bg-white px-3 py-1 text-xs
                             text-red-600 disabled:opacity-50">
                  {wiping2 ? '刪除中⋯' : '確定刪掉'}</button>
              </div>
            </div>
          )}
        </div>

        <div className="sticky bottom-0 bg-white px-5 py-3 border-t border-mor-line flex justify-end gap-2">
          <button onClick={onClose}
            className="rounded-lg border border-gray-300 px-4 py-1.5 text-sm">取消</button>
          <button onClick={save} disabled={saving || bad}
            title={bad ? '名稱、日期、時間都要填' : ''}
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
