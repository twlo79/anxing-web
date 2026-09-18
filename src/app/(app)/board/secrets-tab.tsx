'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase';
import { useOnce } from '@/lib/once';
import {
  canSeeSecrets, SECRET_DENIED,
  SECRET_CATS, splitSecretTitle, joinSecretTitle,
  secretIcon, sortSecrets, matchSecret, secretHasWarn, secretHref,
} from '@/lib/board';

/*
 * ══════════════════════════════════════════════════════════
 * 佈告欄 → 帳密（2026-09-17 使用者:「帳密 自己成一格 > 目的是存 帳密」）
 *
 * ★★★ 這一格存的是**真的密碼**。整個系統只有這裡是這樣。
 *
 * ══════════════════════════════════════════════════════════
 * 【四個不做就會出事的細節】
 *
 *   ① 誰看得到**問資料庫**（`can_see_board_secrets()`），不在這裡再判一次
 *   ② 密碼**預設遮起來**，要按才看得到 —— 而按下去會被記一筆
 *   ③ 看不到的人給的是**一句話**，不是一片空白
 *   ④ 存檔要接 `.select('id')` —— RLS 擋下來回的是「成功、0 列」
 *
 * ══════════════════════════════════════════════════════════
 * 【★★★ 2026-09-17 改成兩層（使用者:「參考這個來做 密碼管理」，
 *   附了 Google 密碼管理的截圖；同一則訊息裡還有「字要大一點」）】
 *
 * 原本 31 筆全部攤開在同一頁，每一張卡都印著帳號與密碼欄。
 * 為了塞得下，字被壓到 11～13px。
 *
 *   ★ 「字太小」不是文案問題，是**結構**問題:
 *     清單那一層根本不需要印密碼。拿掉之後一行就夠，
 *     字放大到 17px，而且一個畫面看得到十幾筆。
 *
 *   清單　一行一個（圖示・名稱・帳號・類別籤・⚠）→ 不含密碼
 *   詳細　點進去才有帳號、密碼、網址、備註
 *
 * ★★ 順帶一個安全上的好處:翻閱稽核（`board_secret_reads`）從
 *   「一進帳密頁就整排渲染」變成「點進某一筆才算翻閱」——
 *   後者才是「他真的看了這一筆」。
 *
 * ★★★ ⚠ 要在**清單那一層**就看得到。點進去才發現有兩種說法的話，
 *   人已經準備要登入了 —— 而連錯三次是鎖帳號。
 *
 * ══════════════════════════════════════════════════════════
 * 【排序與比對的規則都在 lib/board.ts】
 *
 * `sortSecrets` / `matchSecret` / `splitSecretTitle` / `secretHref`
 * 都有測試。寫在這裡的話測不到（測試環境不處理 JSX）——
 * 而它們決定的是「找不找得到」，找不到跟不存在在畫面上長得一樣。
 * ══════════════════════════════════════════════════════════
 */

type Secret = {
  id: string;
  title: string;
  account: string | null;
  secret: string | null;
  url: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
  updated_by: string | null;
};

type Draft = {
  id?: string;
  cat: string;
  name: string;
  account: string;
  secret: string;
  url: string;
  note: string;
};

const BLANK: Draft = { cat: '訂房', name: '', account: '', secret: '', url: '', note: '' };

