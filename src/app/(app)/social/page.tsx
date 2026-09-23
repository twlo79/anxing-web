'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { writeError } from '@/lib/write-guard';
import { createClient } from '@/lib/supabase';
import Toast from '@/components/Toast';
import { useOnce } from '@/lib/once';
import {
  PIN_MAX, COLS, CELL_W, CELL_H, CAPTION_CUT, SPANS,
  layout, pinnedCells, canPin, renumberPins, misaligned, pinShift,
  sourceSize, sliceCrop, sliceBg, publishOrder, sliceFileName, captionCut,
  type Item, type GridCell,
} from '@/lib/social-grid';
import {
  PLATFORMS, PLATFORM_LABEL, parsePlatform,
  FB_VISIBLE_MAX, FB_PIN_MAX, fbOrder, fbCanPin, fbPinProblem,
  type Platform,
} from '@/lib/social-fb';
import FbWall, { Collage, FbPhotoWarnings, photosOf } from './fb-wall';
import {
  addPhotos, movePhoto, removePhoto,
  whyCannotAdd, addMessage, stepPhoto, clampIndex, RESET_INDEX,
} from '@/lib/social-carousel';

/*
 * ══════════════════════════════════════════════════════════
 * 社群經營 → 社群模擬（2026-09-16 建立，2026-09-17 分成 IG 跟 FB）
 *
 * 「模擬 IG 的版面去放照片與文案，可以直接看感覺。」
 * 「改成社群模擬」「分成 IG 跟 FB」（2026-09-17）
 *
 * ══════════════════════════════════════════════════════════
 * 【★★★ 兩個平台不是換個外框而已】
 *
 *   IG　一則 ＝ 一格。會錯的是**格子歪不歪**（切圖跨排）
 *   FB　一則 ＝ 一張拼貼。會錯的是**哪幾張圖被蓋掉**（11 張只有 5 張露臉）
 *
 * 所以工具列、警告、版面、建帳號的表單**四個都跟著平台變**。
 * FB 那一面畫在 `./fb-wall.tsx`，算式在 `lib/social-fb.ts`。
 *
 * ★★ 平台選 A 案（使用者 2026-09-17:「A 比較好」）——
 *   平台在上、帳號在下。一次只看一個平台，跟實際在做的事一樣。
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
  /** 頭像。storage 路徑,沒設就用名字的第一個字 */
  avatar_path: string | null;
  /**
   * 追蹤者／追蹤中。**text 不是數字**（2026-09-16）——
   * 這一頁沒有連 IG,這兩個數字純粹是「讓牆看起來像 IG」的裝飾，
   * 而使用者想打的可能是「12.3萬」。存成整數的話那種寫法存不進去。
   */
  followers: string | null; following: string | null;
  sort: number; active: boolean;
  /**
   * 哪個平台（migration_261）。
   *
   * ★★★ 讀回來一律過 `parsePlatform()` —— 認不得的當 'ig'。
   *   當 null 的話這個帳號在**兩個平台底下都不會出現**，
   *   而畫面上只是一個很正常的「還沒有帳號」，沒有任何錯誤。
   */
  platform: string | null;
  /** 封面照。FB 用，IG 沒有這個東西 */
  cover_path: string | null;
  /** 檔案頭上那一行類別。純顯示 */
  category: string | null;
};
/** 個人檔案的頭，新增與編輯共用同一份草稿 */
type AccDraft = {
  id?: string; name: string; handle: string; bio: string;
  followers: string; following: string; avatar_path: string | null;
  platform: Platform; cover_path: string | null; category: string;
};
const blankAcc = (platform: Platform): AccDraft => ({
  name: '', handle: '', bio: '', followers: '', following: '', avatar_path: null,
  platform, cover_path: null, category: '',
});
/**
 * 既有帳號 → 草稿。
 *
 * ★★ 只有這一份。兩個平台的「編輯」按鈕各自組一次的話，
 *   之後加欄位會有一邊忘了帶 —— 而症狀是「在 FB 那邊編輯完，類別不見了」
 *   （少帶的欄位被當成空值存回去）。
 */
