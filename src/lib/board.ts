/**
 * 佈告欄的算式（2026-09-17 使用者指定）。
 *
 * ============================================================
 * 【三個分頁】
 *
 *   通知　　公告（留得住、置頂得了、看得到誰讀過）＋ 新訊息（推播的同一批）
 *   帳密　　**真的存帳號密碼**。房務以外看得到
 *   活動　　開會與團聚合成一條列表，用標籤分
 *
 * ============================================================
 * 【★★★ 帳密那一格是整個系統唯一「寫錯一行就是資安事件」的地方】
 *
 * 使用者 2026-09-17：「帳密 自己成一格 > 目的是存 帳密」「房務以外都看得到」。
 *
 *   ★ 誰看得到只有**一份定義**：`SECRET_ROLES`。
 *     資料庫的 policy 走 `can_see_board_secrets()`（migration_262），
 *     前端走這裡 —— 兩邊都是「房務以外」。
 *     各寫一次的話會有一邊沒跟上（README 坑 A），而這一次的症狀是
 *     **房務阿姨看得到全公司的密碼**，畫面上一切正常，沒有人會來報。
 *
 *   ★★ 所以這裡**不是白名單就是黑名單，只能選一種**。
 *     選白名單（列出看得到的四種）—— 之後新增一種角色，
 *     預設是**看不到**。黑名單的話新角色預設看得到，而那個方向錯得起。
 *
 * ============================================================
 * 【為什麼在 lib 不在 tsx】
 *
 * 測試環境不處理 JSX。而這一頁會錯的東西全部是算出來的：
 * 誰看得到、排序、還有幾天、檔案是哪一種。
 */

/* ── 誰看得到帳密 ─────────────────────────────────────────── */

/**
 * 看得到帳密的角色 —— **白名單**。
 *
 * ★ 房務（`cleaner`）不在裡面。使用者 2026-09-17：「房務以外都看得到」。
 * ★★ 新增角色時預設看不到 —— 要開就明寫進來。
 *   寫成「排除 cleaner」的黑名單的話，之後多一種角色會自動看得到，
 *   而那件事不會有人發現。
 */
export const SECRET_ROLES = ['housekeeper', 'accountant', 'manager', 'super_admin'] as const;
export type SecretRole = (typeof SECRET_ROLES)[number];

export function canSeeSecrets(role: unknown): boolean {
  return typeof role === 'string' && (SECRET_ROLES as readonly string[]).includes(role);
}

/** 看不到的時候畫面上要寫什麼。★ 空白會被當成「還沒建資料」 */
export const SECRET_DENIED =
  '這一格存的是公司的帳號密碼，你的權限看不到。需要的話請總經理或會計幫你查。';

/* ── 活動 ─────────────────────────────────────────────────── */

export const EVENT_KINDS = ['meeting', 'gathering'] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export const KIND_LABEL: Record<EventKind, string> = {
  meeting: '開會',
  gathering: '團聚',
};

export function isEventKind(x: unknown): x is EventKind {
  return x === 'meeting' || x === 'gathering';
}

/**
 * 認不得的一律當「開會」。
 *
 * ★ 回 null 的話那一筆在畫面上會沒有標籤，而使用者看到的是
 *   一條沒有分類的活動 —— 他不知道那是什麼，也不知道那是壞掉了。
 */
export function parseEventKind(raw: unknown): EventKind {
  return isEventKind(raw) ? raw : 'meeting';
}

export function kindLabel(raw: unknown): string {
  return KIND_LABEL[parseEventKind(raw)];
}

export type BoardEvent = {
  id: string;
  kind: string;
  starts_at: string;
  created_at?: string | null;
};

/**
 * 牆上的順序：**最新的在最上面**（使用者 2026-09-17：「一條一條 最新排在上方」）。
 *
 * 照 `starts_at` 由新到舊。同一天的看建立時間。
 *
 * ★★ 所以已經過去的自然沉到最底下 —— 不需要「封存」按鈕。
 *   要人記得去封存的東西，三個月後那一欄就滿了。
 *
 * ★ 不改動傳進來的陣列。
 */
