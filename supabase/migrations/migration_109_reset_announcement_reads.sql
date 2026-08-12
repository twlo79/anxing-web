-- migration_109：公告內容改了，可以把已讀清掉讓大家重看
--
-- ============================================================
-- 【要解決的問題】
--
-- 公告發出去、大家讀過了。之後把「下次開會 週三」改成「週五」——
-- 讀過的人畫面上不會再出現未讀圓點，他們不知道內容變了，照舊週三到。
--
-- 對「重要日程」這種會一直修改的公告來說，這剛好是最要命的失效方式：
-- 系統看起來運作正常，資訊也確實更新了，只是**沒有人被告知**。
--
--
-- ============================================================
-- 【為什麼是 RPC 而不是讓前端直接 delete】
--
-- announcement_reads 沒有 DELETE 政策。RLS 擋掉的 delete **不會報錯**，
-- 只會影響 0 列 —— 前端會顯示「已重新通知」，而實際上什麼都沒發生。
-- 這個專案已經在 UPDATE 上踩過同一個坑。
--
-- 所以走 SECURITY DEFINER 的 RPC，並且函式自己檢查角色 ——
-- SECURITY DEFINER 繞過 RLS，不自己檢查就是開一個誰都能用的後門。
--
--
-- ============================================================
-- 【為什麼不做成觸發器自動清】
--
-- 觸發器分不出「改開會時間」與「改一個錯字」。每次改錯字都驚動全公司的話，
-- 幾次之後就沒有人理未讀圓點了 —— 而那才是真正的損失：
-- 通知機制一旦被當成雜訊，就再也叫不動人。
--
-- 所以由按下編輯的那個人決定。他知道自己改了什麼。
-- ============================================================

create or replace function public.reset_announcement_reads(p_ann uuid)
returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  n int;
begin
  -- SECURITY DEFINER 繞過 RLS，這裡一定要自己擋
  if current_role_of() is null
     or current_role_of() not in ('manager', 'super_admin') then
    return jsonb_build_object('ok', false, 'code', 'NO_PERM',
      'message', '只有主管與總經理可以重新通知。');
  end if;

  if not exists (select 1 from public.announcements where id = p_ann) then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND',
      'message', '找不到這則公告,可能已經被刪掉了。');
  end if;

  /*
   * 保留操作者自己的已讀。
   *
   * 他剛剛才編輯完，卻在自己的畫面上看到一個未讀圓點 —— 那是假訊號。
   * 而假訊號會讓人開始忽略真訊號。
   */
  delete from public.announcement_reads
   where ann_id = p_ann and user_id is distinct from auth.uid();
  get diagnostics n = row_count;

  return jsonb_build_object('ok', true, 'code', 'OK', 'cleared', n,
    'message', case when n = 0
      then '大家本來就還沒讀，不用重新通知。'
      else format('已重新通知 %s 人,他們會再看到未讀提示。', n) end);
end $fn$;

revoke all on function public.reset_announcement_reads(uuid) from public;
grant execute on function public.reset_announcement_reads(uuid) to authenticated;

comment on function public.reset_announcement_reads(uuid) is
  '把一則公告的已讀清掉（操作者自己的保留），讓所有人重新看到未讀提示。'
  '由編輯者自己決定要不要用 —— 觸發器分不出改時間與改錯字。';


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('109_reset_announcement_reads');
  end if;
end $$;


-- ============================================================
-- 確認（結果直接是表格 —— raise notice 在 SQL Editor 看不到）
-- ============================================================
do $$
declare
  admin_id uuid; hk_id uuid; v_ann uuid; r jsonb; n_before int;
begin
  drop table if exists _chk109;
  create temp table _chk109 (n int, item text, result text, detail text);

  select id into admin_id from public.profiles where role = 'super_admin' limit 1;
  if admin_id is null then
    insert into _chk109 values (0, '前置', '❌ 找不到 super_admin', '');
    return;
  end if;

  insert into _chk109
  select 1, '函式存在',
    case when to_regprocedure('public.reset_announcement_reads(uuid)') is not null
         then '✅' else '❌' end, '';

  -- 建一則測試公告，塞兩筆已讀（操作者自己 ＋ 另一個人）
  perform set_config('request.jwt.claims',
    json_build_object('sub', admin_id::text)::text, true);
  insert into public.announcements (title, body, created_by)
  values ('__RESET_CHECK__', '測試用,會自動刪除', admin_id) returning id into v_ann;

  insert into public.announcement_reads (ann_id, user_id) values (v_ann, admin_id);
  select id into hk_id from public.profiles
   where id <> admin_id and coalesce(active, true) limit 1;
  if hk_id is not null then
    insert into public.announcement_reads (ann_id, user_id) values (v_ann, hk_id);
  end if;
  select count(*) into n_before from public.announcement_reads where ann_id = v_ann;

  r := public.reset_announcement_reads(v_ann);
  insert into _chk109 values (2, '重新通知',
    case when (r->>'ok')::boolean then '✅' else '❌' end, r->>'message');

  insert into _chk109 values (3, '★ 操作者自己的已讀要保留',
    case when exists (select 1 from public.announcement_reads
                       where ann_id = v_ann and user_id = admin_id)
         then '✅' else '❌ 編輯完自己畫面冒出未讀,那是假訊號' end, '');

  if hk_id is not null then
    insert into _chk109 values (4, '其他人的已讀被清掉',
      case when not exists (select 1 from public.announcement_reads
                             where ann_id = v_ann and user_id = hk_id)
           then '✅' else '❌' end, '原本 ' || n_before || ' 筆已讀');
  end if;

  -- 房管不能用（SECURITY DEFINER 繞過 RLS，靠函式自己擋）
  select id into hk_id from public.profiles where role = 'housekeeper' limit 1;
  if hk_id is null then
    insert into _chk109 values (5, '房管不能重新通知', '－', '沒有房管帳號,跳過');
  else
    perform set_config('request.jwt.claims',
      json_build_object('sub', hk_id::text)::text, true);
    insert into _chk109 values (5, '房管不能重新通知',
      case when (public.reset_announcement_reads(v_ann)->>'code') = 'NO_PERM'
           then '✅' else '❌ 誰都能清別人的已讀' end, '');
    perform set_config('request.jwt.claims',
      json_build_object('sub', admin_id::text)::text, true);
  end if;

  -- 收尾
  delete from public.announcements where id = v_ann;
end $$;

select item as "檢查項目", result as "結果", detail as "說明"
from _chk109 order by n;
