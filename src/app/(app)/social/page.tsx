'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase';
import { useProfile } from '@/lib/profile';
import Toast from '@/components/Toast';
import { AddButton } from '@/components/Actions';
import { useOnce } from '@/lib/once';
import {
  PIN_MAX, COLS, CELL_W, CELL_H, CAPTION_CUT, SPANS,
  layout, pinnedCells, canPin, renumberPins, misaligned, pinShift,
  sourceSize, sliceCrop, sliceBg, publishOrder, sliceFileName, captionCut,
  type Item, type GridCell,
} from '@/lib/social-grid';

/*
 * ══════════════════════════════════════════════════════════
 * 社群經營 → IG 版面模擬（2026-09-16 使用者指定）
 *
 * 「模擬 IG 的版面去放照片與文案，可以直接看感覺。」
 *
 * ★★★ 排版的算式全部在 `lib/social-grid.ts`（33 個測試）——
 *   這一頁只負責畫。哪一格在哪、誰先貼、切圖有沒有歪、釘選還剩幾格，
 *   那些是會錯而且錯了看不出來的東西，一條都不准寫在這裡。
 *
 * ══════════════════════════════════════════════════════════
 * 【這一頁沒有連到真的 IG】
 *
 * 不發佈、不讀追蹤者、不需要 Meta 授權。它是一面**牆的草稿**:
 * 把打算貼的東西排出來看整體調性，然後自己去 IG 貼。
 * 頭像與追蹤者數字是畫面上的裝飾，不是資料。
 *
 * ══════════════════════════════════════════════════════════
 * 【四個不做就會變成假預覽的細節】
 *
 *   ① 格子是 **4:5** 不是正方形（IG 2025 年初改的）
 *   ② 角標會毀掉「整體調性」的判斷 → 乾淨模式，而且**預設開著**
 *   ③ 文案 125 字之後收成「⋯更多」→ 把看得到的那一段直接畫出來
 *   ④ 切圖的發佈順序是**反的**，而且釘選會把整面牆推歪
 * ══════════════════════════════════════════════════════════
 */

const BUCKET = 'social';

type Account = {
  id: string; name: string; handle: string; bio: string | null;
  sort: number; active: boolean;
};
type Split = { id: string; account_id: string; source_path: string | null; span: number };
type Post = {
  id: string; account_id: string; sort: number; caption: string;
  image_path: string | null; planned_on: string | null; published_on: string | null;
  status: 'draft' | 'scheduled' | 'published'; pin: number;
  split_id: string | null; split_index: number | null;
};

/** 版面上的一筆：一則貼文，或一張切圖（連同它的 N 則） */
type Row = Item & {
  kind: 'post' | 'split';
  /** 貼文是那一則；切圖是照 split_index 排好的 N 則 */
  posts: Post[];
  split?: Split;
};

const ST: Record<Post['status'], { t: string; cls: string }> = {
  draft:     { t: '草稿',   cls: 'bg-black/60' },
  scheduled: { t: '已排程', cls: 'bg-amber-700/90' },
  published: { t: '已發佈', cls: 'bg-mor-greendark/90' },
};

const mdOf = (d?: string | null) =>
  d ? `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}` : '';