export function eventOrder<T extends BoardEvent>(events: readonly T[]): T[] {
  return events.slice().sort((a, b) => {
    const d = ts(b.starts_at) - ts(a.starts_at);
    if (d !== 0) return d;
    return ts(b.created_at ?? '') - ts(a.created_at ?? '');
  });
}

const ts = (iso: string): number => {
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? 0 : t;
};

/**
 * 下一場是哪一筆（時間上還沒到的裡面最近的那一個）。
 *
 * ★★ 列表照「最新在上」排，所以最上面那筆是**日期最遠**的那一場，
 *   不是下一場。標題列要另外把下一場講出來，
 *   不然「下禮拜要開會」這件事被埋在中間。
 */
export function nextEvent<T extends BoardEvent>(
  events: readonly T[], now: Date = new Date(),
): T | null {
  const future = events.filter((e) => ts(e.starts_at) >= now.getTime());
  if (!future.length) return null;
  return future.reduce((a, b) => (ts(a.starts_at) <= ts(b.starts_at) ? a : b));
}

/** 過去了沒 */
export function isPast(startsAt: string, now: Date = new Date()): boolean {
  return ts(startsAt) < now.getTime();
}

/* ── 時區 ─────────────────────────────────────────────────── */

/**
 * ★★★ 全部的日期都用**台北時間**拆，不是看的人的瀏覽器時區。
 *
 * 一開始我寫的是 `new Date(iso).getHours()` —— 那讀的是**執行環境的時區**。
 * 全公司都在台灣，所以在他們的瀏覽器上看起來永遠是對的，
 * 而測試在 UTC 的機器上跑，「9/24 14:00」變成「9/24 06:00」、
 * 「7/19」變成「7/18」。
 *
 * ★★ 這就是那種「在我的機器上是好的」—— 而它真的會爆的那一天，
 *   是有人在國外用手機開這一頁，看到開會日期**差一天**，
 *   畫面上沒有任何錯誤。
 *
 * ★ 所以不靠環境。寫死台北。
 */
export const TZ = 'Asia/Taipei';

type Parts = { y: number; m: number; d: number; hh: number; mm: number; wd: number };

const FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
});

function tpe(iso: string): Parts | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const p: Record<string, string> = {};
  for (const x of FMT.formatToParts(d)) p[x.type] = x.value;
  const y = Number(p.year); const m = Number(p.month); const day = Number(p.day);
  if (!y || !m || !day) return null;
  /* ★ hour12:false 在某些引擎上半夜會回 24，不是 0 */
  const hh = Number(p.hour) % 24;
  return {
    y, m, d: day, hh, mm: Number(p.minute),
    wd: new Date(Date.UTC(y, m - 1, day)).getUTCDay(),
  };
}

/** 台北的「第幾天」——只給 daysUntil 比大小用 */
const dayNo = (p: Parts) => Date.UTC(p.y, p.m - 1, p.d) / 86400000;

/**
 * 還有幾天。
 *
 * ★★★ 比的是**台北的日期**，不是時間差。今天下午兩點的會，
 *   用時間差算會變成「還有 0 天」（不到 24 小時），
 *   而人要看的答案是「**就是今天**」。
 */
export function daysUntil(startsAt: string, now: Date = new Date()): number {
  const a = tpe(startsAt);
  const b = tpe(now.toISOString());
  if (!a || !b) return 0;
  return dayNo(a) - dayNo(b);
}

/** 「還有 7 天」／「就是今天」／「已過」 */
export function untilLabel(startsAt: string, now: Date = new Date()): string {
  const n = daysUntil(startsAt, now);
  if (n === 0) return '就是今天';
  if (n < 0) return '已過';
  return `還有 ${n} 天`;
}

const WD = ['日', '一', '二', '三', '四', '五', '六'];

