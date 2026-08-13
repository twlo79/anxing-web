'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ReqMark } from '@/components/Req';
import { createClient } from '@/lib/supabase';
import { BTN, BTN2, CARD, INPUT, noRowsMsg, type Announcement, type TabProps } from './types';
import { noticeContentChanged } from '@/lib/notice';

/**
 * 公告。
 *
 * 【只做 LINE 做不到的三件事】
 * 留得住（不會被閒聊沖掉）、置頂得了（重要的不靠時間排序）、
 * 看得到誰讀過（「我沒看到」在 LINE 上無法反駁）。
 *
 * 沒有留言、沒有附件、沒有分類 —— 加了那些，公告就變成第二個聊天室，
 * 而第二個聊天室不會有人看。
 */

export default function NoticeTab({ me, isAdmin, onMsg }: TabProps) {
  const supabase = useMemo(() => createClient(), []);
  const [list, setList] = useState<Announcement[]>([]);
  const [readIds, setReadIds] = useState<Set<string>>(new Set());
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [open, setOpen] = useState<string | null>(null);
  const [unread, setUnread] = useState<Record<string, string[]>>({});
  const [editing, setEditing] = useState<Partial<Announcement> | null>(null);
  /** 編輯前的原文。用來判斷內容是不是真的變了 —— 沒有這份就只能每次都問。 */
  const [orig, setOrig] = useState<{ title: string; body: string } | null>(null);
  const [renotify, setRenotify] = useState(false);

  const load = useCallback(async () => {
    const [{ data: an }, { data: rd }, { data: pf }] = await Promise.all([
      supabase.from('announcements').select('*')
        .order('pinned', { ascending: false }).order('created_at', { ascending: false }),
      supabase.from('announcement_reads').select('ann_id').eq('user_id', me.id),
      supabase.from('profiles').select('id, name'),
    ]);
    setList((an ?? []) as Announcement[]);
    setReadIds(new Set((rd ?? []).map((r) => r.ann_id as string)));
    setNames(new Map((pf ?? []).map((p) => [p.id as string, p.name as string])));
  }, [supabase, me.id]);

  useEffect(() => { load(); }, [load]);

  /**
   * 展開就算已讀。
   *
   * 不做「我已讀」按鈕 —— 沒有人會按，然後未讀名單永遠是全公司，
   * 那份名單就失去意義了。展開看內容已經是他讀過的最好證據。
   */
  async function openOne(a: Announcement) {
    const next = open === a.id ? null : a.id;
    setOpen(next);
    if (next && !readIds.has(a.id)) {
      await supabase.rpc('mark_announcement_read', { p_ann: a.id });
      setReadIds(new Set([...readIds, a.id]));
    }
    if (next && isAdmin && !unread[a.id]) {
      const { data } = await supabase.rpc('announcement_unread', { p_ann: a.id });
      setUnread({ ...unread, [a.id]: (data ?? []).map((x: { name: string }) => x.name) });
    }
  }

  /**
   * 開始編輯。記下原文，並依「內容有沒有變」預設重新通知的勾選狀態。
   * a = null 代表發布新公告。
   */
  function startEdit(a: Announcement | null) {
    setEditing(a ?? { pinned: false, active: true });
    setOrig(a ? { title: a.title, body: a.body } : null);
    setRenotify(false);
  }

  // 內容真的變了才顯示「重新通知」—— 改置頂、改上下架不該問這個問題
  const changed = noticeContentChanged(orig, {
    title: editing?.title ?? '', body: editing?.body ?? '',
  });
  // 內容一變就自動勾起來；使用者可以取消（改錯字就不用驚動全公司）
  useEffect(() => { setRenotify(changed); }, [changed]);

  async function save() {
    if (!editing) return;
    if (!editing.title?.trim() || !editing.body?.trim()) {
      return onMsg('標題與內容都要填。', true);
    }
    const patch = {
      title: editing.title.trim(), body: editing.body.trim(),
      pinned: !!editing.pinned, active: editing.active ?? true,
    };
    const q = editing.id
      ? supabase.from('announcements').update(patch).eq('id', editing.id)
      : supabase.from('announcements').insert({ ...patch, created_by: me.id });
    const { data, error } = await q.select('id');
    if (error) return onMsg('存不進去：' + error.message, true);
    if (!data?.length) return onMsg(noRowsMsg('公告'), true);

    /*
     * 重新通知 = 清掉已讀，大家的畫面會再出現未讀圓點。
     *
     * 走 RPC 而不是直接 delete：announcement_reads 沒有 DELETE 政策，
     * 被 RLS 擋掉的 delete 不會報錯、只影響 0 列 ——
     * 畫面會說「已重新通知」而實際上沒有人被通知到。
     */
    let extra = '';
    if (editing.id && renotify) {
      const { data: rr, error: re } = await supabase.rpc(
        'reset_announcement_reads', { p_ann: editing.id });
      const res = rr as { ok?: boolean; message?: string } | null;
      if (re) extra = '（但重新通知失敗：' + re.message + '）';
      else if (!res?.ok) extra = '（但重新通知失敗：' + (res?.message ?? '未知原因') + '）';
      else extra = '，' + res.message;
    }
    onMsg((editing.id ? '已更新' : '已發布') + extra, extra.startsWith('（但'));
    setEditing(null); setOrig(null); load();
  }

  const visible = list.filter((a) => a.active || isAdmin);

  return (
    <div className="space-y-3">
      {isAdmin && !editing && (
        <button onClick={() => startEdit(null)} className={BTN}>
          發布公告
        </button>
      )}

      {editing && (
        <div className={`${CARD} p-4 space-y-3`}>
          {/*
            標題與內容都是必填（save 那邊本來就擋「標題與內容都要填」）——
            但畫面上一直看不出來,使用者是按了送出才知道。
            提示字在 placeholder 裡塞不進元件,所以星號貼在框線左上角。
          */}
          <div className="relative">
            <ReqMark />
            <input placeholder="標題" value={editing.title ?? ''}
              onChange={(e) => setEditing({ ...editing, title: e.target.value })}
              className={`${INPUT} w-full`} />
          </div>
          <div className="relative">
            <ReqMark />
            <textarea placeholder="內容" rows={6} value={editing.body ?? ''}
              onChange={(e) => setEditing({ ...editing, body: e.target.value })}
              className={`${INPUT} w-full leading-relaxed`} />
          </div>
          <div className="flex flex-wrap items-center gap-4 text-sm">
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={!!editing.pinned}
                onChange={(e) => setEditing({ ...editing, pinned: e.target.checked })} />
              置頂
            </label>
            {editing.id && (
              <label className="flex items-center gap-1.5">
                <input type="checkbox" checked={editing.active ?? true}
                  onChange={(e) => setEditing({ ...editing, active: e.target.checked })} />
                顯示中
              </label>
            )}
            {/* 只有內容真的變了才出現。改置頂、改上下架不需要問這個問題 */}
            {editing.id && changed && (
              <label className="flex items-center gap-1.5">
                <input type="checkbox" checked={renotify}
                  onChange={(e) => setRenotify(e.target.checked)} />
                重新通知（清掉已讀）
              </label>
            )}
            <div className="flex-1" />
            <button onClick={() => { setEditing(null); setOrig(null); }} className={BTN2}>取消</button>
            <button onClick={save} className={BTN}>{editing.id ? '儲存' : '發布'}</button>
          </div>
          <div className="text-xs text-gray-400 space-y-1">
            <div>不要的公告請取消「顯示中」，不要刪除 —— 公告是講過的話，刪掉之後爭議就沒有證據。</div>
            {editing.id && changed && (
              <div>改了開會時間這種要讓大家重看的，就勾「重新通知」；只是修錯字的話取消勾選。</div>
            )}
          </div>
        </div>
      )}

      <div className={CARD}>
        <div className="divide-y divide-mor-line/60">
          {visible.map((a) => {
            const isOpen = open === a.id;
            const isNew = !readIds.has(a.id);
            return (
              <div key={a.id} className={!a.active ? 'opacity-50' : ''}>
                <button onClick={() => openOne(a)}
                  className="w-full px-4 py-3 text-left hover:bg-white/45">
                  <div className="flex items-center gap-2">
                    {a.pinned && <span className="text-xs text-mor-slate shrink-0">📌</span>}
                    {/* 未讀用圓點，不用「NEW」字樣 —— 中文介面裡英文標籤很跳 */}
                    {isNew && <span className="w-2 h-2 rounded-full bg-mor-slate shrink-0" />}
                    <span className={`text-sm flex-1 min-w-0 truncate ${isNew ? 'font-semibold' : ''}`}>
                      {a.title}
                    </span>
                    {!a.active && <span className="text-[11px] text-gray-400 shrink-0">已下架</span>}
                    <span className="text-[11px] text-gray-400 shrink-0 tabular-nums">
                      {a.created_at.slice(5, 10).replace('-', '/')}
                    </span>
                  </div>
                </button>
                {isOpen && (
                  <div className="px-4 pb-4 -mt-1">
                    <div className="text-sm whitespace-pre-line leading-relaxed text-mor-ink">
                      {a.body}
                    </div>
                    <div className="text-[11px] text-gray-400 mt-2">
                      {names.get(a.created_by ?? '') ?? '—'}　{a.created_at.slice(0, 16).replace('T', ' ')}
                    </div>
                    {isAdmin && (
                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        <button onClick={() => startEdit(a)} className={BTN2}>編輯</button>
                        {/* 未讀名單而不是已讀人數 —— 人數只能說「有人沒讀」，
                            名單才能讓你去敲那個人 */}
                        <span className="text-xs text-gray-500">
                          {unread[a.id] === undefined ? '讀取中…'
                            : unread[a.id].length === 0 ? '全員已讀'
                            : `還沒讀：${unread[a.id].join('、')}`}
                        </span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {!visible.length && (
            <div className="px-4 py-10 text-center text-sm text-gray-400">還沒有公告</div>
          )}
        </div>
      </div>
    </div>
  );
}
