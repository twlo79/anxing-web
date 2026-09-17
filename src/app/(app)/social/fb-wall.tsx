'use client';
import { fbCollage, fbCaptionCut, fbProfileStat, fbPhotoWarn } from '@/lib/social-fb';

/*
 * ══════════════════════════════════════════════════════════
 * 社群模擬 → Facebook 的那一面牆（2026-09-17 使用者:「分成 IG 跟 FB」）
 *
 * ★★★ 這**不是把九宮格換個外框**。FB 粉專根本沒有九宮格 ——
 *   它是一則一則往下的時間軸，而每一則是一張**拼貼**。
 *
 *   IG　會錯的是「格子歪不歪」（切圖跨排）
 *   FB　會錯的是「哪幾張圖被蓋掉」（11 張只有 5 張露臉）
 *
 * ★★ 排版的算式全部在 `lib/social-fb.ts`（39 個測試）——
 *   這一支只負責畫。幾張圖排成什麼形狀、第幾張開始被蓋掉、
 *   文案在哪一行被收起來，那些是會錯而且錯了看不出來的東西。
 *
 * ══════════════════════════════════════════════════════════
 * 【為什麼要畫封面照】
 *
 * 它佔掉 FB 第一屏一半。不畫的話「排出來看整體感覺」這件事
 * 從第一眼就是錯的 —— 而這一頁存在的唯一理由就是那個感覺。
 * ══════════════════════════════════════════════════════════
 */

/** 這一支要畫的帳號。★ 只收畫得到的欄位 —— 多收的話測試要準備一堆假資料 */
export type FbAcct = {
  id: string;
  name: string;
  handle: string;
  bio: string | null;
  category: string | null;
  followers: string | null;
  following: string | null;
  avatar_path: string | null;
  cover_path: string | null;
};

export type FbPost = {
  id: string;
  caption: string;
  /** FB 拼貼的照片。順序就是拼貼的順序 */
  images: string[] | null;
  /**
   * ★ migration_261 之前建的貼文只有這一支。
   *   `images` 是空的時候退回來用它 —— 不然那些貼文會變成空白格，
   *   而照片其實還在 storage 裡（看起來像資料掉了，實際沒有）。
   */
  image_path: string | null;
  planned_on: string | null;
  status: 'draft' | 'scheduled' | 'published';
  pin: number;
};

const ST: Record<FbPost['status'], { t: string; cls: string }> = {
  draft: { t: '草稿', cls: 'bg-black/60' },
  scheduled: { t: '已排程', cls: 'bg-amber-700/90' },
  published: { t: '已發佈', cls: 'bg-mor-greendark/90' },
};

const mdOf = (d?: string | null) =>
  d ? `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}` : '';

/** 這一則實際會貼出去的照片。★ 只有一個地方決定，不然畫面與警告會各算各的 */
export function photosOf(p: FbPost): string[] {
  const xs = (p.images ?? []).filter((x) => !!x);
  if (xs.length) return xs;
  return p.image_path ? [p.image_path] : [];
}

/* ══════════════════════════════════════════════════════════ */