/**
 * 「9/24（四）14:00」。**沒有時間就不畫時間**。
 *
 * ★ 沒填時間時補一個 00:00 的話，畫面上會寫「9/24（四）00:00」，
 *   而那看起來像半夜要開會。
 */
export function fmtEventWhen(startsAt: string, withTime = true): string {
  const p = tpe(startsAt);
  if (!p) return '—';
  const base = `${p.m}/${p.d}（${WD[p.wd]}）`;
  if (!withTime) return base;
  return `${base} ${String(p.hh).padStart(2, '0')}:${String(p.mm).padStart(2, '0')}`;
}

/* ── 檔案 ─────────────────────────────────────────────────── */

export type FileKind = 'pdf' | 'word' | 'other';

/** 上傳時收哪些。★ 兩種都收（使用者 2026-09-17） */
export const FILE_ACCEPT =
  '.pdf,.doc,.docx,application/pdf,application/msword,'
  + 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/**
 * 這是哪一種檔。
 *
 * ★★ 看的是**副檔名**不是 MIME —— 從 Windows 傳上來的 .docx
 *   有時候 MIME 是空的或 `application/octet-stream`，
 *   照 MIME 判的話那一份會變成「其他」而點不開。
 */
export function fileKind(name: string): FileKind {
  const n = (name ?? '').toLowerCase();
  if (n.endsWith('.pdf')) return 'pdf';
  if (n.endsWith('.docx') || n.endsWith('.doc')) return 'word';
  return 'other';
}

/**
 * 畫面上那個小標。
 *
 * ★★★ PDF 標「原樣」、Word 標「預覽」—— 這兩個字是**整個檔案功能的重點**。
 *   Word 是解出來的內容（標題、段落、粗體、清單、表格、圖片），
 *   解不出頁首頁尾、頁碼、文字方塊、分欄、字型、合併儲存格。
 *   不標的話會有人照著預覽去開會，而漏掉一個被吃掉的表格 ——
 *   那種錯沒有人會來報。
 */
export const KIND_BADGE: Record<FileKind, { t: string; hint: string } | null> = {
  pdf: { t: '原樣', hint: '點開就是原檔的樣子。' },
  word: {
    t: '預覽',
    hint: '點開是解出來的內容，**排版跟原檔不一樣**'
      + '（頁首頁尾、頁碼、文字方塊、分欄、字型都不會出現）。要看原樣請下載。',
  },
  other: null,
};

/** `.doc`（舊版 Word）解不開 —— 只有 `.docx` 可以 */
export function canPreview(name: string): boolean {
  const k = fileKind(name);
  if (k === 'pdf') return true;
  return (name ?? '').toLowerCase().endsWith('.docx');
}

/**
 * 點不開的時候要說什麼。
 *
 * ★ 舊版 `.doc` 是**不同的格式**，不是 `.docx` 的別名 ——
 *   解 docx 的那支函式庫打不開它。與其畫一個點了沒反應的連結，
 *   不如直接講「這是舊版 Word，請下載，或另存成 .docx 再傳一次」。
 */
export function whyNoPreview(name: string): string {
  const n = (name ?? '').toLowerCase();
  if (n.endsWith('.doc')) {
    return '舊版 Word（.doc）在瀏覽器裡打不開 —— 請下載，'
      + '或用 Word 另存成 .docx 或 PDF 再傳一次。';
  }
  return '這種檔案只能下載，沒辦法在這裡打開。';
}