export default function SecretsTab({ role, meId, onMsg }: {
  role: string;
  meId: string;
  onMsg: (t: string, err?: boolean) => void;
}) {
  const supabase = useMemo(() => createClient(), []);

  /*
   * ★★★ 答案**跟資料庫問**（`can_see_board_secrets()`），這裡的 `canSeeSecrets()`
   *   只是先畫個大概，免得畫面閃一下。
   *
   * ★ 問不到答案時 fall back 成 **false**（看不到）。
   *   多按不到一格是小事；讓不該看的人以為自己看得到是大事。
   */
  const [allowed, setAllowed] = useState<boolean | null>(null);
  useEffect(() => {
    (async () => {
      if (!canSeeSecrets(role)) { setAllowed(false); return; }
      const { data, error } = await supabase.rpc('can_see_board_secrets');
      setAllowed(!error && data === true);
    })();
  }, [supabase, role]);

  const [list, setList] = useState<Secret[]>([]);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [q, setQ] = useState('');
  /** 打開的是哪一筆。null ＝ 停在清單那一層。 */
  const [openId, setOpenId] = useState<string | null>(null);
  /** 這一筆的密碼翻開了沒。★ 換一筆就忘記 —— 不進 localStorage */
  const [shown, setShown] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const [{ data, error }, { data: pf }] = await Promise.all([
      /*
       * ★ 排序交給 `sortSecrets`（lib，有測試），不在這裡 `.order()` ——
       *   「照類別」那個順序是我們自己定的，SQL 排不出來。
       */
      supabase.from('board_secrets').select('*'),
      supabase.from('profiles').select('id, name'),
    ]);
    if (error) onMsg('讀不到帳密：' + error.message, true);
    setList((data ?? []) as Secret[]);
    setNames(new Map((pf ?? []).map((p) => [p.id as string, p.name as string])));
    setLoading(false);
  }, [supabase, onMsg]);

  useEffect(() => { if (allowed) load(); else setLoading(false); }, [allowed, load]);

  /**
   * 翻開密碼。
   *
   * ★★ 記一列 `board_secret_reads`。**記不起來也照樣讓他看** ——
   *   稽核失敗不該擋住人做事，但要在主控台留一行，
   *   不然那張表安靜地空掉而沒有人知道。
   */
  const reveal = async (s: Secret) => {
    setShown(true);
    const { error } = await supabase.from('board_secret_reads')
      .insert({ secret_id: s.id, user_id: meId });
    if (error) console.warn('[board] 稽核沒記到：', error.message);
  };

  const save = async (d: Draft) => {
    const body = {
      title: joinSecretTitle(d.cat, d.name),
      account: d.account.trim() || null,
      secret: d.secret.trim() || null,
      url: d.url.trim() || null,
      note: d.note.trim() || null,
    };
    /*
     * ★★★ `.select('id')` 不能省。RLS 擋下來的寫入**回成功且影響 0 列**，
     *   不是錯誤（README 坑 C）。只接 error 的話，
     *   畫面說存好了、重新整理什麼都沒有。
     */
    const { data, error } = d.id
      ? await supabase.from('board_secrets')
          .update({ ...body, updated_by: meId, updated_at: new Date().toISOString() })
          .eq('id', d.id).select('id')
      : await supabase.from('board_secrets')
          .insert({ ...body, created_by: meId, updated_by: meId }).select('id');
    if (error) return onMsg((d.id ? '存不起來：' : '建不起來：') + error.message, true);
    if (!data?.length) {
      return onMsg('沒有存進去 —— 你的帳號沒有這個權限。\n如果你認為應該有，請總經理確認角色設定。', true);
    }
    setDraft(null);
    load();
  };

  const del = async (s: Secret) => {
    if (!confirm(`刪掉「${s.title}」？\n\n帳號與密碼會一起不見，而且救不回來。`)) return;
    const { data, error } = await supabase.from('board_secrets')
      .delete().eq('id', s.id).select('id');
    if (error) return onMsg('刪不掉：' + error.message, true);
    if (!data?.length) return onMsg('沒有刪掉 —— 你的帳號沒有這個權限。', true);
    setOpenId(null);
    load();
  };

  /* ── 還在問權限 ── */
  if (allowed === null) {
    return <div className="text-uisub text-gray-400 py-10 text-center">載入中…</div>;
  }

  /*
   * ── 看不到的人 ──
   * ★★ 給的是**一句話**，不是一片空白。空白會被當成「還沒有人建資料」，
   *   然後他會去問「為什麼帳密都不見了」（anxing-ui 二-6）。
   */
  if (!allowed) {
    return (
      <div className="rounded-xl border border-mor-line bg-white px-5 py-10 text-center">
        <div className="text-3xl mb-2">🔒</div>
        <p className="text-ui text-gray-600 leading-relaxed max-w-sm mx-auto">{SECRET_DENIED}</p>
      </div>
    );
  }

  const open = list.find((s) => s.id === openId) ?? null;

  /* ══════════════ 詳細 ══════════════ */
  if (open) {
    return (
      <>
        <Detail
          s={open} shown={shown}
          who={names.get(open.updated_by ?? '') ?? '—'}
          onBack={() => { setOpenId(null); setShown(false); }}
          onReveal={() => reveal(open)}
          onHide={() => setShown(false)}
          onEdit={() => {
            const { cat, name } = splitSecretTitle(open.title);
            setDraft({
              id: open.id, cat, name,
              account: open.account ?? '', secret: open.secret ?? '',
              url: open.url ?? '', note: open.note ?? '',
            });
          }}
          onDel={() => del(open)}
          onMsg={onMsg}
        />
        {draft && (
          <SecretForm draft={draft} onChange={setDraft}
            onClose={() => setDraft(null)} onSave={save} />
        )}
      </>
    );
  }

  /* ══════════════ 清單 ══════════════ */
  const rows = sortSecrets(list).filter((s) => matchSecret(s, q));

  return (
    <div>
      {/*
        ★★ 這一句一直在。看得到的人要知道自己看到的是什麼等級的東西 ——
          「這裡是真的密碼」跟「這裡是備忘錄」的行為不一樣。
      */}
      <div className="mb-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5
                      text-uisub text-amber-900 leading-relaxed">
        🔑 <b>這一格存的是真的帳號密碼</b> —— 房務看不到，其餘的人都看得到。
        翻開密碼會被記一筆（誰、什麼時候、哪一筆），總經理查得到。
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-3">
        <button onClick={() => setDraft({ ...BLANK })}
          className="h-11 md:h-10 rounded-lg bg-mor-slate text-white px-4 text-ui font-medium
                     hover:bg-mor-slatedark">＋ 新增</button>
        <input value={q} onChange={(e) => setQ(e.target.value)}
          placeholder="關鍵字找密碼..."
          className="h-11 md:h-10 rounded-lg border border-mor-line px-3 text-ui flex-1 min-w-[170px]" />
        <span className="text-uisub text-gray-500 whitespace-nowrap">
          共 <b className="text-mor-ink">{rows.length}</b> 筆
        </span>
      </div>

      {loading && <div className="text-uisub text-gray-400 py-10 text-center">載入中…</div>}

      {!loading && !rows.length && (
        <div className="rounded-xl border border-mor-line bg-white py-14 text-center text-ui text-gray-400">
          {list.length ? `找不到「${q}」` : '還沒有任何一筆 —— 按上面的「＋ 新增」。'}
        </div>
      )}

      {!loading && rows.length > 0 && (
        <div className="rounded-xl border border-mor-line bg-white overflow-hidden">
          {rows.map((s) => {
            const { cat, name } = splitSecretTitle(s.title);
            return (
              <button key={s.id} onClick={() => { setOpenId(s.id); setShown(false); }}
                className="w-full flex items-center gap-3 px-4 py-3 text-left
                           border-t border-mor-line/60 first:border-t-0 hover:bg-mor-sand/50">
                <span className="w-8 h-8 shrink-0 rounded-lg bg-mor-sand
                                 flex items-center justify-center text-[15px]">
                  {secretIcon(cat)}
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block text-ui font-medium truncate">{name || s.title}</span>
                  {/*
                    ★ 副標放**帳號**不放密碼。沒有帳號的（統編、電話那種）
                      退而顯示備註的第一行 —— 空著的話那一列看起來像壞掉。
                  */}
                  <span className="block text-uisub text-gray-400 truncate">
                    {s.account || (s.note ?? '').split('\n')[0] || ''}
                  </span>
                </span>
                {/* ★★★ ⚠ 要在這一層看得到 —— 點進去才發現就太晚了 */}
                {secretHasWarn(s) && <span className="shrink-0 text-amber-600 text-[15px]">⚠</span>}
                {cat && (
                  <span className="shrink-0 rounded px-2 py-0.5 text-xs
                                   bg-mor-bluelight text-mor-slatedark">{cat}</span>
                )}
                <span className="shrink-0 text-gray-300 text-ui">›</span>
              </button>
            );
          })}
        </div>
      )}

      {draft && (
        <SecretForm draft={draft} onChange={setDraft}
          onClose={() => setDraft(null)} onSave={save} />
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════ */

/**
 * 一筆的詳細。
 *
 * ★ 桌機左右兩欄（帳號密碼｜網址備註），手機疊成一欄
 *   （2026-09-17 使用者選的）。
 */
function Detail({ s, shown, who, onBack, onReveal, onHide, onEdit, onDel, onMsg }: {
  s: Secret; shown: boolean; who: string;
  onBack: () => void; onReveal: () => void; onHide: () => void;
  onEdit: () => void; onDel: () => void;
  onMsg: (t: string, err?: boolean) => void;
}) {
  const { cat, name } = splitSecretTitle(s.title);
  const href = secretHref(s.url);

  return (
    <div>
      <button onClick={onBack}
        className="flex items-center gap-2.5 mb-3 text-left hover:opacity-70">
        <span className="text-xl text-gray-500">←</span>
        <span className="w-8 h-8 shrink-0 rounded-lg bg-mor-sand
                         flex items-center justify-center text-[15px]">{secretIcon(cat)}</span>
        <span className="text-xl font-bold">{name || s.title}</span>
        {cat && (
          <span className="rounded px-2 py-0.5 text-xs bg-mor-bluelight text-mor-slatedark">{cat}</span>
        )}
      </button>

      <div className="rounded-xl border border-mor-line bg-white p-4 md:p-5">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-3">
            <Field label="帳號">
              {s.account
                ? <><Val mono>{s.account}</Val><CopyBtn text={s.account} onMsg={onMsg} /></>
                : <Ph>沒有帳號</Ph>}
            </Field>

            {/*
              ★★★ 預設遮起來。防的不是這一頁的人（他本來就看得到），
                是肩膀後面那個 —— 開著這頁去會議室、投影幕接上去。
              ★ 沒有密碼的那幾筆（統編、電話、標語）整個欄位不出現，
                不是畫一個空框（anxing-ui:永遠是空的欄位在教人忽略這一頁）。
            */}
            {s.secret && (
              <Field label="密碼">
                <Val mono>{shown ? s.secret : '•'.repeat(Math.min(14, s.secret.length))}</Val>
                <button onClick={() => (shown ? onHide() : onReveal())}
                  title={shown ? '蓋回去' : '看密碼（會記一筆）'}
                  className="shrink-0 text-uisub text-mor-slate hover:text-mor-slatedark">
                  {shown ? '蓋回去' : '看密碼'}
                </button>
                {shown && <CopyBtn text={s.secret} onMsg={onMsg} />}
              </Field>
            )}
          </div>

          <div className="space-y-3">
            <Field label="網址">
              {href
                ? (
                  <>
                    {/*
                      ★ `noopener noreferrer` 不能省 —— 開出去的分頁
                        拿得到 `window.opener` 就改得動這一頁的網址。
                    */}
                    <a href={href} target="_blank" rel="noopener noreferrer"
                      className="flex-1 min-w-0 truncate text-ui text-mor-slate hover:text-mor-slatedark">
                      {s.url}
                    </a>
                    <CopyBtn text={s.url ?? ''} onMsg={onMsg} />
                  </>
                )
                : <Ph>沒有網址</Ph>}
            </Field>

            <Field label="備註" block>
              {s.note
                ? <span className="text-ui whitespace-pre-wrap leading-relaxed">{s.note}</span>
                : <Ph>沒有備註</Ph>}
            </Field>
          </div>
        </div>

        <div className="mt-5 pt-4 border-t border-mor-line flex items-center gap-2">
          {/*
            ★ anxing-ui 四-2:一排裡只有一顆實心，而且是「打開這一筆的內容」。
              這裡兩顆都是外框 —— 這一頁本身就是那一筆的內容了。
          */}
          <button onClick={onEdit}
            className="h-10 rounded-full border border-mor-line px-5 text-uisub text-mor-slate
                       hover:bg-mor-sand/60">編輯</button>
          <button onClick={onDel}
            className="h-10 rounded-full border border-red-200 px-5 text-uisub text-red-600
                       hover:bg-red-50">刪掉</button>
          <span className="ml-auto text-xs text-gray-400 whitespace-nowrap">
            {who} · {s.updated_at.slice(5, 10).replace('-', '/')}
          </span>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children, block }: {
  label: string; children: React.ReactNode; block?: boolean;
}) {
  return (
    <label className="block">
      <span className="block text-uisub text-gray-500 mb-1">{label}</span>
      <span className={`flex gap-2 rounded-lg border border-mor-line bg-[#F5F4F1] px-3 py-2 ${
        block ? 'items-start min-h-[2.6rem]' : 'items-center'}`}>
        {children}
      </span>
    </label>
  );
}

const Val = ({ children, mono }: { children: React.ReactNode; mono?: boolean }) => (
  <span className={`flex-1 min-w-0 break-all text-ui ${mono ? 'font-mono' : ''}`}>{children}</span>
);

const Ph = ({ children }: { children: React.ReactNode }) => (
  <span className="flex-1 text-ui text-gray-400">{children}</span>
);

/* ══════════════════════════════════════════════════════════ */

/**
 * 複製。
 *
 * ★ `navigator.clipboard` 在非 https 或使用者沒給權限時**會丟錯**，
 *   而不是回 false —— 不接的話按下去整頁沒反應。
 */
function CopyBtn({ text, onMsg }: { text: string; onMsg: (t: string, err?: boolean) => void }) {
  return (
    <button
      onClick={async (e) => {
        e.preventDefault();
        try {
          await navigator.clipboard.writeText(text);
          onMsg('複製好了');
        } catch {
          onMsg('這個瀏覽器不讓我複製 —— 請自己選取。', true);
        }
      }}
      title="複製"
      className="shrink-0 text-uisub text-gray-400 hover:text-mor-ink">複製</button>
  );
}

/* ══════════════════════════════════════════════════════════ */

function SecretForm({ draft, onChange, onClose, onSave }: {
  draft: Draft;
  onChange: (d: Draft) => void;
  onClose: () => void;
  onSave: (d: Draft) => Promise<void> | void;
}) {
  const [save, saving] = useOnce(async () => { await onSave(draft); });
  const bad = !draft.name.trim();

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative bg-white w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl shadow-xl
                      max-h-[92vh] sm:max-h-[85vh] overflow-y-auto">
        <div className="sticky top-0 bg-white px-5 py-3.5 border-b border-mor-line font-bold text-ui
                        flex items-center justify-between">
          {draft.id ? '編輯' : '新增一筆'}
          <button onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-xl leading-none">✕</button>
        </div>

        <div className="px-5 py-4 grid gap-3">
          {/*
            ★★ 類別是下拉不是自由輸入。自由輸入的話「訂房」與「訂房 」
              會變成兩個類別，而畫面上長得一模一樣
              —— 那一筆會排到一個找不到的位置（lib 的 catRank 排在已知後面）。
          */}
          <label className="flex flex-col gap-1">
            <span className="text-uisub text-gray-500">類別</span>
            <select value={draft.cat} onChange={(e) => onChange({ ...draft, cat: e.target.value })}
              className="h-11 md:h-10 rounded-lg border border-mor-line px-2 text-ui bg-white">
              {SECRET_CATS.map((c) => <option key={c} value={c}>{c}</option>)}
              <option value="">（未分類）</option>
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-uisub text-gray-500 flex items-center">名稱<Star /></span>
            <input value={draft.name} onChange={(e) => onChange({ ...draft, name: e.target.value })}
              placeholder="台電・網路自繳"
              className="h-11 md:h-10 rounded-lg border border-mor-line px-3 text-ui" /></label>

          <label className="flex flex-col gap-1">
            <span className="text-uisub text-gray-500">帳號</span>
            <input value={draft.account} onChange={(e) => onChange({ ...draft, account: e.target.value })}
              placeholder="anxing@…　或　統編"
              className="h-11 md:h-10 rounded-lg border border-mor-line px-3 text-ui" /></label>

          {/*
            ★★ `type="text"` 不是 `type="password"`。
              這個框是**打進去**用的，遮起來的話打錯一個字看不出來，
              而存錯的密碼比沒存更糟（下次有人拿它去試、被鎖帳號）。
              遮的是**詳細頁**那一格，不是這裡。
          */}
          <label className="flex flex-col gap-1">
            <span className="text-uisub text-gray-500">密碼</span>
            <input value={draft.secret} onChange={(e) => onChange({ ...draft, secret: e.target.value })}
              autoComplete="off" spellCheck={false}
              className="h-11 md:h-10 rounded-lg border border-mor-line px-3 text-ui font-mono" /></label>

          <label className="flex flex-col gap-1">
            <span className="text-uisub text-gray-500">網址</span>
            {/*
              ★ placeholder 寫**實際的值**，不要寫「請輸入網址」
                （anxing-ui 二-10）。而且要讓人看得出「不用打 https://」。
            */}
            <input value={draft.url} onChange={(e) => onChange({ ...draft, url: e.target.value })}
              placeholder="www.airbnb.com.tw（不用打 https://）"
              autoComplete="off" spellCheck={false}
              className="h-11 md:h-10 rounded-lg border border-mor-line px-3 text-ui" /></label>

          <label className="flex flex-col gap-1">
            <span className="text-uisub text-gray-500">備註（去哪裡找、找誰、有沒有雙重驗證）</span>
            <textarea value={draft.note} onChange={(e) => onChange({ ...draft, note: e.target.value })}
              placeholder="電號 01-23-4567-89-0。簡訊驗證碼會寄到芊的手機。"
              className="rounded-lg border border-mor-line px-3 py-2 text-ui min-h-[70px] resize-y" /></label>

          <div className="text-xs text-gray-400 leading-relaxed">
            密碼在詳細頁預設是遮起來的，要按「看密碼」才會出現 —— 而按下去會記一筆。
          </div>
        </div>

        <div className="sticky bottom-0 bg-white px-5 py-3 border-t border-mor-line flex justify-end gap-2">
          <button onClick={onClose}
            className="h-11 md:h-10 rounded-lg border border-mor-line px-5 text-uisub">取消</button>
          {/* ★ 灰掉要說得出為什麼（anxing-ui 二-6） */}
          <button onClick={save} disabled={saving || bad}
            title={bad ? '「名稱」要填' : ''}
            className="h-11 md:h-10 rounded-lg bg-mor-slate text-white px-5 text-uisub font-medium
                       hover:bg-mor-slatedark disabled:opacity-50">
            {saving ? '儲存中⋯' : draft.id ? '儲存' : '建立'}</button>
        </div>
      </div>
    </div>
  );
}

/** 必填星號。★ 接在文字後面不換行（anxing-ui 二-1） */
const Star = () => <span className="text-red-500 ml-0.5">*</span>;