const draftOf = (a: Account): AccDraft => ({
  id: a.id, name: a.name, handle: a.handle, bio: a.bio ?? '',
  followers: a.followers ?? '', following: a.following ?? '',
  avatar_path: a.avatar_path,
  platform: parsePlatform(a.platform),
  cover_path: a.cover_path,
  category: a.category ?? '',
});
type Split = { id: string; account_id: string; source_path: string | null; span: number };
type Post = {
  id: string; account_id: string; sort: number; caption: string;
  image_path: string | null; planned_on: string | null; published_on: string | null;
  status: 'draft' | 'scheduled' | 'published'; pin: number;
  split_id: string | null; split_index: number | null;
  /**
   * FB 拼貼的照片（migration_261）。IG 不用這一欄 —— IG 一格一張，走 `image_path`。
   *
   * ★ 資料庫是 `text[] not null default '{}'`，所以正常情況不會是 null。
   *   型別留 `| null` 是因為 migration 跑之前建的列 select 回來是 undefined，
   *   而那一段時間畫面還是要能開（2026-09-03 的 hk_day.rooms_override 踩過
   *   反過來的版本:欄位不存在,select('*') 只回 undefined,一聲都不叫）。
   */
  images: string[] | null;
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
  /*
   * ══════════ 誰改得動這一頁（2026-09-16）══════════
   *
   * 使用者:「有小編這角色」「沒開不能編輯」「芊和 super admin 可以編輯，
   * 其他人只能讀」。所以這是**一個人一個勾**，不是一種權限 ——
   * 同樣是管家，有的人是小編有的不是，用 role 分不出來。
   *
   * ★★★ 答案**跟資料庫問**（`can_edit_social()`），不在這裡再判斷一次。
   *   那一支同時是三張表與 storage 的 policy 用的東西 ——
   *   **整個功能只有一份規則**。
   *   在前端另外寫一份 `role === … || …` 的話，兩邊遲早會不一樣，
   *   而症狀是「畫面讓你按、存檔卻擋下來」，或反過來
   *   「明明有權限按鈕卻是灰的」。兩種都查不出原因。
   *
   * ★★ 失敗時 fall back 成 false（不能編輯），不是 true。
   *   問不到答案的時候要**關起來**:多按不到一顆按鈕是小事，
   *   讓沒權限的人以為自己能改、改完才發現存不進去是大事。
   */
  const [canEdit, setCanEdit] = useState(false);
  useEffect(() => {
    (async () => {
      const { data, error } = await supabase.rpc('can_edit_social');
      setCanEdit(!error && data === true);
    })();
  }, [supabase]);

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accId, setAccId] = useState('');
  /*
   * ★★ 現在看的是哪個平台（A 案:平台在上、帳號在下）。
   *   預設 IG —— 現有的兩個帳號都是 IG，開頁就有東西看。
   */
  const [plat, setPlat] = useState<Platform>('ig');
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
  /*
   * 個人檔案的頭。`id` 有值＝編輯既有的，沒有＝新增一個 ——
   * ★ 兩個視窗長得一模一樣,所以是同一個元件、同一份草稿。
   *   分成兩個的話，「簡介」那一欄的提示遲早會有一邊沒跟上。
   */
  const [accDraft, setAccDraft] = useState<AccDraft | null>(null);
  const [drag, setDrag] = useState<string | null>(null);

  const flash = (t: string) => { setMsg(t); setTimeout(() => setMsg(''), 3500); };

  /*
   * ★★ 「已存」。這一頁**沒有儲存鈕** —— 文案離開欄位就存、換圖選完就存、
   *   日期與狀態改完就存。但沒有任何回饋的話，使用者不知道自己存到了沒，
   *   於是他會再做一次（2026-09-16 使用者:「內文修改 換圖 也可以直接存嗎」
   *   —— 這個問題本身就是答案:能存，但畫面沒有講）。
   *
   * ★ 只在**成功**時亮。失敗走 flash，那是另一件事。
   */
  const [savedAt, setSavedAt] = useState(0);
  const markSaved = () => {
    setSavedAt(Date.now());
    setTimeout(() => setSavedAt((t) => (Date.now() - t >= 1800 ? 0 : t)), 2000);
  };

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

    /*
     * ★★★ 只在**這個平台**的帳號裡挑。
     *   不過濾的話，從 IG 切到 FB 時分頁列換了、底下的牆卻還是上一個帳號的
     *   —— 畫面上看不出哪裡不對，只覺得「FB 怎麼有 IG 的貼文」。
     */
    const mine = list.filter((a) => parsePlatform(a.platform) === plat);
    const id = accId && mine.some((a) => a.id === accId) ? accId : (mine[0]?.id ?? '');
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
  }, [supabase, accId, plat]);
  useEffect(() => { load(); }, [load]);

  /* 私有 bucket：每張圖都要換一次簽名網址（跟 Receipts 同一套） */
  useEffect(() => {
    (async () => {
      const want = [
        ...posts.map((p) => p.image_path),
        /* ★ FB 的拼貼是好幾張 —— 漏掉的話那幾格永遠停在「圖載入中」 */
        ...posts.flatMap((p) => p.images ?? []),
        ...splits.map((s) => s.source_path),
        ...accounts.map((a) => a.avatar_path),
        ...accounts.map((a) => a.cover_path),
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
  }, [posts, splits, accounts, supabase]);

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
  /*
   * 這一則有幾張照片 —— 鍵盤 ← → 要知道到頭了沒。
   * ★ 走 `photosOf()`（全站唯一一份）。切圖只有一張原圖。
   */
  const shotCount = selRow && selRow.kind === 'post' && selRow.posts[0]
    ? photosOf(selRow.posts[0]).length : 1;

  /* ── FB 那一半 ───────────────────────────────────── */
  const isFb = plat === 'fb';
  /** 分頁列上看得到的帳號 —— 只有這個平台的 */
  const shownAccounts = useMemo(
    () => accounts.filter((a) => parsePlatform(a.platform) === plat),
    [accounts, plat],
  );
  /*
   * ★ FB 沒有切圖 —— `split_id` 有值的一律濾掉。
   *   留著的話一張切圖會在 FB 牆上變成 N 則各一張圖的貼文，
   *   而那在 FB 上不是任何東西。
   */
  const fbPosts = useMemo(
    () => fbOrder(posts.filter((p) => !p.split_id)),
    [posts],
  );
  /** 置頂設超過一則了嗎 —— FB 粉專只吃一則，而畫面上看不出來 */
  const fbPin = useMemo(() => fbPinProblem(fbPosts), [fbPosts]);

  /*
   * ══════════════════════════════════════════════════════════
   * 點一格 → 彈出貼文視窗（2026-09-16 使用者:「每一則點進去要像 IG 介面」
   *   「一個是 read UI 一個是 write UI」「點進去沒有單個 IG 檢視呀」）
   *
   * ★★★ 讀與寫是**兩個畫面**，不是「同一個畫面把輸入框鎖起來」。
   *   鎖起來的輸入框看得出是輸入框，人會一直去點，然後問
   *   「為什麼我不能打字」—— 跟灰掉的分頁同一種毛病。
   *
   * ★★ 而且讀模式回答的是另一個問題:**「這則貼出去長什麼樣」**。
   *   編輯框裡那段永遠是原始碼，換行、hashtag、125 字的收合線都要自己腦補。
   *
   * ★ 點進去先是「讀」—— 看的次數遠多於改的次數，而且沒有編輯權限的人
   *   只有這一面（「寫」那顆根本不出現，不是灰掉）。
   * ══════════════════════════════════════════════════════════
   */
  const [pmode, setPmode] = useState<'read' | 'write'>('read');
  /* 每次換一則都回到「讀」—— 上一則停在編輯模式不該影響下一則 */
  useEffect(() => { setPmode('read'); }, [sel]);

  /*
   * ══════════════════════════════════════════════════════════
   * 輪播:現在在看第幾張（2026-09-18）
   * ══════════════════════════════════════════════════════════
   *
   * ★★★ 原本這裡是 `walk` ＋ `goRel`（視窗裡的上一則／下一則），
   *   2026-09-18 **整組拿掉** —— 使用者:「換一則 要跳出來 —— 跳到九宮格」。
   *   照片左右讓給了輪播，兩組箭頭不能疊在同一個位置。
   *
   * ★★ 換一則之後回到第 0 張。留在上一則的第 3 張的話，
   *   下一則只有 1 張時畫面是空的 —— 而那看起來像「照片不見了」。
   */
  const [shot, setShot] = useState(RESET_INDEX);
  useEffect(() => { setShot(RESET_INDEX); }, [sel]);

  /*
   * ★★ 鍵盤:Esc 關、左右換一則。
   *   ★ 游標在輸入框裡的時候左右鍵**不換則** —— 不然打字打到一半會跳走。
   */
  useEffect(() => {
    if (!sel) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName);
      if (e.key === 'Escape') { setSel(null); return; }
      if (typing) return;
      /*
       * ★★★ ← → 是**換照片**，跟照片左右那兩顆做同一件事
       *   （2026-09-18 使用者選了「甲 左右改成換照片」）。
       *
       *   鍵盤跟按鈕做不同的事，是最難查的那種 bug ——
       *   畫面上沒有任何地方說得出差別，而使用者會以為系統時好時壞。
       *
       * ★ 換一則沒有快捷鍵了:Esc 回九宮格，再點下一則。
       */
      if (e.key === 'ArrowLeft') setShot((i) => stepPhoto(i, -1, shotCount));
      if (e.key === 'ArrowRight') setShot((i) => stepPhoto(i, 1, shotCount));
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [sel, shotCount]);

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
    if (!canEdit) return flash('你不是小編，改不動這一頁 —— 請總經理到「權限設定 → 人員」幫你打勾。');

    /*
     * ★★★ FB 只能置頂**一則**（IG 是 3 格）。
     *   而且 FB 的 pin 沒有「第幾格」的概念 —— 是就是 1，不是就是 0。
     *   照 IG 那套算格位的話，一則貼文會拿到 1、下一則拿到 2，
     *   然後兩則都以為自己被置頂了，而貼到 FB 上只有一則會是。
     */
    if (isFb) {
      const p = r.posts[0];
      if (!p) return;
      if (r.pin > 0) return patch(p, { pin: 0 });
      const ok = fbCanPin(fbPosts, { id: r.id, pin: r.pin });
      if (!ok.ok) return flash(ok.why);
      return patch(p, { pin: 1 });
    }

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

  /**
   * 改一格的內容（文案、日期、狀態、照片）—— **改完就存，沒有儲存鈕**。
   *
   * ★★★ `.select('id')` 不能省。RLS 擋下來的 UPDATE **回成功且影響 0 列**，
   *   不是錯誤（CLAUDE.md 那條坑）。只接 `error` 的話:
   *   存檔「成功」→ 樂觀更新把畫面改了 → 重新整理跳回舊值，
   *   而中間沒有任何一句話。使用者會以為是系統自己改回去的。
   *
   * ★★ 所以 0 列的時候**不動畫面**。留著假數字比沒改更糟 ——
   *   他會照著那個假數字去做下一件事。
   */
  const patch = async (p: Post, fields: Partial<Post>) => {
    if (!canEdit) return flash('你不是小編，改不動這一頁 —— 請總經理到「權限設定 → 人員」幫你打勾。');
    const { data, error } = await supabase.from('social_posts')
      .update(fields).eq('id', p.id).select('id');
    if (error) return flash('存不起來：' + error.message);
    if (!data?.length) return flash('沒有存到 —— 你的權限改不動這一頁，畫面沒有變。');
    setPosts((xs) => xs.map((x) => (x.id === p.id ? { ...x, ...fields } : x)));
    markSaved();
  };

  /** 上傳一個檔案，回傳 storage 路徑 */
  const put = async (file: File): Promise<string | null> => {
    const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().slice(0, 5);
    const path = `${accId}/${Date.now()}_${crypto.randomUUID()}.${ext}`;
    const { error } = await supabase.storage.from(BUCKET)
      .upload(path, file, { contentType: file.type || 'image/jpeg', upsert: false });
    if (error) { flash('上傳失敗：' + error.message); return null; }
    /*
     * ★★ 傳完**當場**換一張簽名網址。
     *   等 `load()` 的話，選完頭像到看得到中間有一段畫面沒反應 ——
     *   而那段時間使用者會以為沒選到，再選一次。
     */
    const { data } = await supabase.storage.from(BUCKET).createSignedUrl(path, 3600);
    if (data?.signedUrl) setUrls((u) => ({ ...u, [path]: data.signedUrl }));
    return path;
  };

  const addPost = async () => {
    if (!accId) return flash('先新增一個模擬頁。');
    if (!canEdit) return flash('你不是小編，改不動這一頁 —— 請總經理到「權限設定 → 人員」幫你打勾。');
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
    if (!canEdit) return flash('你不是小編，改不動這一頁 —— 請總經理到「權限設定 → 人員」幫你打勾。');
    const { data: sp, error: se } = await supabase.from('social_splits')
      .insert({ account_id: accId, span }).select().single();
    if (se) return flash('新增失敗：' + se.message);
    const { error: pe } = await supabase.from('social_posts').insert(
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
    if (!canEdit) return flash('你不是小編，改不動這一頁 —— 請總經理到「權限設定 → 人員」幫你打勾。');
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
    if (!canEdit) return flash('你不是小編，改不動這一頁 —— 請總經理到「權限設定 → 人員」幫你打勾。');
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
      flash(`切好了 ${order.length} 張 —— 檔名 01 的那張先貼。`);
    } catch (e: any) {
      flash('切不出來：' + (e?.message ?? e));
    } finally { setCutting(false); }
  };

  /* ══════════════════════════════════════════════════ */
  return (
    /*
     * ══════════════════════════════════════════════════════════
     * ★★ 整頁置中（2026-09-16 使用者:「全部置中吧」）。
     *
     *   右邊那塊編輯面板收掉之後，這一頁只剩一欄 ——
     *   靠左貼著的話，寬螢幕上右邊會空掉一大片，而那片空白
     *   看起來像「還有東西沒載出來」。
     *
     * ★★★ 分頁、工具列、提示、九宮格**用同一個寬度**（`max-w-[640px]`）。
     *   只把九宮格置中、其他留在全寬的話，那幾條線會各自對齊到不同的地方，
     *   人看到的是「這一頁沒有對齊」—— 比全部靠左更糟。
     *
     * ★ 640px 而不是 560:一格變成約 212px，而工具列那五顆按鈕
     *   在這個寬度剛好排兩排。再窄就要排三排了。
     * ══════════════════════════════════════════════════════════
     */
    <div className="max-w-[640px] mx-auto">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <h1>社群模擬
          <span className="text-sm font-normal text-gray-400 ml-2">
            把要貼的排出來，直接看整體感覺
          </span>
        </h1>
      </div>

      {/*
        ── 平台（A 案，使用者 2026-09-17:「A 比較好」）──

        ★★★ 平台在**帳號分頁的上面**，不是混在同一排。
          理由是工具列會跟著平台變形（IG 有切圖、FB 有置頂）——
          混在一排的話，同一個位置有時候有按鈕有時候沒有，
          而那種「按鈕自己消失」的畫面比多點一下更難用。
      */}
      <div className="inline-flex bg-mor-sand border border-mor-line rounded-xl p-[3px] gap-[3px] mb-3">
        {PLATFORMS.map((p) => (
          <button key={p} onClick={() => { if (p !== plat) { setPlat(p); setSel(null); } }}
            className={`px-5 py-1.5 rounded-lg text-uisub ${
              p === plat ? 'bg-white text-mor-ink font-semibold shadow-sm'
                         : 'text-gray-500 hover:text-mor-ink'}`}>
            <span className={`inline-block w-2 h-2 rounded-full mr-1.5 align-middle ${
              p === 'ig' ? 'bg-[#C13584]' : 'bg-[#1877F2]'}`} />
            {PLATFORM_LABEL[p]}
          </button>
        ))}
      </div>

      {/*
        ── 模擬頁分頁籤 ──

        ★★ 「＋」是**分頁列最後一個分頁**，不是右上角的按鈕
          （2026-09-16 使用者:「可以 tab 加個額外的 tab，裡面有一個加號」）。
          新增一個模擬頁跟切換模擬頁是同一件事的兩面 —— 入口放在一起，
          而右上角那顆離分頁列有半個螢幕遠。
      */}
      <div className="flex flex-wrap gap-1 border-b border-mor-line mb-3">
        {shownAccounts.map((a) => (
          <button key={a.id} onClick={() => { setAccId(a.id); setSel(null); }}
            className={`px-3.5 py-2 text-uisub rounded-t-lg border border-b-0 -mb-px ${
              a.id === accId ? 'bg-white border-mor-line font-semibold text-mor-ink'
                             : 'border-transparent text-gray-500 hover:bg-mor-sand/60'}`}>
            {a.handle}
          </button>
        ))}
        {canEdit && (
          /* ★ 新的帳號建在**現在看的那個平台**底下 —— 不然建完會看不到它 */
          <button onClick={() => setAccDraft(blankAcc(plat))}
            title={`新增一個 ${PLATFORM_LABEL[plat]} 模擬頁`}
            className="px-3.5 py-2 text-uisub rounded-t-lg border border-b-0 -mb-px
                       border-transparent text-mor-slate hover:bg-mor-bluelight/60">
            ＋
          </button>
        )}
        {!shownAccounts.length && !loading && (
          <div className="py-2 text-sm text-gray-400">
            還沒有 {PLATFORM_LABEL[plat]} 模擬頁{canEdit ? ' —— 按上面那顆「＋」開一個。' : '。'}
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
              {/*
                ★★ 切圖是 **IG 專屬**。FB 沒有九宮格，也就沒有「跨幾格」這回事 ——
                  在 FB 底下留著這三顆的話，按下去會產生三則各一張圖的貼文，
                  而那在 FB 上不是任何東西。
              */}
              {!isFb && SPANS.map((n) => (
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
              {isFb ? <>
                共 <b className="text-mor-ink">{fbPosts.length}</b> 則
                📌 <b className="text-mor-ink">{fbPin.n} / {FB_PIN_MAX}</b>
              </> : <>
                共 <b className="text-mor-ink">{cells.length}</b> 格
                📌 <b className="text-mor-ink">{pinUsed} / {PIN_MAX}</b>
              </>}
            </span>
          </div>

          {/*
            ── FB 的提示 ──
            ★ 跟 IG 的切圖警告同一個位置（貼文清單正上方），
              不是頁面最上方 —— 訊息要出現在動作發生的地方（README 那條坑）。
          */}
          {isFb && fbPin.bad && (
            <div className="mb-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5
                            text-xs text-amber-900 leading-relaxed">
              📌 <b>置頂了 {fbPin.n} 則</b> —— {fbPin.why}
            </div>
          )}
          {isFb && <FbPhotoWarnings posts={fbPosts} onSelect={setSel} />}

          {/* ── 提示：釘選推歪 ＋ 切圖沒對齊（IG）── */}
          {!isFb && bad.length > 0 && shift > 0 && (
            <div className="mb-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5
                            text-xs text-amber-900 leading-relaxed">
              📌 <b>釘選了 {pinUsed} 格，不是 {COLS} 的倍數</b> —— 底下整面牆往後推了 {shift} 格，
              所以下面的切圖跟著歪。釘選要嘛 <b>0 格</b>、要嘛 <b>{COLS} 格（剛好一排）</b>。
            </div>
          )}
          {!isFb && bad.map((m) => (
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

          {/*
            ══════════ 版面（2026-09-16 改）══════════

            ★★★ 右邊那塊編輯面板整塊拿掉，改成**點格子彈出視窗**。
              這一頁的重點是「看整體感覺」，而一格只有 112px 寬的時候，
              看不出來的正是要看的那件事。放大到 560px 之後一格約 185px，
              跟真的 IG 個人頁差不多。

            ★★ 代價講在前面:**不能再一邊看版面一邊改文案** ——
              視窗會蓋住九宮格。IG 本身就是這樣，而且編輯框因此大了四倍。
          */}
          {/* ★ 只剩一欄了，不需要 flex —— 留著的話 `gap-5` 會在底下多一段沒人要的空白 */}
          <div>
            {isFb ? (
              /*
                ══ FB 的牆 ══
                ★ 畫在 `./fb-wall.tsx` —— 它跟九宮格沒有一行共用的地方，
                  硬塞在這裡會讓兩邊的條件判斷交纏在一起。
              */
              <FbWall
                acc={{
                  id: acc.id, name: acc.name, handle: acc.handle, bio: acc.bio,
                  category: acc.category, followers: acc.followers, following: acc.following,
                  avatar_path: acc.avatar_path, cover_path: acc.cover_path,
                }}
                posts={fbPosts} urls={urls} clean={clean} sel={sel} canEdit={canEdit}
                onSelect={setSel}
                onEditAcc={() => setAccDraft(draftOf(acc))} />
            ) : (
            /* ══ 手機 ══ */
            <div className="w-full rounded-2xl border border-mor-line bg-white overflow-hidden">
              {/*
                ══════════ 個人檔案的頭（2026-09-16 使用者:「這些都可以再編輯」）══════════

                ★★ 頭像、名稱、簡介、追蹤者都改得動。建立時填一次就鎖死的話，
                  打錯字只能砍掉重建 —— 而砍掉會連同底下所有的貼文一起消失。

                ★ 「編輯」放在這一塊的**右上角**，不是丟到別的頁面去 ——
                  要改的東西就在眼前，入口也該在眼前。
              */}
              <div className="px-3.5 py-3 border-b border-[#EFEFEF] relative">
                {canEdit && (
                  <button onClick={() => setAccDraft(draftOf(acc))}
                    className="absolute right-3 top-2.5 text-[11px] text-mor-slate
                               hover:text-mor-slatedark">編輯</button>
                )}
                <div className="flex items-center gap-3.5">
                  <span className="w-[54px] h-[54px] rounded-full shrink-0 flex items-center justify-center"
                    style={{ background: 'conic-gradient(from 210deg,#C9A227,#3FAE7C,#41689B,#C9A227)' }}>
                    {acc.avatar_path && urls[acc.avatar_path] ? (
                      <img src={urls[acc.avatar_path]} alt=""
                        className="w-12 h-12 rounded-full object-cover bg-white" />
                    ) : (
                      <span className="w-12 h-12 rounded-full bg-white flex items-center justify-center
                                       text-[15px] font-extrabold text-mor-slate">
                        {(acc.name || acc.handle).slice(0, 1)}
                      </span>
                    )}
                  </span>
                  <div className="flex gap-5 text-center text-xs">
                    {/* ★ 貼文數是**算出來的**（幾格就是幾則），不給改 —— 給改就會跟牆對不上 */}
                    <div><b className="block text-sm">{cells.length}</b>
                      <span className="text-gray-500 text-[11px]">貼文</span></div>
                    {/*
                      ★★ 追蹤者與追蹤中是**使用者自己打的裝飾**,不是從 IG 讀來的。
                        沒填就留一個灰色的破折號 —— 塞一個假數字進去的話,
                        看到的人會以為那是真的。
                    */}
                    <div><b className={`block text-sm ${acc.followers ? '' : 'text-gray-300'}`}>
                      {acc.followers || '—'}</b>
                      <span className="text-gray-500 text-[11px]">追蹤者</span></div>
                    <div><b className={`block text-sm ${acc.following ? '' : 'text-gray-300'}`}>
                      {acc.following || '—'}</b>
                      <span className="text-gray-500 text-[11px]">追蹤中</span></div>
                  </div>
                </div>
                <div className="mt-2 text-xs leading-relaxed">
                  <b>{acc.name}</b>
                  {acc.bio && <div className="text-gray-500 whitespace-pre-wrap">{acc.bio}</div>}
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
            )}
          </div>

          <p className="text-[11px] text-gray-400 mt-3 leading-relaxed">
            這一頁<b>沒有連到真的 {isFb ? 'FB' : 'IG'}</b> —— 不發佈、不讀追蹤者。
            它是一面牆的草稿，排好之後自己去貼。
            {isFb
              ? <> FB 一則貼文只有<b>前 {FB_VISIBLE_MAX} 張</b>看得到，
                  第 {FB_VISIBLE_MAX + 1} 張以後蓋在「＋N」底下。</>
              : <> 九宮格是 <b>4:5</b>（1080×1350），不是正方形。</>}
          </p>
        </>
      )}

      {/*
        ══════════ 單則貼文的視窗（讀／寫）══════════

        ★★★ 沒有編輯權限的人只有「讀」那一面 —— 「寫」那顆**不出現**，
          不是灰掉。灰掉的按鈕會讓人一直去點，然後問為什麼不能用。
      */}
      {selRow && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          onClick={(e) => { if (e.target === e.currentTarget) setSel(null); }}>
          <div className="w-full max-w-[980px] max-h-[92vh] rounded-2xl bg-white overflow-hidden
                          flex flex-col md:flex-row shadow-2xl">
            {/* ── 左:照片 ── */}
            <div className="relative bg-black md:basis-[46%] md:shrink-0 flex items-center justify-center">
              {(() => {
                /* ★ FB 是一張拼貼，不是一張圖 —— 用牆上那一支同一個元件畫 */
                if (isFb) {
                  const p = selRow.posts[0];
                  const paths = p ? photosOf(p) : [];
                  return paths.length
                    ? <div className="w-full bg-white"><Collage paths={paths} urls={urls} /></div>
                    : <div className="w-full aspect-[4/5] flex items-center justify-center
                                      text-white/45 text-sm">還沒有照片</div>;
                }
                /*
                 * ★★★ 輪播（2026-09-18 使用者:「像 IG 一則貼文可以放多張滑過去」）。
                 *   照片一律走 `photosOf()` —— `images` 有東西就用它，
                 *   空的才退回 `image_path`（migration_283）。
                 */
                const shots = selRow.kind === 'split'
                  ? (selRow.split?.source_path ? [selRow.split.source_path] : [])
                  : (selRow.posts[0] ? photosOf(selRow.posts[0]) : []);
                const at = clampIndex(shot, shots.length);
                const u = shots[at] ? urls[shots[at]] : null;
                if (!u) {
                  return <div className="w-full aspect-[4/5] flex items-center justify-center
                                         text-white/45 text-sm">還沒有照片</div>;
                }
                return <>
                  <img src={u} alt="" className="w-full aspect-[4/5] object-cover" />
                  {shots.length > 1 && <>
                    {/*
                      ★★★ 這一組是**換照片**，不是換一則
                        （2026-09-18 使用者:「甲 左右改成換照片」）。
                      ★ 到頭就停，而且**停住的那一顆整顆不出現**，不是灰掉 ——
                        灰掉的鈕不會告訴人為什麼按不動（anxing-ui 二-6）。
                        IG 本身也是到頭就停。
                    */}
                    {at > 0 && (
                      <button onClick={() => setShot(stepPhoto(at, -1, shots.length))}
                        title="上一張"
                        className="absolute left-2 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full
                                   bg-white/90 hover:bg-white text-mor-ink text-lg leading-none z-10">‹</button>
                    )}
                    {at < shots.length - 1 && (
                      <button onClick={() => setShot(stepPhoto(at, 1, shots.length))}
                        title="下一張"
                        className="absolute right-2 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full
                                   bg-white/90 hover:bg-white text-mor-ink text-lg leading-none z-10">›</button>
                    )}
                    <span className="absolute right-2 top-2 rounded-full bg-black/60 text-white
                                     text-[11px] px-2 py-0.5 z-10">{at + 1} / {shots.length}</span>
                    <span className="absolute inset-x-0 bottom-2 flex justify-center gap-1 z-10">
                      {shots.map((_, k) => (
                        <button key={k} onClick={() => setShot(k)} title={`第 ${k + 1} 張`}
                          className={`w-1.5 h-1.5 rounded-full ${
                            k === at ? 'bg-white' : 'bg-white/45 hover:bg-white/70'}`} />
                      ))}
                    </span>
                  </>}
                </>;
              })()}
              {/*
                ★ 上一則／下一則放在照片左右兩側（IG 也在那）。
                  ★★ 這不是排序 —— 排序的 ◀ ▶ 在右半「寫」那一面裡面。
                    兩組長得一樣但做的事不同，所以這一組用 ‹ ›、標題也寫清楚。
              */}
              {/*
                ★★★ 這裡原本是「上一則／下一則」，2026-09-18 **整組拿掉**
                  （使用者:「換一則 要跳出來 —— 跳到九宮格，之後再點下一則」）。

                  照片左右現在是**換照片**。兩組長得一樣的箭頭疊在同一個位置，
                  是手滑的來源 —— 而按錯的代價不一樣:換照片看一眼就知道，
                  換一則會讓人以為自己剛剛改的那一則不見了。

                ★ 換一則只剩一條路:Esc（或點外面）回九宮格，再點下一則。
                  少一個控制項，但**不會有人搞錯自己按了什麼**。
              */}
            </div>

            {/* ── 右:讀／寫 ── */}
            <div className="flex-1 min-w-0 flex flex-col">
              <div className="flex items-center gap-2.5 px-4 py-3 border-b border-mor-line">
                <span className="w-8 h-8 rounded-full shrink-0 flex items-center justify-center"
                  style={{ background: 'conic-gradient(from 210deg,#C9A227,#3FAE7C,#41689B,#C9A227)' }}>
                  {acc?.avatar_path && urls[acc.avatar_path] ? (
                    <img src={urls[acc.avatar_path]} alt=""
                      className="w-7 h-7 rounded-full object-cover bg-white" />
                  ) : (
                    <span className="w-7 h-7 rounded-full bg-white flex items-center justify-center
                                     text-[11px] font-extrabold text-mor-slate">
                      {(acc?.name || acc?.handle || '?').slice(0, 1)}
                    </span>
                  )}
                </span>
                <span className="font-semibold text-sm flex-1 min-w-0 truncate">{acc?.handle}</span>
                <span className="text-[11px] text-gray-500 whitespace-nowrap">
                  {selRow.kind === 'split'
                    ? `第 ${(selCell?.seq ?? 0) - selRow.span + 1}～${selCell?.seq ?? 0} 則`
                    : `第 ${selCell?.seq ?? 0} 則`}
                </span>
                <button onClick={() => setSel(null)} title="關閉（Esc）"
                  className="text-gray-400 hover:text-mor-ink text-lg leading-none">✕</button>
              </div>

              <div className="flex items-center gap-1.5 px-4 py-2 border-b border-mor-line bg-mor-sand/30">
                <button onClick={() => setPmode('read')}
                  className={`rounded-full border px-3 py-1 text-xs ${
                    pmode === 'read' ? 'bg-mor-ink border-mor-ink text-white font-semibold'
                                     : 'bg-white border-mor-line text-gray-600'}`}>👁 讀</button>
                {canEdit && (
                  <button onClick={() => setPmode('write')}
                    className={`rounded-full border px-3 py-1 text-xs ${
                      pmode === 'write' ? 'bg-mor-ink border-mor-ink text-white font-semibold'
                                        : 'bg-white border-mor-line text-gray-600'}`}>✎ 寫</button>
                )}
                {!canEdit && (
                  <span className="ml-auto text-[11px] text-gray-400">你的權限只能看，不能編</span>
                )}
                <span className="ml-auto text-[11px] text-gray-300 hidden md:inline">
                  ← → 換一則・Esc 關閉
                </span>
              </div>

              <div className="flex-1 overflow-y-auto p-4">
                {pmode === 'read'
                  ? <ReadPost row={selRow} seq={selCell?.seq ?? 0} handle={acc?.handle ?? ''} />
                  : (
<Panel row={selRow} seq={selCell?.seq ?? 0} urls={urls} savedAt={savedAt}
                canEdit={canEdit} cutting={cutting} isFb={isFb}
                pinCheck={isFb
                  ? fbCanPin(fbPosts, { id: selRow.id, pin: selRow.pin })
                  : canPin(rows, selRow)}
                onFbAdd={async (files, post) => {
                  /*
                   * ★★ 一張一張傳，傳完**一次**寫回去。
                   *   每傳一張就 update 的話，後面那次會用到前面那次之前的
                   *   `images`（state 還沒回來）—— 結果只留下最後一張。
                   */
                  const got: string[] = [];
                  for (const f of Array.from(files)) {
                    const path = await put(f);
                    if (path) got.push(path);
                  }
                  if (!got.length) return;
                  await patch(post, { images: [...photosOf(post), ...got] });
                }}
                onFbSet={async (post, paths) => { await patch(post, { images: paths }); }}
                /*
                 * ══════════════════════════════════════════════
                 * IG 輪播（2026-09-18）
                 * ══════════════════════════════════════════════
                 * ★★★ 只寫 `images`。`image_path` 從 migration_283 起
                 *   不再是真實來源 —— 兩邊都寫的話同一張圖存在兩個地方，
                 *   改了一邊另一邊留在原地（migration_195 那條坑）。
                 */
                onIgSet={async (post, paths) => { await patch(post, { images: paths }); }}
                onIgAdd={async (files, post) => {
                  if (!files?.length) return;
                  /*
                   * ★★★ 一張一張傳完**再一次寫回去**。
                   *   每傳一張就 patch 的話，第二次 patch 讀到的還是舊的
                   *   `images`（state 還沒回來）—— 結果只留下最後一張。
                   *   FB 那一支同一條坑，抄它的寫法。
                   */
                  const got: string[] = [];
                  for (const f of Array.from(files)) {
                    const path = await put(f);
                    if (path) got.push(path);
                  }
                  if (!got.length) return;
                  const r = addPhotos(photosOf(post), got);
                  await patch(post, { images: r.next });
                  /* ★ 超過上限時要講 —— 安靜吃掉的話他以為 12 張都在 */
                  const msg = addMessage(r);
                  if (msg) flash(msg);
                }}
                onPatch={patch} onPin={() => togglePin(selRow)} onDel={() => del(selRow)}
                onNudge={(d) => nudge(selRow.id, d)}
                onSlices={() => downloadSlices(selRow)}
                onUpload={async (file, post) => {
                  const path = await put(file);
                  if (!path) return;
                  if (selRow.kind === 'split' && selRow.split) {
                    /* ★ 同上:RLS 擋下來回的是「成功、0 列」,一定要接 select */
                    const { data, error } = await supabase.from('social_splits')
                      .update({ source_path: path }).eq('id', selRow.split.id).select('id');
                    if (error) return flash('存不起來：' + error.message);
                    if (!data?.length) return flash('沒有存到 —— 你的權限改不動這一頁。');
                    markSaved();
                  } else if (post) {
                    await patch(post, { image_path: path });
                  }
                  load();
                }} />
                  )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── 新增／編輯模擬頁（同一個視窗）── */}
      {accDraft && (
        <AccountForm draft={accDraft} onChange={setAccDraft} onClose={() => setAccDraft(null)}
          url={accDraft.avatar_path ? urls[accDraft.avatar_path] : null}
          coverUrl={accDraft.cover_path ? urls[accDraft.cover_path] : null}
          onPickAvatar={async (f) => {
            const path = await put(f);
            if (path) setAccDraft((d) => (d ? { ...d, avatar_path: path } : d));
          }}
          onPickCover={async (f) => {
            const path = await put(f);
            if (path) setAccDraft((d) => (d ? { ...d, cover_path: path } : d));
          }}
          onSave={async (d) => {
            const body = {
              name: d.name.trim(),
              handle: d.handle.trim().replace(/^@/, ''),
              bio: d.bio.trim() || null,
              followers: d.followers.trim() || null,
              following: d.following.trim() || null,
              avatar_path: d.avatar_path,
              category: d.category.trim() || null,
              cover_path: d.cover_path,
            };
            /*
             * ★★★ `platform` 只在**新增**時寫進去，編輯時不帶。
             *   改平台會讓底下的貼文去讀另一支空的照片欄位
             *   （IG 讀 image_path、FB 讀 images）—— 照片沒有不見，
             *   但畫面上全部變成空格，而且不會有任何錯誤。
             */
            const { error } = d.id
              ? await supabase.from('social_accounts').update(body).eq('id', d.id)
              : await supabase.from('social_accounts')
                  .insert({ ...body, platform: d.platform, sort: accounts.length });
            if (error) return flash((d.id ? '存不起來：' : '建不起來：') + error.message);
            /* ★ 新建的帳號在哪個平台，就切到那個平台 —— 不然建完會看不到它 */
            if (!d.id) setPlat(d.platform);
            setAccDraft(null);
            load();
          }}
          onDeactivate={async () => {
            if (!accDraft.id) return;
            /*
             * ★★ 停用不是刪除。這個模擬頁底下可能有幾十格的文案與照片 ——
             *   刪掉會 cascade 掉全部,而「我只是不想在分頁籤上看到它」
             *   跟「我要把它全部丟掉」是兩件事。
             */
            if (!confirm('停用這個模擬頁？\n\n它會從上面的分頁籤消失，但貼文與照片都留著。')) return;
            const r = await supabase.from('social_accounts')
              .update({ active: false }).eq('id', accDraft.id).select('id');
            const bad = writeError(r, '停用'); if (bad) return flash(bad);
            setAccDraft(null);
            setAccId('');
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
  /*
   * ★★★ 照片一律走 `photosOf()`（全站唯一一份）——
   *   `images` 有東西就用它、空的才退回 `image_path`（migration_283）。
   *   這裡直接讀 `image_path` 的話，多圖那幾則會顯示舊的封面
   *   而且沒有任何地方會叫（CLAUDE.md:一份資料存在兩個地方）。
   */
  const shots = r.kind === 'post' && r.posts[0] ? photosOf(r.posts[0]) : [];
  const path = r.kind === 'split' ? r.split?.source_path : shots[0];
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

      {/*
        ★★★ 多圖的疊圖記號。**放在 `!clean` 外面**是刻意的 ——
          IG 真的會顯示它，所以「乾淨模式」（看起來像真的 IG）也要有。
          虛線、序號、狀態籤那些是規劃用的，才藏。
        ★ 不標的話九宮格上多圖與單圖長得一模一樣，
          排版時看不出哪幾則其實有五張（2026-09-18 使用者:「要加」）。
      */}
      {shots.length > 1 && cell.slice === 0 && (
        <span className="absolute right-1 top-1 w-[13px] h-[13px] pointer-events-none"
              title={`${shots.length} 張`}>
          <span className="absolute right-0 top-0 block w-[9px] h-[9px] rounded-[2px]
                           border-[1.4px] border-white bg-black/20 drop-shadow" />
          <span className="absolute right-[3px] top-[3px] block w-[9px] h-[9px] rounded-[2px]
                           border-[1.4px] border-white bg-black/30 drop-shadow" />
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
        {/* ★ 有疊圖記號時往下挪一點 —— 兩個東西疊在同一個角落會糊成一團 */}
        {r.pin > 0 && cell.slice === 0 && (
          <span className={`absolute right-1 text-[11px] drop-shadow ${
            shots.length > 1 ? 'top-[18px]' : 'top-1'}`}>📌</span>
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

function Panel({ row, seq, urls, savedAt, canEdit, cutting, isFb, pinCheck,
  onPatch, onPin, onDel, onNudge, onSlices, onUpload, onFbAdd, onFbSet,
  onIgSet, onIgAdd }: {
  row: Row; seq: number; urls: Record<string, string>;
  /** 剛存好的時間戳。0 ＝ 沒有剛存過 */
  savedAt: number;
  canEdit: boolean; cutting: boolean;
  /** 這一則屬於 FB 的帳號 */
  isFb: boolean;
  /**
   * 釘選／置頂能不能再加一則。
   *
   * ★★ **在外面算好傳進來**，不是在這裡再判斷一次 —— IG 算的是格數
   *   （切圖吃掉 3 格）、FB 算的是則數（上限 1 則），規則完全不同。
   *   在這裡用 `isFb ? … : …` 的話，這條規則就在兩個地方各有一份
   *   （README 坑 A），而遲早有一邊沒跟上。
   */
  pinCheck: { ok: boolean; why: string };
  onPatch: (p: Post, f: Partial<Post>) => void;
  onPin: () => void; onDel: () => void; onNudge: (d: -1 | 1) => void;
  onSlices: () => void;
  onUpload: (file: File, post: Post | null) => void;
  /** FB：加照片（可以一次選好幾張） */
  onFbAdd: (files: FileList, post: Post) => void;
  /** FB：把照片換成這一串（刪除與換順序都走這支） */
  onFbSet: (post: Post, paths: string[]) => void;
  /** IG 輪播：整批換掉這一則的照片（換順序、拿掉都走它） */
  onIgSet: (post: Post, paths: string[]) => void;
  /** IG 輪播：加幾張進去 */
  onIgAdd: (files: FileList | null, post: Post) => void;
}) {
  const file = useRef<HTMLInputElement>(null);
  const fbFile = useRef<HTMLInputElement>(null);
  const lock = row.status === 'published';
  const pin = pinCheck;
  const fbPost = row.posts[0] ?? null;
  const fbPaths = fbPost ? photosOf(fbPost) : [];
  /*
   * ★★★ IG 也是多張（2026-09-18）。照片一律走 `photosOf()` ——
   *   `images` 有東西就用它、空的才退回 `image_path`（migration_283）。
   * ★ 寫只寫 `images` —— `image_path` 從這一天起不再是真實來源。
   */
  const igPost = row.kind === 'post' ? (row.posts[0] ?? null) : null;
  const igPaths = igPost ? photosOf(igPost) : [];
  const src = row.kind === 'split' ? row.split?.source_path : igPaths[0];
  const url = src ? urls[src] : null;
  const addBlocked = whyCannotAdd(igPaths);
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
          {/* ★ 這一頁沒有儲存鈕 —— 存好了要說一聲,不然沒有人知道自己存到了沒 */}
          {savedAt > 0 && (
            <span className="ml-2 text-[11px] font-normal text-mor-greendark">✓ 已存</span>
          )}
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
        <span className="block mt-0.5 text-gray-400">
          沒有儲存鈕 —— 文案<b>點到別的地方</b>就存，換圖、日期、狀態改完就存。
        </span>
      </p>

      {/* ── 釘選 ── */}
      {canEdit && (
        <div className={`mt-3 rounded-lg border px-3 py-2 text-sm ${
          row.pin > 0 ? 'border-[#C9A227] bg-[#FFFBF0]' : 'border-mor-line bg-white'}`}>
          <label className={`flex items-start gap-2 ${pin.ok ? 'cursor-pointer' : 'cursor-default'}`}>
            <input type="checkbox" className="mt-0.5" checked={row.pin > 0}
              disabled={!pin.ok} onChange={onPin} />
            <span>
              <b>{isFb ? '置頂這一則' : '釘選到最上方'}</b>
              {!isFb && row.pin > 0 ? `（第 ${row.pin} 個）` : ''}
              <span className="block text-[11px] text-gray-500 mt-0.5 leading-relaxed">
                {!pin.ok ? pin.why
                  : isFb
                    ? `FB 粉專只能置頂 ${FB_PIN_MAX} 則 —— 換一則的話，先把原本那則取消。`
                    : row.span > 1
                      ? `這張切圖會用掉 ${row.span} 格釘選額度（IG 上限 ${PIN_MAX} 格）——
                         剛好把一整排釘在最上面，底下不會被推歪。`
                      : `只是把它拉到版面最上方，不會改變發佈日期或序號。`}
              </span>
            </span>
          </label>
        </div>
      )}

      {/*
        ── 圖（FB：一則好幾張）──

        ★★★ 前 {FB_VISIBLE_MAX} 張畫實線、其餘畫成半透明並標「蓋住」——
          這是整個 FB 模擬要回答的那一題。只寫一句「超過 5 張」的話，
          人還是要自己數到第幾張才被蓋掉。
      */}
      {isFb && fbPost ? (
        <div className="mt-3">
          <div className="text-[11px] text-gray-500 mb-1">
            照片　共 {fbPaths.length} 張
            {fbPaths.length > FB_VISIBLE_MAX && (
              <b className="text-amber-700 ml-1">
                　只有前 {FB_VISIBLE_MAX} 張看得到
              </b>
            )}
          </div>
          {fbPaths.length > 0 && (
            <div className="grid grid-cols-5 gap-1.5">
              {fbPaths.map((p, i) => {
                const hiddenOne = i >= FB_VISIBLE_MAX;
                return (
                  <div key={`${p}/${i}`}
                    className={`relative aspect-square rounded-lg overflow-hidden border ${
                      hiddenOne ? 'border-amber-300 opacity-45' : 'border-mor-line'}`}>
                    {urls[p]
                      ? <img src={urls[p]} alt="" className="w-full h-full object-cover" />
                      : <span className="absolute inset-0 bg-[#F3F1EC]" />}
                    <span className="absolute left-0.5 top-0.5 rounded bg-black/55 text-white
                                     text-[9px] font-bold px-1">{i + 1}</span>
                    {hiddenOne && (
                      <span className="absolute right-0.5 top-0.5 rounded bg-amber-700 text-white
                                       text-[9px] font-bold px-1">蓋住</span>
                    )}
                    {canEdit && !lock && (
                      <span className="absolute inset-x-0 bottom-0 flex justify-between
                                       bg-black/45 text-white text-[11px] leading-none">
                        <button title="往前"
                          onClick={() => {
                            if (i === 0) return;
                            const a = [...fbPaths];
                            [a[i - 1], a[i]] = [a[i], a[i - 1]];
                            onFbSet(fbPost, a);
                          }}
                          className="px-1 py-1 disabled:opacity-30" disabled={i === 0}>◀</button>
                        <button title="拿掉這張"
                          onClick={() => onFbSet(fbPost, fbPaths.filter((_, k) => k !== i))}
                          className="px-1 py-1">✕</button>
                        <button title="往後"
                          onClick={() => {
                            if (i === fbPaths.length - 1) return;
                            const a = [...fbPaths];
                            [a[i], a[i + 1]] = [a[i + 1], a[i]];
                            onFbSet(fbPost, a);
                          }}
                          className="px-1 py-1 disabled:opacity-30"
                          disabled={i === fbPaths.length - 1}>▶</button>
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {canEdit && !lock && (
            <div className="mt-2">
              <input ref={fbFile} type="file" accept="image/*" hidden multiple
                onChange={(e) => {
                  if (e.target.files?.length) onFbAdd(e.target.files, fbPost);
                  e.target.value = '';
                }} />
              <button onClick={() => fbFile.current?.click()}
                className="h-7 rounded-lg border border-mor-line bg-white px-2.5 text-[11px]">
                ＋ 加照片（可以一次選好幾張）
              </button>
            </div>
          )}
          <p className="text-[11px] text-gray-500 mt-2 leading-relaxed">
            拼貼的形狀是 FB 自己排的 —— 1 張整張、2 張左右各半、3 張一大兩小、
            4 張 2×2、<b>5 張以上只露前 5 張</b>。順序就是拼貼的順序，用 ◀ ▶ 換。
          </p>
        </div>
      ) : (
      <div className="mt-3">
        <div className="text-[11px] text-gray-500 mb-1">
          {row.kind === 'split' ? `原圖　建議 ${w} × ${h}` : `照片　建議 ${CELL_W} × ${CELL_H}`}
        </div>
        {row.kind === 'split' ? (
        <div className="flex gap-3 items-start">
          <div className="shrink-0 rounded-lg overflow-hidden border border-mor-line bg-white relative w-[180px]"
            style={{ aspectRatio: `${w} / ${h}` }}>
            {url
              ? <img src={url} alt="" className="w-full h-full object-cover" />
              : <span className="absolute inset-0 flex items-center justify-center text-gray-300">無</span>}
          </div>
          <div className="text-[11px] text-gray-500 leading-relaxed">
            切成 {row.span} 張，每張 {CELL_W}×{CELL_H}。
            <b className="text-mor-ink block mt-1">格子之間那兩條白線是真的</b>
            IG 不會幫你留 —— 重要的字與人臉不要壓在接縫上。
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
        ) : (
        /*
          ══════════════════════════════════════════════════════
          IG 輪播：一排縮圖（2026-09-18 使用者選了「A 一排 76px 縮圖」）
          ══════════════════════════════════════════════════════
          ★ 跟 FB 拼貼那一區同一種做法 —— 兩邊學一次就好。
          ★★ 差別是這裡的格子是 4:5（IG 九宮格的比例），FB 是正方形。
        */
        <div>
          {igPaths.length > 0 && (
            <div className="flex gap-2 flex-wrap items-start">
              {igPaths.map((ph, i) => (
                <div key={`${ph}/${i}`} className="w-[76px]">
                  <div className="relative w-full aspect-[4/5] rounded-lg overflow-hidden
                                  border border-mor-line bg-[#F3F1EC]">
                    {urls[ph]
                      ? <img src={urls[ph]} alt="" className="w-full h-full object-cover" />
                      : <span className="absolute inset-0 bg-[#F3F1EC]" />}
                    {/* 1:1 安全區 —— 每一張都要，不是只有封面 */}
                    <span className="absolute left-0 right-0 top-1/2 -translate-y-1/2 aspect-square
                                     border border-dashed border-white/80 pointer-events-none" />
                    <span className="absolute left-0.5 top-0.5 rounded bg-black/55 text-white
                                     text-[9px] font-bold px-1">{i + 1}</span>
                    {/* ★★ 封面 ＝ 第一張 ＝ 九宮格上顯示的那一張。標出來，不然沒有人知道 */}
                    {i === 0 && (
                      <span className="absolute inset-x-0 bottom-0 bg-mor-slate/90 text-white
                                       text-[9px] font-bold text-center leading-[14px]">封面</span>
                    )}
                  </div>
                  {canEdit && !lock && igPost && (
                    <div className="flex gap-[3px] justify-center mt-1">
                      <button title="往前" disabled={i === 0}
                        onClick={() => onIgSet(igPost, movePhoto(igPaths, i, -1))}
                        className="h-[22px] px-1.5 rounded border border-mor-line bg-white
                                   text-[11px] leading-none disabled:opacity-30">◀</button>
                      <button title="往後" disabled={i === igPaths.length - 1}
                        onClick={() => onIgSet(igPost, movePhoto(igPaths, i, 1))}
                        className="h-[22px] px-1.5 rounded border border-mor-line bg-white
                                   text-[11px] leading-none disabled:opacity-30">▶</button>
                      <button title={i === 0 ? '拿掉封面 —— 第二張會遞補' : '拿掉這張'}
                        onClick={() => onIgSet(igPost, removePhoto(igPaths, i))}
                        className="h-[22px] px-1.5 rounded border border-red-200 bg-white
                                   text-[11px] leading-none text-red-600">✕</button>
                    </div>
                  )}
                </div>
              ))}
              {canEdit && !lock && igPost && (
                <>
                  <input ref={file} type="file" accept="image/*" hidden multiple
                    onChange={(e) => { onIgAdd(e.target.files, igPost); e.target.value = ''; }} />
                  {/* ★ 滿了就整顆不畫 —— 而底下那行字會說為什麼（anxing-ui 二-6） */}
                  {!addBlocked && (
                    <button onClick={() => file.current?.click()}
                      className="w-[76px] aspect-[4/5] rounded-lg border border-dashed border-mor-line
                                 bg-[#FAFAF9] text-[11px] text-gray-400 hover:border-mor-slate
                                 hover:text-mor-slate">＋ 加照片</button>
                  )}
                </>
              )}
            </div>
          )}

          {igPaths.length === 0 && canEdit && !lock && igPost && (
            <div>
              <input ref={file} type="file" accept="image/*" hidden multiple
                onChange={(e) => { onIgAdd(e.target.files, igPost); e.target.value = ''; }} />
              <button onClick={() => file.current?.click()}
                className="h-7 rounded-lg border border-mor-line bg-white px-2.5 text-[11px]">
                選照片（可以一次選好幾張）
              </button>
            </div>
          )}

          <p className="text-[11px] text-gray-500 mt-2 leading-relaxed">
            外框是九宮格的 <b>4:5</b>，中間虛線是 <b>1:1 安全區</b>。
            重點內容留在虛線裡 —— 這張圖在動態牆、搜尋頁還是可能被切成方的。
            <br />
            <b className="text-mor-ink">第一張是封面</b> —— 九宮格上顯示的就是它。◀ ▶ 換順序，✕ 拿掉。
            {addBlocked && <b className="block text-amber-700 mt-1">{addBlocked}</b>}
          </p>
        </div>
        )}
      </div>
      )}

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
/**
 * 讀的那一面 —— 長得像一則真的 IG 貼文。
 *
 * ★★★ 這裡**一個輸入框都沒有**。鎖起來的輸入框看得出是輸入框，
 *   人會一直去點，然後問「為什麼我不能打字」。
 *
 * ★★ 它回答的是編輯框回答不了的問題:**貼出去長什麼樣**。
 *   編輯框裡永遠是原始碼 —— 換行、hashtag、125 字的收合線都要自己腦補。
 *
 * ★ hashtag 上色、超過收合線折成「⋯更多」（點得開）——
 *   這兩件事就是 IG 真的會做的，少一件這一面就不值得存在。
 */
function ReadPost({ row, seq, handle }: { row: Row; seq: number; handle: string }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  /* 換一則就把展開收回去 —— 上一則展開了不該影響下一則 */
  useEffect(() => { setOpen({}); }, [row.id]);

  return (
    <div>
      <div className="flex gap-4 text-lg text-gray-600 mb-3">
        <span>♡</span><span>💬</span><span>✈</span>
        <span className="ml-auto">🔖</span>
      </div>

      {row.posts.map((p, i) => {
        const cut = captionCut(p.caption);
        const show = open[p.id] || cut.over === 0;
        /* 切圖有好幾則,每一則標上它自己的序號 */
        const n = row.kind === 'split' ? seq - row.span + 1 + i : seq;
        return (
          <div key={p.id} className={i > 0 ? 'mt-5 pt-4 border-t border-mor-line' : ''}>
            {row.kind === 'split' && (
              <div className="text-[11px] text-gray-400 mb-1">第 {n} 則</div>
            )}
            <div className="text-sm leading-[1.85] whitespace-pre-wrap break-words">
              <b className="mr-1.5">{handle}</b>
              {p.caption
                ? <Tagged text={show ? p.caption : cut.visible} />
                : <span className="text-gray-300">（還沒有文案）</span>}
              {!show && (
                <button onClick={() => setOpen((o) => ({ ...o, [p.id]: true }))}
                  className="text-gray-400 hover:text-gray-600">⋯更多</button>
              )}
            </div>
            <div className="mt-3 pt-2.5 border-t border-mor-line flex flex-wrap gap-x-4 gap-y-1
                            text-[11px] text-gray-500">
              <span className={`rounded-full px-2 py-0.5 text-white ${ST[p.status].cls}`}>
                {ST[p.status].t}
              </span>
              <span>預計發佈 {p.planned_on || '—'}</span>
              <span>
                {cut.len} 字
                {cut.over > 0 && `・收合線後還有 ${cut.over} 字`}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * hashtag 上色。
 *
 * ★ 用切片不用 `dangerouslySetInnerHTML` —— 文案是使用者打的，
 *   直接塞進 HTML 的話一個 `<` 就會把版面吃掉。
 */
function Tagged({ text }: { text: string }) {
  const parts = text.split(/(#[^\s#]+)/g);
  return (
    <>
      {parts.map((t, i) =>
        t.startsWith('#')
          ? <span key={i} className="text-mor-slate">{t}</span>
          : <span key={i}>{t}</span>)}
    </>
  );
}

/* ══════════════════════════════════════════════════════════ */

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

/**
 * 新增／編輯模擬頁 —— **同一個視窗**。
 *
 * ★ 兩個分開寫的話，「簡介」那一欄的提示遲早會有一邊沒跟上，
 *   然後同一個欄位在兩個地方說不一樣的話。
 *
 * ★★ 追蹤者用文字框不是數字框:這一頁沒有連 IG，那兩個數字是裝飾。
 *   數字框會擋掉「12.3萬」，而那正是使用者可能想打的。
 */
function AccountForm({ draft, url, coverUrl, onChange, onClose, onSave,
  onPickAvatar, onPickCover, onDeactivate }: {
  draft: AccDraft;
  /** 頭像的簽名網址（剛上傳完還沒換到的話會是 null，那就先顯示首字） */
  url: string | null;
  /** 封面照的簽名網址。FB 才有 */
  coverUrl: string | null;
  onChange: (d: AccDraft) => void;
  onClose: () => void;
  onSave: (d: AccDraft) => Promise<void> | void;
  onPickAvatar: (f: File) => void;
  onPickCover: (f: File) => void;
  onDeactivate: () => void;
}) {
  const [save, saving] = useOnce(async () => { await onSave(draft); });
  const file = useRef<HTMLInputElement>(null);
  const coverFile = useRef<HTMLInputElement>(null);
  const bad = !draft.name.trim() || !draft.handle.trim();
  const editing = !!draft.id;
  const isFb = draft.platform === 'fb';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-sm max-h-[85vh] overflow-y-auto">
        <div className="sticky top-0 bg-white px-5 py-3.5 border-b border-mor-line font-bold
                        flex items-center justify-between">
          {editing ? '編輯模擬頁' : `新增 ${PLATFORM_LABEL[draft.platform]} 模擬頁`}
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">✕</button>
        </div>

        <div className="px-5 py-4 grid gap-3 text-sm">
          {/*
            ── 平台 ──
            ★★★ 新增時選得動，**編輯時不給改**。
              改了的話底下的貼文會去讀另一支空的照片欄位
              （IG 讀 image_path、FB 讀 images）—— 照片沒有不見，
              但畫面上全部變成空格，而且不會有任何錯誤。
            ★ 建好之後這一欄還是**顯示出來**，不是消失 ——
              不然使用者要靠猜的才知道這個模擬頁是哪個平台。
          */}
          {editing ? (
            <div className="text-xs text-gray-500">
              平台　<b className="text-mor-ink">{PLATFORM_LABEL[draft.platform]}</b>
              <span className="text-gray-400 ml-2">建好之後不能改</span>
            </div>
          ) : (
            <div className="flex flex-col gap-1">
              <span className="text-xs text-gray-500">平台（建好之後不能改）</span>
              <div className="flex gap-2">
                {PLATFORMS.map((p) => (
                  <button key={p} onClick={() => onChange({ ...draft, platform: p })}
                    className={`flex-1 rounded-lg border px-3 py-1.5 text-uisub ${
                      p === draft.platform
                        ? 'bg-mor-slate border-mor-slate text-white font-semibold'
                        : 'bg-white border-gray-300 text-gray-600 hover:bg-mor-sand/60'}`}>
                    {PLATFORM_LABEL[p]}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/*
            ── 封面照（FB）──
            ★ 它佔掉 FB 第一屏一半 —— 沒有的話「看整體感覺」從第一眼就是錯的。
              IG 沒有這個東西，所以整塊不出現（不是灰掉）。
          */}
          {isFb && (
            <div className="flex flex-col gap-1.5">
              <span className="text-xs text-gray-500">封面照</span>
              <div className="h-[72px] rounded-lg overflow-hidden border border-mor-line
                              bg-gradient-to-br from-[#9fc7dd] via-[#d5cdbb] to-[#b98a63]
                              flex items-center justify-center">
                {coverUrl
                  ? <img src={coverUrl} alt="" className="w-full h-full object-cover" />
                  : <span className="text-[11px] text-white/90 drop-shadow">還沒有封面照</span>}
              </div>
              <div className="flex gap-2">
                <input ref={coverFile} type="file" accept="image/*" hidden
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) onPickCover(f); e.target.value = ''; }} />
                <button onClick={() => coverFile.current?.click()}
                  className="h-7 rounded-lg border border-mor-line bg-white px-2.5 text-[11px]">
                  {draft.cover_path ? '換一張' : '選一張'}
                </button>
                {draft.cover_path && (
                  <button onClick={() => onChange({ ...draft, cover_path: null })}
                    className="h-7 px-1 text-[11px] text-gray-400 underline">拿掉</button>
                )}
              </div>
            </div>
          )}

          {/* 頭像 */}
          <div className="flex items-center gap-3">
            <span className="w-14 h-14 rounded-full shrink-0 flex items-center justify-center"
              style={{ background: 'conic-gradient(from 210deg,#C9A227,#3FAE7C,#41689B,#C9A227)' }}>
              {url ? (
                <img src={url} alt="" className="w-[50px] h-[50px] rounded-full object-cover bg-white" />
              ) : (
                <span className="w-[50px] h-[50px] rounded-full bg-white flex items-center
                                 justify-center text-base font-extrabold text-mor-slate">
                  {(draft.name || draft.handle || '？').slice(0, 1)}
                </span>
              )}
            </span>
            <div className="text-[11px] text-gray-500 leading-relaxed">
              頭像
              <div className="mt-1 flex gap-2">
                <input ref={file} type="file" accept="image/*" hidden
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) onPickAvatar(f); e.target.value = ''; }} />
                <button onClick={() => file.current?.click()}
                  className="h-7 rounded-lg border border-mor-line bg-white px-2.5 text-[11px]">
                  {draft.avatar_path ? '換一張' : '選一張'}
                </button>
                {draft.avatar_path && (
                  <button onClick={() => onChange({ ...draft, avatar_path: null })}
                    className="h-7 px-1 text-[11px] text-gray-400 underline">用名字的第一個字</button>
                )}
              </div>
            </div>
          </div>

          <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">名稱</span>
            <input value={draft.name} onChange={(e) => onChange({ ...draft, name: e.target.value })}
              placeholder="ESTIA 台北服務式住宅"
              className="rounded-lg border border-gray-300 px-2 py-1.5" /></label>

          <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">帳號（handle）</span>
            <input value={draft.handle} onChange={(e) => onChange({ ...draft, handle: e.target.value })}
              placeholder="estia.tw"
              className="rounded-lg border border-gray-300 px-2 py-1.5" /></label>

          <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">簡介</span>
            <textarea value={draft.bio} onChange={(e) => onChange({ ...draft, bio: e.target.value })}
              placeholder="中山・南京 ｜ 月租・短租 ｜ 私訊看房"
              className="rounded-lg border border-gray-300 px-2 py-1.5 min-h-[58px] resize-y" /></label>

          {/* ★ 類別：FB 檔案頭上「🏷 Travel Company」那一行。純顯示，兩個平台都有 */}
          <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">類別</span>
            <input value={draft.category}
              onChange={(e) => onChange({ ...draft, category: e.target.value })}
              placeholder={isFb ? 'Serviced Apartments' : '住宿服務'}
              className="rounded-lg border border-gray-300 px-2 py-1.5" /></label>

          <div className="flex gap-2.5">
            <label className="flex-1 flex flex-col gap-1"><span className="text-xs text-gray-500">追蹤者</span>
              <input value={draft.followers} onChange={(e) => onChange({ ...draft, followers: e.target.value })}
                placeholder="1,204" className="rounded-lg border border-gray-300 px-2 py-1.5" /></label>
            <label className="flex-1 flex flex-col gap-1"><span className="text-xs text-gray-500">追蹤中</span>
              <input value={draft.following} onChange={(e) => onChange({ ...draft, following: e.target.value })}
                placeholder="312" className="rounded-lg border border-gray-300 px-2 py-1.5" /></label>
          </div>

          <div className="text-[11px] text-gray-400 leading-relaxed">
            這裡不會連到真的 {PLATFORM_LABEL[draft.platform]} ——
            這兩個數字是<b>你自己打的</b>，只是讓這面牆看起來像真的。留空就顯示破折號。
          </div>

          {/* 停用是底下一行紅色小字，不是按鈕（anxing-ui 四-3） */}
          {editing && (
            <div className="text-center pt-1">
              <button onClick={onDeactivate}
                className="text-xs text-red-400 underline hover:text-red-600">
                停用這個模擬頁（貼文與照片都留著）
              </button>
            </div>
          )}
        </div>

        <div className="sticky bottom-0 bg-white px-5 py-3 border-t border-mor-line flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg border border-gray-300 px-4 py-1.5 text-sm">取消</button>
          <button onClick={save} disabled={saving || bad}
            title={bad ? '名稱與帳號都要填' : ''}
            className="rounded-lg bg-mor-slate text-white px-4 py-1.5 text-sm font-medium
                       hover:bg-mor-slatedark disabled:opacity-50">
            {saving ? '儲存中⋯' : editing ? '儲存' : '建立'}</button>
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