export default function SocialPage() {
  const supabase = useMemo(() => createClient(), []);
  const role = useProfile().profile?.role ?? '';
  const canEdit = role === 'manager' || role === 'super_admin';

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accId, setAccId] = useState('');
  const [posts, setPosts] = useState<Post[]>([]);
  const [splits, setSplits] = useState<Split[]>([]);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  /*
   * ★★★ 乾淨模式**預設開著**。
   *   日期與狀態角標會毀掉判斷 —— 九宮格要看的是九張照片放在一起的
   *   顏色與節奏，而滿版的小標籤本身就是一種顏色。
   *   要管進度時才打開。
   */
  const [clean, setClean] = useState(true);
  const [newAcc, setNewAcc] = useState<{ name: string; handle: string; bio: string } | null>(null);
  const [drag, setDrag] = useState<string | null>(null);

  const flash = (t: string) => { setMsg(t); setTimeout(() => setMsg(''), 3500); };

  /* ── 撈 ───────────────────────────────────────────── */
  const load = useCallback(async () => {
    setLoading(true);
    const { data: accs, error: ae } = await supabase
      .from('social_accounts').select('*').eq('active', true).order('sort').order('name');
    /*
     * ★★ RLS 擋下來的查詢回的是「成功、0 列」不是錯誤（README 坑 C）——
     *   所以這裡除了 error 之外，「一個帳號都沒有」也要講話，
     *   不然畫面上只是一片空白，看起來像還沒建資料。
     */
    if (ae) { flash('讀不到模擬頁：' + ae.message); setLoading(false); return; }
    const list = (accs ?? []) as Account[];
    setAccounts(list);

    const id = accId && list.some((a) => a.id === accId) ? accId : (list[0]?.id ?? '');
    if (id !== accId) setAccId(id);
    if (!id) { setPosts([]); setSplits([]); setLoading(false); return; }

    const [{ data: ps }, { data: sp }] = await Promise.all([
      supabase.from('social_posts').select('*')
        .eq('account_id', id).is('deleted_at', null).order('sort'),
      supabase.from('social_splits').select('*').eq('account_id', id),
    ]);
    setPosts((ps ?? []) as Post[]);
    setSplits((sp ?? []) as Split[]);
    setLoading(false);
  }, [supabase, accId]);
  useEffect(() => { load(); }, [load]);

  /* 私有 bucket：每張圖都要換一次簽名網址（跟 Receipts 同一套） */
  useEffect(() => {
    (async () => {
      const want = [
        ...posts.map((p) => p.image_path),
        ...splits.map((s) => s.source_path),
      ].filter((x): x is string => !!x && !urls[x]);
      if (!want.length) return;
      const { data } = await supabase.storage.from(BUCKET).createSignedUrls(want, 3600);
      if (!data) return;
      const add: Record<string, string> = {};
      data.forEach((d) => { if (d.signedUrl && d.path) add[d.path] = d.signedUrl; });
      setUrls((u) => ({ ...u, ...add }));
    })();
    // urls 故意不放進相依 —— 放了會因為 setUrls 觸發自己而無限迴圈
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [posts, splits, supabase]);

  /* ── 把資料庫的列組成「版面上的一筆」 ───────────────── */
  const rows: Row[] = useMemo(() => {
    const byId = new Map(splits.map((s) => [s.id, s]));
    const seen = new Set<string>();
    const out: Row[] = [];
    for (const p of [...posts].sort((a, b) => a.sort - b.sort)) {
      if (!p.split_id) {
        out.push({ id: p.id, span: 1, pin: p.pin, status: p.status, kind: 'post', posts: [p] });
        continue;
      }
      if (seen.has(p.split_id)) continue;
      seen.add(p.split_id);
      const sp = byId.get(p.split_id);
      const group = posts.filter((x) => x.split_id === p.split_id)
        .sort((a, b) => (a.split_index ?? 0) - (b.split_index ?? 0));
      out.push({
        id: p.split_id, span: sp?.span ?? group.length, pin: group[0]?.pin ?? 0,
        status: group[0]?.status ?? 'draft', kind: 'split', posts: group, split: sp,
      });
    }
    return out;
  }, [posts, splits]);

  const cells = useMemo(() => layout(rows), [rows]);
  const bad = useMemo(() => misaligned(cells), [cells]);
  const shift = pinShift(rows);
  const pinUsed = pinnedCells(rows);
  const acc = accounts.find((a) => a.id === accId) ?? null;
  const selRow = rows.find((r) => r.id === sel) ?? null;
  const selCell = cells.find((c) => c.item.id === sel && c.slice === 0) ?? null;

  /* ── 寫 ───────────────────────────────────────────── */

  /**
   * 重排 sort。
   *
   * ★★ 只更新**真的變了**的那幾列，不是整批 upsert ——
   *   PostgREST 的批次 upsert 取欄位聯集，沒帶到的欄位會被填成預設值
   *   （README 那條坑）。而這裡只想改 sort。
   */
  const persistOrder = useCallback(async (next: Row[]) => {
    /*
     * ★★ 比對的是**傳進來的那幾個 post 物件**身上的 sort，不是讀 state ——
     *   剛新增的那一筆還沒進 state，讀 state 的話它會被跳過，
     *   然後它的 sort 永遠停在暫時值上。
     *
     * ★ 只更新真的變了的那幾列。整批 upsert 不行:PostgREST 的批次 upsert
     *   取欄位聯集，沒帶到的欄位會被填成預設值（README 那條坑）。
     */
    const jobs: Promise<any>[] = [];
    next.forEach((r, i) => r.posts.forEach((p, k) => {
      const want = i * 10 + k;
      if (p.sort !== want) {
        jobs.push(supabase.from('social_posts').update({ sort: want }).eq('id', p.id) as any);
      }
    }));
    if (!jobs.length) return;
    const res = await Promise.all(jobs);
    const e = res.find((r: any) => r?.error);
    if (e?.error) flash('排序沒存起來：' + e.error.message);
    load();
  }, [supabase, load]);

  const moveTo = (fromId: string, toId: string) => {
    if (fromId === toId) return;
    const a = [...rows];
    const i = a.findIndex((r) => r.id === fromId);
    const j = a.findIndex((r) => r.id === toId);
    if (i < 0 || j < 0) return;
    const [m] = a.splice(i, 1);
    a.splice(j, 0, m);
    persistOrder(a);
  };
  const nudge = (id: string, dir: -1 | 1) => {
    const a = [...rows];
    const i = a.findIndex((r) => r.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= a.length) return;
    [a[i], a[j]] = [a[j], a[i]];
    persistOrder(a);
  };

  /**
   * 釘選。
   *
   * ★★ 上限的判斷走 lib 的 `canPin()` —— 它算的是**格數**，
   *   一張跨 3 格的切圖吃掉整個額度。資料庫的 check 只擋單一筆的值，
   *   看不到「格」這個概念，所以加總一定要在這裡算。
   */
  const togglePin = async (r: Row) => {
    if (!canEdit) return flash('只有主管與總管理員改得動這一頁。');

    let next: Row[];
    if (r.pin > 0) {
      next = renumberPins(rows.map((x) => (x.id === r.id ? { ...x, pin: 0 } : x)));
    } else {
      const ok = canPin(rows, r);
      if (!ok.ok) return flash(ok.why);
      // 先擺到最後，再交給 renumberPins 算出真正的格位
      const last = Math.max(0, ...rows.map((x) => x.pin)) + 1;
      next = renumberPins(rows.map((x) => (x.id === r.id ? { ...x, pin: last } : x)));
    }

    /*
     * ★★★ 資料庫的 `pin` 存的是**格的位置**（1〜3），不是第幾筆。
     *   一張跨 3 格的切圖，它的三則各自是 1、2、3 ——
     *   所以寫回去的時候要 `item.pin + k`，不是三則都寫同一個數字。
     *   三則同號的話，版面排序就沒有辦法決定誰在左誰在右。
     */
    const jobs: Promise<any>[] = [];
    next.forEach((x) => {
      const src = rows.find((y) => y.id === x.id);
      src?.posts.forEach((p, k) => {
        const want = x.pin > 0 ? x.pin + k : 0;
        if (p.pin !== want) {
          jobs.push(supabase.from('social_posts').update({ pin: want }).eq('id', p.id) as any);
        }
      });
    });
    if (!jobs.length) return;
    const res = await Promise.all(jobs);
    const e = res.find((x: any) => x?.error);
    if (e?.error) return flash('釘選沒存起來：' + e.error.message);
    load();
  };

  const patch = async (p: Post, fields: Partial<Post>) => {
    if (!canEdit) return flash('只有主管與總管理員改得動這一頁。');
    const { error } = await supabase.from('social_posts').update(fields).eq('id', p.id);
    if (error) return flash('存不起來：' + error.message);
    setPosts((xs) => xs.map((x) => (x.id === p.id ? { ...x, ...fields } : x)));
  };

  /** 上傳一個檔案，回傳 storage 路徑 */
  const put = async (file: File): Promise<string | null> => {
    const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().slice(0, 5);
    const path = `${accId}/${Date.now()}_${crypto.randomUUID()}.${ext}`;
    const { error } = await supabase.storage.from(BUCKET)
      .upload(path, file, { contentType: file.type || 'image/jpeg', upsert: false });
    if (error) { flash('上傳失敗：' + error.message); return null; }
    return path;
  };

  const addPost = async () => {
    if (!accId) return flash('先新增一個模擬頁。');
    if (!canEdit) return flash('只有主管與總管理員改得動這一頁。');
    // 新的排最前面（左上角）—— 其餘往後退一格
    const { data, error } = await supabase.from('social_posts')
      .insert({ account_id: accId, sort: -1, caption: '' }).select().single();
    if (error) return flash('新增失敗：' + error.message);
    const next: Row[] = [{ id: data.id, span: 1, pin: 0, status: 'draft',
      kind: 'post', posts: [data as Post] }, ...rows];
    setSel(data.id);
    persistOrder(next);
  };

  const addSplit = async (span: number) => {
    if (!accId) return flash('先新增一個模擬頁。');
    if (!canEdit) return flash('只有主管與總管理員改得動這一頁。');
    const { data: sp, error: se } = await supabase.from('social_splits')
      .insert({ account_id: accId, span }).select().single();
    if (se) return flash('新增失敗：' + se.message);
    const { data: ps, error: pe } = await supabase.from('social_posts').insert(
      Array.from({ length: span }, (_, k) => ({
        account_id: accId, sort: -span + k, caption: '',
        split_id: sp.id, split_index: k,
      }))).select();
    if (pe) {
      // 切圖母體建好但貼文沒建成 → 留下一個沒有格子的母體,畫面上看不到但佔著位子
      await supabase.from('social_splits').delete().eq('id', sp.id);
      return flash('新增失敗：' + pe.message);
    }
    setSel(sp.id);
    await load();
  };

  const del = async (r: Row) => {
    if (!canEdit) return flash('只有主管與總管理員改得動這一頁。');
    const what = r.kind === 'split' ? `這張跨 ${r.span} 格的切圖（連同 ${r.span} 則）` : '這一則';
    if (!confirm(`刪除${what}？\n\n可以再建回來，但文案與照片不會回來。`)) return;
    const { error } = r.kind === 'split'
      ? await supabase.from('social_splits').delete().eq('id', r.id)
      : await supabase.from('social_posts').delete().eq('id', r.id);
    if (error) return flash('刪不掉：' + error.message);
    setSel(null);
    load();
  };

  /**
   * 修對齊：在切圖前面補幾格空白貼文，把它推到下一排的開頭。
   *
   * ★ 另一種修法是「把上面多的那幾則搬到它下面」—— 但那會動到
   *   已經排好的東西。補空格是**只動一個地方**的修法，
   *   而且補出來的空格看得見，使用者知道那裡還要放東西。
   */
  const fixAlign = async (id: string, push: number) => {
    if (!canEdit) return flash('只有主管與總管理員改得動這一頁。');
    const i = rows.findIndex((r) => r.id === id);
    if (i < 0) return;
    const { data, error } = await supabase.from('social_posts').insert(
      Array.from({ length: push }, () => ({ account_id: accId, sort: 0, caption: '' }))).select();
    if (error) return flash('補不進去：' + error.message);
    const blanks: Row[] = (data as Post[]).map((p) => ({
      id: p.id, span: 1, pin: 0, status: 'draft' as const, kind: 'post' as const, posts: [p],
    }));
    const next = [...rows];
    next.splice(i, 0, ...blanks);
    persistOrder(next);
  };

  /* ── 切片下載 ─────────────────────────────────────── */
  const [cutting, setCutting] = useState(false);
  const downloadSlices = async (r: Row) => {
    if (!r.split?.source_path) return flash('這張切圖還沒有原圖。');
    const url = urls[r.split.source_path];
    if (!url) return flash('圖還在載，等一下再按。');
    setCutting(true);
    try {
      const img = await loadImage(url);
      const { w, h } = sourceSize(r.span);
      const order = publishOrder(r.span, (selCell?.seq ?? r.span));
      for (let n = 0; n < order.length; n++) {
        const { slice } = order[n];
        const c = sliceCrop(r.span, slice);
        const cv = document.createElement('canvas');
        cv.width = CELL_W; cv.height = CELL_H;
        const ctx = cv.getContext('2d');
        if (!ctx) break;
        /*
         * ★ 原圖不見得剛好是建議尺寸 —— 照**比例**換算，不要直接用像素。
         *   直接用的話，使用者傳一張 2000px 寬的圖，切片會只取到左上角一塊。
         */
        const kx = img.naturalWidth / w;
        const ky = img.naturalHeight / h;
        ctx.drawImage(img, c.sx * kx, c.sy * ky, c.sw * kx, c.sh * ky, 0, 0, CELL_W, CELL_H);
        const blob: Blob | null = await new Promise((res) => cv.toBlob(res, 'image/png'));
        if (!blob) continue;
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = sliceFileName(acc?.handle ?? 'ig', n + 1, order.length);
        a.click();
        URL.revokeObjectURL(a.href);
        // 一次丟太多下載瀏覽器會擋 —— 隔開一點
        await new Promise((res) => setTimeout(res, 250));
      }
      flash(`切好了 ${order.length} 張，檔名 01 的**先貼**。`);
    } catch (e: any) {
      flash('切不出來：' + (e?.message ?? e));
    } finally { setCutting(false); }
  };

  /* ══════════════════════════════════════════════════ */
  return (
    <div>
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <h1>IG 版面模擬
          <span className="text-sm font-normal text-gray-400 ml-2">
            把要貼的排出來，直接看整體感覺
          </span>
        </h1>
        {canEdit && <AddButton onClick={() => setNewAcc({ name: '', handle: '', bio: '' })}>
          新增模擬頁
        </AddButton>}
      </div>

      {/* ── 模擬頁分頁籤 ── */}
      <div className="flex flex-wrap gap-1 border-b border-mor-line mb-3">
        {accounts.map((a) => (
          <button key={a.id} onClick={() => { setAccId(a.id); setSel(null); }}
            className={`px-3.5 py-2 text-uisub rounded-t-lg border border-b-0 -mb-px ${
              a.id === accId ? 'bg-white border-mor-line font-semibold text-mor-ink'
                             : 'border-transparent text-gray-500 hover:bg-mor-sand/60'}`}>
            {a.handle}
          </button>
        ))}
        {!accounts.length && !loading && (
          <div className="py-2 text-sm text-gray-400">
            還沒有模擬頁 —— 按右上角「新增模擬頁」開一個。
          </div>
        )}
      </div>

      {acc && (
        <>
          {/* ── 工具列 ── */}
          <div className="flex flex-wrap items-center gap-2 mb-3">
            {canEdit && <>
              <button onClick={addPost}
                className="h-9 rounded-lg bg-mor-slate text-white px-3.5 text-uisub font-medium
                           hover:bg-mor-slatedark">＋ 貼文</button>
              {SPANS.map((n) => (
                <button key={n} onClick={() => addSplit(n)}
                  className="h-9 rounded-lg border border-mor-slate text-mor-slate px-3
                             text-uisub hover:bg-mor-bluelight/60">✂ 切圖・跨 {n} 格</button>
              ))}
            </>}
            <button onClick={() => setClean((v) => !v)}
              className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs ${
                clean ? 'bg-mor-ink border-mor-ink text-white'
                      : 'bg-white border-mor-line text-gray-600 hover:bg-mor-sand/60'}`}>
              乾淨模式
            </button>
            <span className="ml-auto text-xs text-gray-500">
              共 <b className="text-mor-ink">{cells.length}</b> 格
              📌 <b className="text-mor-ink">{pinUsed} / {PIN_MAX}</b>
            </span>
          </div>

          {/* ── 提示：釘選推歪 ＋ 切圖沒對齊 ── */}
          {bad.length > 0 && shift > 0 && (
            <div className="mb-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5
                            text-xs text-amber-900 leading-relaxed">
              📌 <b>釘選了 {pinUsed} 格，不是 {COLS} 的倍數</b> —— 底下整面牆往後推了 {shift} 格，
              所以下面的切圖跟著歪。釘選要嘛 <b>0 格</b>、要嘛 <b>{COLS} 格（剛好一排）</b>。
            </div>
          )}
          {bad.map((m) => (
            <div key={m.item.id}
              className="mb-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5
                         text-xs text-amber-900 leading-relaxed">
              ⚠ <b>一張跨 {m.item.span} 格的切圖歪掉了</b> —— 它從第 {m.at + 1} 格開始，
              而切圖必須從每一排的<b>第一格</b>開始，現在錯開 {m.skew} 格。
              {canEdit && (
                <button onClick={() => fixAlign(m.item.id, m.push)}
                  className="ml-2 rounded-md border border-amber-300 bg-white px-2 py-0.5
                             text-[11px] text-amber-800 hover:bg-amber-100">
                  往下推 {m.push} 格
                </button>
              )}
            </div>
          ))}

          <div className="flex flex-wrap items-start gap-5">
            {/* ══ 手機 ══ */}
            <div className="w-[340px] shrink-0 rounded-2xl border border-mor-line bg-white overflow-hidden">
              <div className="px-3.5 py-3 border-b border-[#EFEFEF]">
                <div className="flex items-center gap-3.5">
                  <span className="w-[54px] h-[54px] rounded-full shrink-0 flex items-center justify-center"
                    style={{ background: 'conic-gradient(from 210deg,#C9A227,#3FAE7C,#41689B,#C9A227)' }}>
                    <span className="w-12 h-12 rounded-full bg-white flex items-center justify-center
                                     text-[15px] font-extrabold text-mor-slate">
                      {(acc.name || acc.handle).slice(0, 1)}
                    </span>
                  </span>
                  <div className="flex gap-6 text-center text-xs">
                    <div><b className="block text-sm">{cells.length}</b>
                      <span className="text-gray-500 text-[11px]">貼文</span></div>
                    {/* ★ 追蹤者是裝飾不是資料 —— 這一頁沒有連 IG，寫個數字只會讓人以為是真的 */}
                    <div><b className="block text-sm text-gray-300">—</b>
                      <span className="text-gray-400 text-[11px]">追蹤者</span></div>
                  </div>
                </div>
                <div className="mt-2 text-xs leading-relaxed">
                  <b>{acc.name}</b>
                  {acc.bio && <div className="text-gray-500">{acc.bio}</div>}
                </div>
              </div>
              <div className="flex border-b border-[#EFEFEF] text-[13px]">
                <div className="flex-1 text-center py-2 text-mor-ink shadow-[inset_0_-1.5px_0_#2E3840]">▦ 貼文</div>
                <div className="flex-1 text-center py-2 text-gray-300">♺ 連續短片</div>
                <div className="flex-1 text-center py-2 text-gray-300">👤 標註</div>
              </div>

              {/*
                ★★ 一排三格、格子 4:5。`gap-[2px]` 那兩條白線**是真的** ——
                  IG 不會幫你留，切圖的接縫就壓在上面。照著看就對了。
              */}
              <div className="grid grid-cols-3 gap-[2px] p-[2px] bg-white">
                {cells.map((c) => (
                  <Cell key={`${c.item.id}/${c.slice}`} cell={c as GridCell<Row>}
                    urls={urls} clean={clean} selected={sel === c.item.id}
                    onClick={() => setSel(c.item.id)}
                    draggable={canEdit && c.slice === 0}
                    onDragStart={() => setDrag(c.item.id)}
                    onDrop={() => { if (drag) moveTo(drag, c.item.id); setDrag(null); }} />
                ))}
                {!cells.length && !loading && (
                  <div className="col-span-3 py-14 text-center text-sm text-gray-400">
                    還沒有貼文{canEdit ? ' —— 按上面的「＋ 貼文」' : ''}
                  </div>
                )}
              </div>
            </div>

            {/* ══ 編輯面板 ══ */}
            <div className="flex-1 min-w-[340px] rounded-xl border border-mor-line bg-[#FAFAF9] p-4">
              {!selRow ? (
                <div className="py-16 text-center text-sm text-gray-400 leading-loose">
                  點左邊任何一格<br />照片與文案在這裡改
                  <div className="text-xs mt-3">✂ 的那幾格是切圖，點下去看切片與發佈順序</div>
                </div>
              ) : (
                <Panel row={selRow} seq={selCell?.seq ?? 0} urls={urls}
                  canEdit={canEdit} cutting={cutting} rows={rows}
                  onPatch={patch} onPin={() => togglePin(selRow)} onDel={() => del(selRow)}
                  onNudge={(d) => nudge(selRow.id, d)}
                  onSlices={() => downloadSlices(selRow)}
                  onUpload={async (file, post) => {
                    const path = await put(file);
                    if (!path) return;
                    if (selRow.kind === 'split' && selRow.split) {
                      const { error } = await supabase.from('social_splits')
                        .update({ source_path: path }).eq('id', selRow.split.id);
                      if (error) return flash('存不起來：' + error.message);
                    } else if (post) {
                      await patch(post, { image_path: path });
                    }
                    load();
                  }} />
              )}
            </div>
          </div>

          <p className="text-[11px] text-gray-400 mt-3 leading-relaxed">
            這一頁<b>沒有連到真的 IG</b> —— 不發佈、不讀追蹤者。它是一面牆的草稿，
            排好之後自己去 IG 貼。九宮格是 <b>4:5</b>（1080×1350），不是正方形。
          </p>
        </>
      )}

      {/* ── 新增模擬頁 ── */}
      {newAcc && (
        <NewAccount draft={newAcc} onChange={setNewAcc} onClose={() => setNewAcc(null)}
          onSave={async (d) => {
            const { error } = await supabase.from('social_accounts')
              .insert({ name: d.name.trim(), handle: d.handle.trim().replace(/^@/, ''),
                bio: d.bio.trim() || null, sort: accounts.length });
            if (error) return flash('建不起來：' + error.message);
            setNewAcc(null);
            load();
          }} />
      )}

      <Toast msg={msg} />
    </div>
  );
}

/* ══════════════════════════════════════════════════════════ */

function Cell({ cell, urls, clean, selected, onClick, draggable, onDragStart, onDrop }: {
  cell: GridCell<Row>; urls: Record<string, string>; clean: boolean; selected: boolean;
  onClick: () => void; draggable: boolean; onDragStart: () => void; onDrop: () => void;
}) {
  const r = cell.item;
  const st = ST[r.status];
  const path = r.kind === 'split' ? r.split?.source_path : r.posts[0]?.image_path;
  const url = path ? urls[path] : null;
  const bg = r.kind === 'split' ? sliceBg(r.span, cell.slice) : null;
  return (
    <button type="button" onClick={onClick}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => { e.preventDefault(); onDrop(); }}
      className={`relative aspect-[4/5] overflow-hidden bg-[#F3F1EC] ${
        selected ? 'outline outline-[2.5px] -outline-offset-2 outline-mor-slate z-10' : ''}`}>
      {url ? (
        <span className="absolute inset-0 bg-no-repeat" style={bg
          ? { backgroundImage: `url(${url})`, backgroundSize: bg.size, backgroundPosition: bg.position }
          : { backgroundImage: `url(${url})`, backgroundSize: 'cover', backgroundPosition: 'center' }} />
      ) : (
        <span className="absolute inset-0 flex items-center justify-center text-gray-300 text-lg">
          {r.kind === 'split' ? '✂' : '＋'}
        </span>
      )}

      {!clean && <>
        {/* 未發佈的畫虛線外框 —— 一眼分得出「這是計畫」還是「已經貼了」 */}
        {r.status !== 'published' && (
          <span className="absolute inset-0 border-2 border-dashed border-white/85 pointer-events-none" />
        )}
        {cell.slice === 0 && (
          <span className={`absolute left-1 top-1 rounded px-1.5 text-[9px] font-bold text-white ${st.cls}`}>
            {r.kind === 'split' ? `✂ 跨 ${r.span} 格` : st.t}
            {r.posts[0]?.planned_on ? `　${mdOf(r.posts[0].planned_on)}` : ''}
          </span>
        )}
        {r.pin > 0 && cell.slice === 0 && (
          <span className="absolute right-1 top-1 text-[11px] drop-shadow">📌</span>
        )}
        {/* 序號 ＝ 發佈順序。★ 釘選不會改它 —— 一個小號碼掛在左上角就是「舊貼文被釘上來」 */}
        <span className="absolute right-1 bottom-1 w-[17px] h-[17px] rounded-full
                         bg-white/90 border border-black/10 text-[9.5px] font-extrabold
                         flex items-center justify-center text-mor-ink">{cell.seq}</span>
        {/* 1:1 安全區 —— 這張圖在動態牆、搜尋頁還是可能被切成方的 */}
        <span className="absolute left-0 right-0 top-1/2 -translate-y-1/2 aspect-square
                         border border-dashed border-white/70 pointer-events-none" />
      </>}
    </button>
  );
}

/* ══════════════════════════════════════════════════════════ */

function Panel({ row, seq, urls, canEdit, cutting, rows,
  onPatch, onPin, onDel, onNudge, onSlices, onUpload }: {
  row: Row; seq: number; urls: Record<string, string>;
  canEdit: boolean; cutting: boolean; rows: Row[];
  onPatch: (p: Post, f: Partial<Post>) => void;
  onPin: () => void; onDel: () => void; onNudge: (d: -1 | 1) => void;
  onSlices: () => void;
  onUpload: (file: File, post: Post | null) => void;
}) {
  const file = useRef<HTMLInputElement>(null);
  const lock = row.status === 'published';
  const pin = canPin(rows, row);
  const src = row.kind === 'split' ? row.split?.source_path : row.posts[0]?.image_path;
  const url = src ? urls[src] : null;
  const { w, h } = sourceSize(row.span);
  const order = publishOrder(row.span, seq);

  const upload = (f: FileList | null) => {
    if (!f?.length) return;
    onUpload(f[0], row.kind === 'post' ? row.posts[0] : null);
  };

  return (
    <div>
      <div className="flex items-start justify-between gap-2">
        <h4 className="font-bold text-sm">
          {row.kind === 'split'
            ? <>✂ 切圖・跨 {row.span} 格
                <span className="ml-2 text-[11px] font-normal text-gray-500">
                  第 {seq - row.span + 1}～{seq} 則</span></>
            : <>第 {seq} 則</>}
          {lock && <span className="ml-2 text-[11px] font-normal text-mor-greendark">已發佈</span>}
        </h4>
        {canEdit && (
          <span className="flex gap-1 shrink-0">
            <button onClick={() => onNudge(-1)} title="往前一格（更新）"
              className="w-7 h-7 rounded-lg border border-mor-line bg-white text-xs">◀</button>
            <button onClick={() => onNudge(1)} title="往後一格（更舊）"
              className="w-7 h-7 rounded-lg border border-mor-line bg-white text-xs">▶</button>
          </span>
        )}
      </div>
      <p className="text-[11px] text-gray-500 mt-0.5 leading-relaxed">
        {lock ? '已經貼出去的內容不給改 —— 改了預覽就跟真的不一樣了。釘選還是可以動。'
              : '格子可以拖曳換順序，或用右邊的 ◀ ▶。IG 是新的在左上。'}
      </p>

      {/* ── 釘選 ── */}
      {canEdit && (
        <div className={`mt-3 rounded-lg border px-3 py-2 text-sm ${
          row.pin > 0 ? 'border-[#C9A227] bg-[#FFFBF0]' : 'border-mor-line bg-white'}`}>
          <label className={`flex items-start gap-2 ${pin.ok ? 'cursor-pointer' : 'cursor-default'}`}>
            <input type="checkbox" className="mt-0.5" checked={row.pin > 0}
              disabled={!pin.ok} onChange={onPin} />
            <span>
              <b>釘選到最上方</b>{row.pin > 0 ? `（第 ${row.pin} 個）` : ''}
              <span className="block text-[11px] text-gray-500 mt-0.5 leading-relaxed">
                {!pin.ok ? pin.why
                  : row.span > 1
                    ? `這張切圖會用掉 ${row.span} 格釘選額度（IG 上限 ${PIN_MAX} 格）——
                       剛好把一整排釘在最上面，底下不會被推歪。`
                    : `只是把它拉到版面最上方，不會改變發佈日期或序號。`}
              </span>
            </span>
          </label>
        </div>
      )}

      {/* ── 圖 ── */}
      <div className="mt-3">
        <div className="text-[11px] text-gray-500 mb-1">
          {row.kind === 'split' ? `原圖　建議 ${w} × ${h}` : `照片　建議 ${CELL_W} × ${CELL_H}`}
        </div>
        <div className="flex gap-3 items-start">
          <div className={`shrink-0 rounded-lg overflow-hidden border border-mor-line bg-white relative ${
            row.kind === 'split' ? 'w-[180px]' : 'w-24 aspect-[4/5]'}`}
            style={row.kind === 'split' ? { aspectRatio: `${w} / ${h}` } : undefined}>
            {url
              ? <img src={url} alt="" className="w-full h-full object-cover" />
              : <span className="absolute inset-0 flex items-center justify-center text-gray-300">無</span>}
            {row.kind === 'post' && (
              <span className="absolute left-0 right-0 top-1/2 -translate-y-1/2 aspect-square
                               border border-dashed border-white/80 pointer-events-none" />
            )}
          </div>
          <div className="text-[11px] text-gray-500 leading-relaxed">
            {row.kind === 'split'
              ? <>切成 {row.span} 張，每張 {CELL_W}×{CELL_H}。
                  <b className="text-mor-ink block mt-1">格子之間那兩條白線是真的</b>
                  IG 不會幫你留 —— 重要的字與人臉不要壓在接縫上。</>
              : <>外框是九宮格的 <b>4:5</b>，中間虛線是 <b>1:1 安全區</b>。
                  重點內容留在虛線裡 —— 這張圖在動態牆、搜尋頁還是可能被切成方的。</>}
            {canEdit && !lock && (
              <div className="mt-2">
                <input ref={file} type="file" accept="image/*" hidden
                  onChange={(e) => { upload(e.target.files); e.target.value = ''; }} />
                <button onClick={() => file.current?.click()}
                  className="h-7 rounded-lg border border-mor-line bg-white px-2.5 text-[11px]">
                  {url ? '換一張' : '選一張圖'}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── 切圖：切片 ＋ 發佈順序 ── */}
      {row.kind === 'split' && (
        <>
          <div className="mt-3">
            <div className="text-[11px] text-gray-500 mb-1">切成 {row.span} 張</div>
            <div className="grid gap-[3px]" style={{ gridTemplateColumns: `repeat(${COLS},1fr)` }}>
              {Array.from({ length: row.span }, (_, n) => {
                const bg = sliceBg(row.span, n);
                return (
                  <div key={n} className="relative aspect-[4/5] rounded overflow-hidden
                                          border border-mor-line bg-[#F3F1EC]">
                    {url && <span className="absolute inset-0 bg-no-repeat" style={{
                      backgroundImage: `url(${url})`, backgroundSize: bg.size,
                      backgroundPosition: bg.position }} />}
                    <span className="absolute right-0.5 bottom-0.5 w-[15px] h-[15px] rounded-full
                                     bg-white/95 text-[9px] font-extrabold flex items-center
                                     justify-center">{seq - n}</span>
                  </div>
                );
              })}
            </div>
          </div>

          {/*
            ★★★ 發佈順序**是反的**。IG 最新的貼在左上角，
              所以要拼出完整的圖得從最右下那一張開始貼。
              貼反的話圖會左右顛倒，而已經貼出去的刪掉重貼會掉讚數。
          */}
          <div className="mt-2.5 rounded-lg border border-mor-line bg-white px-3 py-2 text-[11.5px] leading-relaxed">
            <b className="text-mor-slate">發佈順序</b>
            {order.map((o, i) => (
              <span key={o.slice}>
                {i > 0 && ' → '}
                <span className="inline-block rounded bg-mor-sand px-1.5 font-bold text-[#6b5b3f]">
                  {o.seq}
                </span>
              </span>
            ))}
            <div className="text-gray-500 mt-1">
              序號小的先貼 —— 也就是從<b>最右下那一張</b>開始，最後才貼最左上那一張。
            </div>
            {canEdit && (
              <button onClick={onSlices} disabled={cutting || !url}
                className="mt-2 h-8 rounded-lg border border-mor-slate text-mor-slate px-3
                           text-[11.5px] disabled:opacity-40">
                {cutting ? '切檔中⋯' : `⬇ 下載 ${row.span} 張切片（檔名帶順序）`}
              </button>
            )}
          </div>
        </>
      )}

      {/* ── 文案 ── */}
      <div className="mt-3 space-y-2">
        <div className="text-[11px] text-gray-500">
          {row.kind === 'split' ? `每一格各自的文案（${row.span} 格 ＝ ${row.span} 則貼文）` : '文案'}
        </div>
        {row.posts.map((p, n) => (
          <Caption key={p.id} post={p} label={row.kind === 'split' ? String(seq - n) : ''}
            readOnly={lock || !canEdit} onSave={(v) => onPatch(p, { caption: v })} />
        ))}
        {row.kind === 'split' && (
          <div className="text-[11px] text-gray-500 leading-relaxed">
            ★ 有人單獨點進其中一格時，看到的是那張圖的 1/{row.span} —— 文案要自己站得住。
          </div>
        )}
      </div>

      {/* ── 日期與狀態 ── */}
      <div className="flex gap-2.5 mt-3">
        <label className="flex-1 flex flex-col gap-1 text-[11px] text-gray-500">
          {row.kind === 'split' ? '第一則預計發佈' : '預計發佈'}
          <input type="date" disabled={lock || !canEdit}
            value={row.posts[0]?.planned_on ?? ''}
            onChange={(e) => row.posts.forEach((p) =>
              onPatch(p, { planned_on: e.target.value || null }))}
            className="h-8 rounded-lg border border-gray-300 px-2 text-sm bg-white" />
        </label>
        <label className="flex-1 flex flex-col gap-1 text-[11px] text-gray-500">
          狀態
          <select disabled={!canEdit} value={row.status}
            onChange={(e) => row.posts.forEach((p) =>
              onPatch(p, { status: e.target.value as Post['status'] }))}
            className="h-8 rounded-lg border border-gray-300 px-2 text-sm bg-white">
            {(Object.keys(ST) as Post['status'][]).map((k) =>
              <option key={k} value={k}>{ST[k].t}</option>)}
          </select>
        </label>
      </div>

      {/* 刪除是底下一行紅色小字，不是按鈕（anxing-ui 四-3） */}
      {canEdit && (
        <div className="mt-3 text-center">
          <button onClick={onDel} className="text-xs text-red-400 underline hover:text-red-600">
            刪除{row.kind === 'split' ? `這張切圖（連同 ${row.span} 則）` : '這一則'}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * 文案框。
 *
 * ★★ 底下即時畫出「**實際看得到的那一段**」，不是只寫一個字數 ——
 *   IG 大約 125 字後收成「⋯更多」，而前兩行決定會不會被點開。
 *   只給字數的話，人要自己去換算哪裡斷掉。
 *
 * ★ 存檔在 blur —— 每打一個字就送一次 update 的話，一段文案是兩百次請求。
 */
function Caption({ post, label, readOnly, onSave }: {
  post: Post; label: string; readOnly: boolean; onSave: (v: string) => void;
}) {
  const [v, setV] = useState(post.caption);
  useEffect(() => { setV(post.caption); }, [post.id, post.caption]);
  const cut = captionCut(v);
  return (
    <div className="flex gap-2 items-start">
      {label && (
        <span className="mt-1.5 shrink-0 rounded bg-mor-sand px-1.5 text-[10.5px] font-bold text-[#6b5b3f]">
          {label}
        </span>
      )}
      <div className="flex-1 min-w-0">
        <textarea value={v} readOnly={readOnly}
          onChange={(e) => setV(e.target.value)}
          onBlur={() => { if (v !== post.caption) onSave(v); }}
          className="w-full rounded-lg border border-gray-300 px-2.5 py-1.5 text-sm bg-white
                     min-h-[68px] resize-y" />
        <div className="text-[10.5px] text-amber-700 mt-0.5">
          {cut.over > 0
            ? <><b>{cut.len}</b> 字　·　第 <b>{CAPTION_CUT}</b> 字後收成「⋯更多」，
                還有 <b>{cut.over}</b> 字被藏起來</>
            : <><b>{cut.len}</b> 字　·　不會被截斷</>}
        </div>
        {cut.over > 0 && (
          <div className="mt-1 rounded-lg border border-mor-line bg-white px-2.5 py-1.5
                          text-[11px] leading-relaxed whitespace-pre-wrap">
            <span className="text-gray-400">貼文上實際看得到的：</span>{'\n'}
            {cut.visible}<span className="text-gray-300">⋯更多</span>
          </div>
        )}
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════ */

function NewAccount({ draft, onChange, onClose, onSave }: {
  draft: { name: string; handle: string; bio: string };
  onChange: (d: { name: string; handle: string; bio: string }) => void;
  onClose: () => void;
  onSave: (d: { name: string; handle: string; bio: string }) => void;
}) {
  const [save, saving] = useOnce(async () => { await onSave(draft); });
  const bad = !draft.name.trim() || !draft.handle.trim();
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-sm">
        <div className="px-5 py-3.5 border-b border-mor-line font-bold flex items-center justify-between">
          新增模擬頁
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">✕</button>
        </div>
        <div className="px-5 py-4 grid gap-3 text-sm">
          <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">名稱</span>
            <input value={draft.name} onChange={(e) => onChange({ ...draft, name: e.target.value })}
              placeholder="ESTIA 台北服務式住宅"
              className="rounded-lg border border-gray-300 px-2 py-1.5" /></label>
          <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">帳號（handle）</span>
            <input value={draft.handle} onChange={(e) => onChange({ ...draft, handle: e.target.value })}
              placeholder="estia.tw"
              className="rounded-lg border border-gray-300 px-2 py-1.5" /></label>
          <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">簡介</span>
            <input value={draft.bio} onChange={(e) => onChange({ ...draft, bio: e.target.value })}
              placeholder="中山・南京 ｜ 月租・短租 ｜ 私訊看房"
              className="rounded-lg border border-gray-300 px-2 py-1.5" /></label>
          <div className="text-[11px] text-gray-400 leading-relaxed">
            這裡不會連到真的 IG —— handle 只是用來分辨是哪一面牆。
          </div>
        </div>
        <div className="px-5 py-3 border-t border-mor-line flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg border border-gray-300 px-4 py-1.5 text-sm">取消</button>
          <button onClick={save} disabled={saving || bad}
            title={bad ? '名稱與帳號都要填' : ''}
            className="rounded-lg bg-mor-slate text-white px-4 py-1.5 text-sm font-medium
                       hover:bg-mor-slatedark disabled:opacity-50">
            {saving ? '建立中⋯' : '建立'}</button>
        </div>
      </div>
    </div>
  );
}

/** 讀一張圖進 canvas。★ crossOrigin 要設 —— 簽名網址是跨網域的，不設會汙染 canvas 導不出檔 */
function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => res(img);
    img.onerror = () => rej(new Error('圖讀不到'));
    img.src = url;
  });
}