export default function FbWall({
  acc, posts, urls, clean, sel, canEdit, onSelect, onEditAcc,
}: {
  acc: FbAcct;
  /** 已經排好順序（置頂在前）的貼文 */
  posts: readonly FbPost[];
  urls: Record<string, string>;
  clean: boolean;
  sel: string | null;
  canEdit: boolean;
  onSelect: (id: string) => void;
  onEditAcc: () => void;
}) {
  const cover = acc.cover_path ? urls[acc.cover_path] : null;
  const avatar = acc.avatar_path ? urls[acc.avatar_path] : null;

  return (
    <div className="w-full rounded-2xl border border-mor-line bg-white overflow-hidden">

      {/* ── 封面照 ── */}
      <div className="relative h-[118px] bg-gradient-to-br from-[#9fc7dd] via-[#d5cdbb] to-[#b98a63]">
        {cover && <img src={cover} alt="" className="absolute inset-0 w-full h-full object-cover" />}
        {canEdit && (
          <button onClick={onEditAcc}
            className="absolute right-2.5 bottom-2 rounded-lg bg-white/90 px-2.5 py-1
                       text-[11px] font-semibold text-mor-slate hover:bg-white">
            編輯
          </button>
        )}
        {!cover && (
          <span className="absolute left-3 bottom-2 text-[11px] text-white/90 drop-shadow">
            還沒有封面照
          </span>
        )}
      </div>

      {/*
        ── 檔案頭 ──
        ★★ FB 是**置中**的（IG 靠左）。照 IG 的排法畫的話，
          第一眼就不像 FB，而這一頁要給的正是那第一眼。
      */}
      <div className="px-4 pb-3 text-center -mt-[42px] relative">
        <span className="w-[84px] h-[84px] rounded-full mx-auto mb-2 block bg-white
                         ring-[3px] ring-[#1877F2] border-[4px] border-white overflow-hidden">
          {avatar
            ? <img src={avatar} alt="" className="w-full h-full object-cover" />
            : <span className="w-full h-full flex items-center justify-center
                               text-xl font-extrabold text-mor-slate bg-mor-sand">
                {(acc.name || acc.handle).slice(0, 1)}
              </span>}
        </span>
        <div className="text-[19px] font-extrabold leading-tight">{acc.name || acc.handle}</div>
        {/*
          ★ FB 的順序是 followers → following → posts，**跟 IG 反過來**。
            這一行走 lib 的 `fbProfileStat()` —— 兩邊各寫一次的話會有一邊是錯的順序。
        */}
        <div className="text-xs font-bold text-[#3a3b3c] mt-1">
          {fbProfileStat(acc.followers, acc.following, posts.length)}
        </div>
        {acc.bio && (
          <div className="text-[13px] text-[#3a3b3c] mt-2 leading-snug whitespace-pre-wrap">
            {acc.bio}
          </div>
        )}
        {acc.category && (
          <div className="text-xs font-semibold text-[#3a3b3c] mt-2">🏷 {acc.category}</div>
        )}
        {/* ★ 這兩顆是**裝飾**,按不動 —— 沒有它們上面那塊看起來不像 FB */}
        <div className="flex gap-2 mt-3 select-none" aria-hidden>
          <div className="flex-1 rounded-lg bg-[#1877F2] text-white py-1.5 text-[13px] font-bold">
            ＋ Follow
          </div>
          <div className="flex-1 rounded-lg bg-[#E4E6EB] text-[#050505] py-1.5 text-[13px] font-bold">
            ✉ Message
          </div>
        </div>
      </div>

      {/* ── 分頁列。★ FB 是 All / Photos / Reels / Mentions,不是 IG 那三個 ── */}
      <div className="flex gap-1.5 px-3 pb-2.5 overflow-hidden">
        <span className="text-[13px] font-bold px-3 py-1 rounded-full bg-[#E7F0FE] text-[#1877F2]">All</span>
        <span className="text-[13px] font-bold px-3 py-1 rounded-full text-gray-400">Photos</span>
        <span className="text-[13px] font-bold px-3 py-1 rounded-full text-gray-400">Reels</span>
        <span className="text-[13px] font-bold px-3 py-1 rounded-full text-gray-400">Mentions</span>
      </div>
      <div className="px-3.5 pb-2 text-[15px] font-extrabold">All posts</div>

      {/* ── 牆 ── */}
      <div className="bg-[#F0F2F5] py-2">
        {posts.map((p) => (
          <FbCard key={p.id} post={p} acc={acc} avatar={avatar} urls={urls}
            clean={clean} selected={sel === p.id} onClick={() => onSelect(p.id)} />
        ))}
        {!posts.length && (
          <div className="py-14 text-center text-sm text-gray-400">
            還沒有貼文{canEdit ? ' —— 按上面的「＋ 貼文」' : ''}
          </div>
        )}
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════ */

function FbCard({ post, acc, avatar, urls, clean, selected, onClick }: {
  post: FbPost; acc: FbAcct; avatar: string | null;
  urls: Record<string, string>; clean: boolean; selected: boolean; onClick: () => void;
}) {
  const paths = photosOf(post);
  const cap = fbCaptionCut(post.caption ?? '');
  const st = ST[post.status];

  return (
    <button type="button" onClick={onClick}
      className={`block w-full text-left bg-white border-y border-[#E4E6EB] mb-2 ${
        selected ? 'outline outline-[2.5px] -outline-offset-2 outline-mor-slate relative z-10' : ''}`}>

      {/* ── 頭 ── */}
      <div className="flex gap-2.5 items-start px-3 pt-2.5 pb-1.5">
        <span className="w-9 h-9 rounded-full shrink-0 bg-mor-sand overflow-hidden
                         ring-2 ring-[#1877F2] ring-offset-2 ring-offset-white">
          {avatar
            ? <img src={avatar} alt="" className="w-full h-full object-cover" />
            : <span className="w-full h-full flex items-center justify-center
                               text-[11px] font-extrabold text-mor-slate">
                {(acc.name || acc.handle).slice(0, 1)}
              </span>}
        </span>
        <div className="min-w-0">
          <div className="text-[13.5px] font-bold leading-tight truncate">
            {acc.name || acc.handle}
            <span className="text-[#1877F2] text-[11px] ml-1">✔</span>
          </div>
          <div className="text-[11.5px] text-gray-500">
            {post.pin > 0 && <span className="mr-1">📌 置頂 ・</span>}
            {post.planned_on ? `預計 ${mdOf(post.planned_on)} ・ ` : ''}🌐
            {!clean && <span className={`ml-1.5 rounded px-1.5 text-[9px] font-bold text-white ${st.cls}`}>
              {st.t}
            </span>}
          </div>
        </div>
      </div>

      {/*
        ── 文案 ──
        ★★★ FB 是**照行數**收的（3 行後接 See more），IG 是照字數。
          看得到的那幾行直接畫出來，收起來的那一段畫成灰的 ——
          「重點在 more 後面」等於沒講，而那是文案唯一要通過的測驗。
      */}
      {cap.lines.length > 0 && (
        <div className="px-3 pb-2 text-[13.5px] leading-relaxed">
          {cap.lines.map((l, i) => (
            <div key={i} className="truncate">{l || ' '}</div>
          ))}
          {cap.over > 0 && (
            <span className="text-[#3a3b3c] font-bold">… more</span>
          )}
        </div>
      )}

      {/* ── 拼貼 ── */}
      <Collage paths={paths} urls={urls} />

      {/* ── 底下那排 ── */}
      <div className="flex gap-6 px-3 py-1.5 mt-1 border-t border-[#E4E6EB] text-[12.5px] text-gray-500">
        <span>👍 讚</span><span>💬 留言</span><span>↪ 分享</span>
      </div>
    </button>
  );
}

/* ══════════════════════════════════════════════════════════ */

/**
 * 拼貼。形狀全部來自 `fbCollage()` —— 這裡只把它翻成 CSS grid。
 *
 * ★★ `gap-[2px]` 那幾條白線**是真的**,FB 就長這樣。
 */
export function Collage({ paths, urls }: { paths: readonly string[]; urls: Record<string, string> }) {
  const c = fbCollage(paths.length);
  if (!c.tiles.length) {
    return (
      <div className="h-[140px] bg-[#F3F1EC] flex items-center justify-center text-gray-300 text-lg">
        ＋
      </div>
    );
  }
  return (
    <div className="grid gap-[2px] bg-white"
      style={{
        gridTemplateColumns: 'repeat(6, 1fr)',
        gridTemplateRows: c.rows.map((r) => `${r * 84}px`).join(' '),
      }}>
      {c.tiles.map((t) => {
        const u = urls[paths[t.i]];
        return (
          <span key={t.i} className="relative overflow-hidden bg-[#cdd3da]"
            style={{
              gridColumn: `${t.c + 1} / span ${t.cw}`,
              gridRow: `${t.r + 1} / span ${t.rh}`,
            }}>
            {u
              ? <img src={u} alt="" className="w-full h-full object-cover" />
              : <span className="w-full h-full flex items-center justify-center
                                 text-white/60 text-xs">圖載入中</span>}
            {/*
              ★★★ 「+N」——**這是這一頁存在的理由**。
                第 6 張以後沒有任何人看得到，而那件事只有排出來才發現得了。
            */}
            {t.more > 0 && (
              <span className="absolute inset-0 bg-black/45 text-white font-extrabold
                               text-2xl flex items-center justify-center">
                +{t.more}
              </span>
            )}
          </span>
        );
      })}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════ */

/** 圖太多的提示。★ 出現在**貼文清單上方**，跟 IG 的切圖警告同一個位置 */
export function FbPhotoWarnings({ posts, onSelect }: {
  posts: readonly FbPost[];
  onSelect: (id: string) => void;
}) {
  const bad = posts
    .map((p) => ({ p, w: fbPhotoWarn(photosOf(p).length) }))
    .filter((x) => x.w.over > 0);
  if (!bad.length) return null;
  return (
    <>
      {bad.map(({ p, w }) => (
        <div key={p.id}
          className="mb-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5
                     text-xs text-amber-900 leading-relaxed">
          ⚠ <b>有一則的照片太多了</b> —— {w.why}
          <button onClick={() => onSelect(p.id)}
            className="ml-2 rounded-md border border-amber-300 bg-white px-2 py-0.5
                       text-[11px] text-amber-800 hover:bg-amber-100">
            打開那一則
          </button>
        </div>
      ))}
    </>
  );
}