/** 1536 → 1.5 MB。★ 畫面上要看得出「這份是不是很大」 */
export function fmtSize(bytes: number | null | undefined): string {
  const b = Number(bytes);
  if (!Number.isFinite(b) || b <= 0) return '';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${Math.round(b / 1024)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 一份檔案最大幾 MB。
 *
 * ★ 有上限是因為**沒有上限的那一天**會有人傳一份 200MB 的簡報，
 *   而全公司每次打開那一場會都要重載一次。
 */
export const FILE_MAX_MB = 25;

export function fileTooBig(bytes: number): { bad: boolean; why: string } {
  const mb = bytes / 1024 / 1024;
  if (mb <= FILE_MAX_MB) return { bad: false, why: '' };
  return {
    bad: true,
    why: `這份 ${fmtSize(bytes)}，超過 ${FILE_MAX_MB} MB。`
      + `太大的檔案每個人打開都要重載一次 —— 請先壓縮，或拆成兩份。`,
  };
}

/* ── 備註裡的網址 ─────────────────────────────────────────── */

/**
 * 把一段文字切成「純文字」與「網址」。
 *
 * ★★★ 使用者 2026-09-17：「團建 可能貼地址 url」——
 *   而畫面上那條 Google Maps 網址現在是**印出來的字**，點不動。
 *   同事看到只能自己選取、複製、貼到瀏覽器。
 *
 * ★★ 回的是**段落陣列**，不是一串 HTML。
 *   回 HTML 的話畫面那層就得用 `dangerouslySetInnerHTML` ——
 *   而那一欄是使用者自己打的字。要讓它變成連結，
 *   就得先證明裡面沒有別的東西，而那件事很難證明。
 *   切成段落之後，畫面用 React 元素畫出來，**天生就跳不出去**。
 */
export type TextPart = { kind: 'text' | 'url'; v: string };

/** 網址結尾常常黏著中文標點 —— 那些不是網址的一部分 */
const TAIL = /[。，、；：）」』\]）.,;:!?)]+$/;

export function linkify(text: string): TextPart[] {
  const s = text ?? '';
  if (!s) return [];
  const out: TextPart[] = [];
  /*
   * ★★★ 字元集只收 URL 合法的那幾種（RFC 3986）。
   *   最初我寫 `[^\\s]+`（不是空白就算）—— 而中文沒有空白：
   *   「地點 https://maps.app.goo.gl/abc。記得帶名片」
   *   整句話從句號到句尾全部被吃進網址裡，連結是壞的、
   *   而後面那句話也不見了。自測當場抓到。
   */
  /*
   * ★★ 也收 `www.` 開頭的 —— 人打地址時很少打 https://。
   *   不收的話「www.kigai.com.tw」會是一段死的灰字，
   *   而使用者看不出來為什麼那一條可以點、這一條不行。
   */
  const re = /(?:https?:\/\/|www\.)[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+/g;
  let at = 0;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    let url = m[0];
    /*
     * ★ 「⋯地圖 https://maps.app.goo.gl/abc。」——
     *   那個句號會被 `[^\s]+` 吃進網址裡，而那條連結就是壞的。
     */
    const cut = url.match(TAIL);
    if (cut) url = url.slice(0, url.length - cut[0].length);
    if (!url) continue;
    const start = m.index;
    if (start > at) out.push({ kind: 'text', v: s.slice(at, start) });
    out.push({ kind: 'url', v: url });
    at = start + url.length;
  }
  if (at < s.length) out.push({ kind: 'text', v: s.slice(at) });
  return out;
}

/* ── 分享到 LINE ──────────────────────────────────────────── */

/**
 * 分享用的文字。
 *
 * ```
 * 【開會】10/2（五）13:30
 * 10/2 開會
 * https://maps.app.goo.gl/…
 * ```
 *
 * ★★ 這一份**不帶安幸上工的網址**。那一頁要登入才看得到，
 *   貼進 LINE 不會有預覽圖，點開只會看到登入畫面 ——
 *   而收到的人多半是在手機上、沒登入的狀態。
 *   把該知道的事**寫在訊息本身**，比丟一條點不開的連結有用。
 */
export function eventShareText(ev: {
  kind: string; title: string; starts_at: string; all_day?: boolean; note?: string | null;
}): string {
  const lines = [
    `【${kindLabel(ev.kind)}】${fmtEventWhen(ev.starts_at, !ev.all_day)}`,
    (ev.title ?? '').trim(),
  ];
  const note = (ev.note ?? '').trim();
  if (note) lines.push(note);
  return lines.filter((l) => l !== '').join('\n');
}

