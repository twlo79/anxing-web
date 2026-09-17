'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase';
import { useOnce } from '@/lib/once';
import { canSeeSecrets, SECRET_DENIED } from '@/lib/board';

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
 * 【★★ 為什麼預設遮起來】
 *
 * 不是防這一頁的人 —— 他本來就看得到。是防**肩膀後面那個人**:
 * 開著這一頁去會議室、投影幕接上去、旁邊有人路過。
 * 一整排明碼躺在那裡，跟一整排「••••••」的差別就在這裡。
 *
 * ★ 而且按下去會寫一列 `board_secret_reads`。
 *   哪天密碼外流，「誰打開過」這個問題才有答案 ——
 *   沒有那張表的話，那個問題永遠是「不知道」。
 * ══════════════════════════════════════════════════════════
 */

type Secret = {
  id: string;
  title: string;
  account: string | null;
  secret: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
  updated_by: string | null;
};

type Draft = {
  id?: string;
  title: string;
  account: string;
  secret: string;
  note: string;
};

const BLANK: Draft = { title: '', account: '', secret: '', note: '' };

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
   *   兩邊走的是同一份清單（migration_262 的 `board_secret_roles()`
   *   ＝ lib/board.ts 的 `SECRET_ROLES`），但**資料庫那一份說了算** ——
   *   前端這一份被繞過去也沒有用，policy 還是會擋。
   *
   * ★ 問不到答案時 fall back 成 **false**（看不到）。
   *   多按不到一格是小事；讓不該看的人以為自己看得到是大事。
   */
  const [allowed, setAllowed] = useState<boolean | null>(null);
  useEffect(() => {
    (async () => {
      /*
       * ★ 前端這一份只用來**提早說不**（房務連問都不用問）。
       *   說「可以」的權力在資料庫 —— 前端這一份被改掉也沒有用，policy 還是會擋。
       */
      if (!canSeeSecrets(role)) { setAllowed(false); return; }
      const { data, error } = await supabase.rpc('can_see_board_secrets');
      setAllowed(!error && data === true);
    })();
  }, [supabase, role]);

  const [list, setList] = useState<Secret[]>([]);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<Draft | null>(null);
  /** 哪幾筆的密碼被翻開了。★ 換頁就忘記 —— 不進 localStorage */
  const [shown, setShown] = useState<Set<string>>(new Set());
  const [q, setQ] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    const [{ data, error }, { data: pf }] = await Promise.all([
      supabase.from('board_secrets').select('*').order('updated_at', { ascending: false }),
      supabase.from('profiles').select('id, name'),
    ]);
    if (error) onMsg('讀不到帳密：' + error.message, true);
    setList((data ?? []) as Secret[]);
    setNames(new Map((pf ?? []).map((p) => [p.id as string, p.name as string])));
    setLoading(false);
  }, [supabase, onMsg]);

  useEffect(() => { if (allowed) load(); else setLoading(false); }, [allowed, load]);

  /**
   * 翻開一筆密碼。
   *
   * ★★ 記一列 `board_secret_reads`。**記不起來也照樣讓他看** ——
   *   稽核記錄失敗不該擋住人做事，但要在主控台留一行，
   *   不然那張表安靜地空掉而沒有人知道。
   */
  const reveal = async (s: Secret) => {
    setShown((v) => new Set([...v, s.id]));
    const { error } = await supabase.from('board_secret_reads')
      .insert({ secret_id: s.id, user_id: meId });
    if (error) console.warn('[board] 稽核沒記到：', error.message);
  };

  const hide = (id: string) => setShown((v) => {
    const n = new Set(v); n.delete(id); return n;
  });

  const save = async (d: Draft) => {
    const body = {
      title: d.title.trim(),
      account: d.account.trim() || null,
      secret: d.secret.trim() || null,
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
    load();
  };

  /* ── 還在問權限 ── */
  if (allowed === null) {
    return <div className="text-sm text-gray-400 py-10 text-center">載入中…</div>;
  }

  /*
   * ── 看不到的人 ──
   * ★★ 給的是**一句話**，不是一片空白。空白會被當成「還沒有人建資料」，
   *   然後他會去問「為什麼帳密都不見了」（anxing-ui 二-6）。
   */
  if (!allowed) {
    return (
      <div className="rounded-xl border border-mor-line bg-white px-5 py-8 text-center">
        <div className="text-3xl mb-2">🔒</div>
        <p className="text-sm text-gray-600 leading-relaxed max-w-sm mx-auto">{SECRET_DENIED}</p>
      </div>
    );
  }

  const kw = q.trim().toLowerCase();
  const rows = kw
    ? list.filter((s) => `${s.title} ${s.account ?? ''} ${s.note ?? ''}`.toLowerCase().includes(kw))
    : list;

  return (
    <div>
      {/*
        ★★ 這一句一直在。看得到的人要知道自己看到的是什麼等級的東西 ——
          「這裡是真的密碼」跟「這裡是備忘錄」的行為不一樣。
      */}
      <div className="mb-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5
                      text-xs text-amber-900 leading-relaxed">
        🔑 <b>這一格存的是真的帳號密碼</b> —— 房務看不到，其餘的人都看得到。
        翻開密碼會被記一筆（誰、什麼時候、哪一筆），總經理查得到。
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-3">
        <button onClick={() => setDraft({ ...BLANK })}
          className="h-9 rounded-lg bg-mor-slate text-white px-3.5 text-uisub font-medium
                     hover:bg-mor-slatedark">＋ 新增一筆</button>
        <input value={q} onChange={(e) => setQ(e.target.value)}
          placeholder="找… 台電、中華電信、管委會"
          className="h-9 rounded-lg border border-mor-line px-3 text-sm flex-1 min-w-[160px]" />
        <span className="text-xs text-gray-500 whitespace-nowrap">
          共 <b className="text-mor-ink">{list.length}</b> 筆
        </span>
      </div>

      {loading && <div className="text-sm text-gray-400 py-8 text-center">載入中…</div>}

      {!loading && !rows.length && (
        <div className="rounded-xl border border-mor-line bg-white py-12 text-center text-sm text-gray-400">
          {list.length ? '找不到符合的。' : '還沒有任何一筆 —— 按上面的「＋ 新增一筆」。'}
        </div>
      )}

      <div className="grid gap-2">
        {rows.map((s) => (
          <div key={s.id} className="rounded-xl border border-mor-line bg-white px-4 py-3">
            <div className="flex items-start gap-2">
              <div className="font-semibold text-sm flex-1 min-w-0">{s.title}</div>
              <span className="text-[11px] text-gray-400 whitespace-nowrap">
                {names.get(s.updated_by ?? '') ?? '—'} · {s.updated_at.slice(5, 10).replace('-', '/')}
              </span>
            </div>

            {s.account && (
              <div className="mt-1.5 flex items-center gap-2 text-[13px]">
                <span className="text-gray-500 w-9 shrink-0">帳號</span>
                <code className="bg-mor-sand rounded px-1.5 py-0.5 flex-1 min-w-0 break-all">
                  {s.account}
                </code>
                <CopyBtn text={s.account} onMsg={onMsg} />
              </div>
            )}

            {s.secret && (
              <div className="mt-1.5 flex items-center gap-2 text-[13px]">
                <span className="text-gray-500 w-9 shrink-0">密碼</span>
                <code className="bg-mor-sand rounded px-1.5 py-0.5 flex-1 min-w-0 break-all">
                  {shown.has(s.id) ? s.secret : '•'.repeat(Math.min(12, s.secret.length))}
                </code>
                {/*
                  ★★★ 預設遮起來。防的不是這一頁的人（他本來就看得到），
                    是肩膀後面那個 —— 開著這頁去會議室、投影幕接上去。
                */}
                <button onClick={() => (shown.has(s.id) ? hide(s.id) : reveal(s))}
                  className="text-[11px] text-mor-slate hover:text-mor-slatedark whitespace-nowrap">
                  {shown.has(s.id) ? '蓋回去' : '看密碼'}
                </button>
                {shown.has(s.id) && <CopyBtn text={s.secret} onMsg={onMsg} />}
              </div>
            )}

            {s.note && (
              <div className="mt-1.5 text-xs text-gray-600 whitespace-pre-wrap leading-relaxed">
                {s.note}
              </div>
            )}

            <div className="mt-2 flex gap-3">
              <button onClick={() => setDraft({
                id: s.id, title: s.title, account: s.account ?? '',
                secret: s.secret ?? '', note: s.note ?? '',
              })} className="text-[11px] text-mor-slate hover:text-mor-slatedark">編輯</button>
              <button onClick={() => del(s)}
                className="text-[11px] text-red-400 hover:text-red-600">刪掉</button>
            </div>
          </div>
        ))}
      </div>

      {draft && (
        <SecretForm draft={draft} onChange={setDraft}
          onClose={() => setDraft(null)} onSave={save} />
      )}
    </div>
  );
}

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
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          onMsg('複製好了');
        } catch {
          onMsg('這個瀏覽器不讓我複製 —— 請自己選取。', true);
        }
      }}
      className="text-[11px] text-gray-400 hover:text-mor-ink whitespace-nowrap">複製</button>
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
  const bad = !draft.title.trim();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-sm max-h-[85vh] overflow-y-auto">
        <div className="sticky top-0 bg-white px-5 py-3.5 border-b border-mor-line font-bold
                        flex items-center justify-between">
          {draft.id ? '編輯' : '新增一筆'}
          <button onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-xl leading-none">✕</button>
        </div>

        <div className="px-5 py-4 grid gap-3 text-sm">
          <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">這是什麼</span>
            <input value={draft.title} onChange={(e) => onChange({ ...draft, title: e.target.value })}
              placeholder="台電・網路自繳"
              className="rounded-lg border border-gray-300 px-2 py-1.5" /></label>

          <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">帳號</span>
            <input value={draft.account} onChange={(e) => onChange({ ...draft, account: e.target.value })}
              placeholder="anxing@…　或　統編"
              className="rounded-lg border border-gray-300 px-2 py-1.5" /></label>

          {/*
            ★★ `type="text"` 不是 `type="password"`。
              這個框是**打進去**用的，遮起來的話打錯一個字看不出來，
              而存錯的密碼比沒存更糟（下次有人拿它去試、被鎖帳號）。
              遮的是**列表上**那一格，不是這裡。
          */}
          <label className="flex flex-col gap-1"><span className="text-xs text-gray-500">密碼</span>
            <input value={draft.secret} onChange={(e) => onChange({ ...draft, secret: e.target.value })}
              autoComplete="off" spellCheck={false}
              className="rounded-lg border border-gray-300 px-2 py-1.5 font-mono" /></label>

          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-500">備註（去哪裡找、找誰、有沒有雙重驗證）</span>
            <textarea value={draft.note} onChange={(e) => onChange({ ...draft, note: e.target.value })}
              placeholder="電號 01-23-4567-89-0。簡訊驗證碼會寄到芊的手機。"
              className="rounded-lg border border-gray-300 px-2 py-1.5 min-h-[62px] resize-y" /></label>

          <div className="text-[11px] text-gray-400 leading-relaxed">
            密碼在列表上預設是遮起來的，要按「看密碼」才會出現 ——
            而按下去會記一筆。
          </div>
        </div>

        <div className="sticky bottom-0 bg-white px-5 py-3 border-t border-mor-line flex justify-end gap-2">
          <button onClick={onClose}
            className="rounded-lg border border-gray-300 px-4 py-1.5 text-sm">取消</button>
          <button onClick={save} disabled={saving || bad}
            title={bad ? '「這是什麼」要填' : ''}
            className="rounded-lg bg-mor-slate text-white px-4 py-1.5 text-sm font-medium
                       hover:bg-mor-slatedark disabled:opacity-50">
            {saving ? '儲存中⋯' : draft.id ? '儲存' : '建立'}</button>
        </div>
      </div>
    </div>
  );
}