/**
 * LINE 的分享網址。
 *
 * ★★ 用 `line.me/R/share?text=` —— 官方文件上那支
 *   `social-plugins.line.me/lineit/share` 的 `text` 參數
 *   在 iPhone Safari 上會被忽略（只帶得動 url）。
 *
 * ★ 換行交給 `encodeURIComponent` 轉成 `%0A`，不要自己拼。
 */
export function lineShareUrl(text: string): string {
  return `https://line.me/R/share?text=${encodeURIComponent(text ?? '')}`;
}

/* ── 上傳開關 ─────────────────────────────────────────────── */

/**
 * 這一場現在收不收檔案。
 *
 * ★★★ 兩個條件：**是開會**，而且**開關打開了**
 *   （使用者 2026-09-17：「團聚 不用上傳資料」「開會上傳資料 是有一個 toggle 打開才能上傳」）。
 *
 * ★★ 資料庫那邊的 policy 走同一條規則（migration_265）——
 *   只擋畫面的話，開關關著照樣傳得進去，而畫面上看不到那些檔案。
 *   那比不擋更糟:東西在 storage 裡佔著位子，沒有人知道它在。
 */
export function canUpload(ev: { kind: string; uploads_open?: boolean | null }): boolean {
  return parseEventKind(ev.kind) === 'meeting' && !!ev.uploads_open;
}

/** 檔案照「誰傳的」分組，人名照第一次上傳的時間排 */
export function filesByPerson<T extends { uploaded_by: string | null; created_at: string }>(
  files: readonly T[],
): { who: string | null; items: T[] }[] {
  const g = new Map<string, { who: string | null; items: T[] }>();
  for (const f of [...files].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    const k = f.uploaded_by ?? '—';
    const hit = g.get(k);
    if (hit) hit.items.push(f);
    else g.set(k, { who: f.uploaded_by, items: [f] });
  }
  return [...g.values()];
}

/**
 * 連結真正要打開的網址。
 *
 * ★ `www.kigai.com.tw` 直接丟進 href 的話，瀏覽器會當成**相對路徑** ——
 *   點下去跑到 `安幸上工網址/board/www.kigai.com.tw`，一個 404。
 *   而畫面上那條連結看起來完全正常。
 */
export function urlHref(url: string): string {
  const u = (url ?? '').trim();
  return /^https?:\/\//i.test(u) ? u : `https://${u}`;
}

/**
 * 看起來像地圖的網址。
 *
 * ★★★ 第一版我寫成 `/(^|\.)(maps\.app\.goo\.gl|…)/` —— 要求前面是開頭或一個點。
 *   而真正的網址是 `https://maps.app.goo.gl/abc`，`maps` 前面是 **`//`**。
 *   所以它**一條都沒認出來**，而畫面上只是照原樣顯示網址 ——
 *   看起來完全正常，只是那個「📍 開啟地圖」永遠不會出現。
 *   自測跑出來才看見（跑之前我以為它是對的）。
 *
 * ★ 改成**取出主機名再比**，不要在整條網址上玩前後文。
 */
const MAP_HOST = /^(maps\.app\.goo\.gl|goo\.gl|maps\.google\.[a-z.]+|www\.google\.[a-z.]+)$/i;

function hostOf(url: string): string {
  try { return new URL(urlHref(url)).hostname; } catch { return ''; }
}

function looksLikeMap(url: string): boolean {
  const h = hostOf(url);
  if (!h) return false;
  if (MAP_HOST.test(h)) return true;
  /* google.com/maps、google.com.tw/maps 這種路徑在後面的 */
  return /google\./i.test(h) && /\/maps?\b/i.test(url);
}

export function urlLabel(url: string, max = 42): string {
  const u = (url ?? '').trim();
  if (looksLikeMap(u)) return '📍 開啟地圖';
  if (u.length <= max) return u;
  return `${u.slice(0, max - 12)}…${u.slice(-9)}`;
}
