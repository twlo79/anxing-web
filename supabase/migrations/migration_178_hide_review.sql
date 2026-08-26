-- migration_178：人工隱藏評價
--
-- ============================================================
-- 【要做什麼】（2026-08-25 使用者:「幫我設計 可以人工刪除」）
--
--   隱藏的評價不算進平均星等與管家排行（使用者選的）
--   綽經理與總管理員可以隱藏（使用者選的 —— 現有 RLS 剛好就是這兩個角色）
--
--
-- ============================================================
-- 【★★ 為什麼不是真的 DELETE】
--
-- 評價是爬蟲用 `airbnb_review_id` upsert 進來的
-- （src/app/api/import/reviews/route.ts）。硬刪掉的話，
-- **下一次同步它就原封不動回來** ——
-- 而使用者會以為是系統壞了，然後再刪一次。
--
-- 所以是「隱藏 ＋ 記住別再收」:留著那一列，標記它。
--
-- ★ 順帶一提，`api/import/reconcile` 那支**確實會硬刪** ——
--   但方向相反:那是「Airbnb 上已經沒有了」才刪。
--   兩者不能混用同一個機制。
--
--
-- ============================================================
-- 【★★ 爬蟲會不會把 hidden_at 蓋掉】
--
-- 不會，但理由要講清楚，因為這正是 README 9.2 那一條的形狀:
--
--   「PostgREST 批次 upsert 取欄位聯集 —— 某列少了鍵會被填 null」
--
-- 那一條講的是**有些列有、有些列沒有**的情況。
-- 這裡是**每一列都沒有** hidden_at ——
-- 欄位不在 INSERT 清單裡，`do update set` 就不會碰它。
--
-- 下面的驗證會**真的 upsert 一次**確認，不是靠推論。
-- ============================================================

create temp table _chk178 (ord int, item text, result text, note text) on commit drop;


-- ============================================================
-- ① 三個欄位
-- ============================================================
alter table public.reviews
  add column if not exists hidden_at     timestamptz,
  add column if not exists hidden_by     uuid,
  add column if not exists hidden_reason text;

comment on column public.reviews.hidden_at is
  '人工隱藏的時間。null = 正常顯示。'
  '★ 不用 DELETE —— 評價是爬蟲 upsert 進來的,刪掉明天就回來（migration_178）。';

comment on column public.reviews.hidden_reason is
  '為什麼隱藏。★ 必填 —— 三個月後看到一則被藏起來的四星評價,'
  '「誰藏的」查得到但「為什麼」查不到的話,沒有人敢把它放回去。';

/*
 * ★★ 三欄要嘛都有、要嘛都沒有。
 *
 *   只有 hidden_at 而沒有 hidden_by 的話，那則評價從清單上消失了
 *   而**沒有人要負責** —— 查不到是誰藏的，也就沒有人能說明為什麼。
 *   這種列只會出現在「有人直接下 SQL」的時候，而那正是最該擋的時候。
 */
do $$ begin
  alter table public.reviews drop constraint if exists rv_hidden_chk;
  alter table public.reviews add constraint rv_hidden_chk
    check (
      (hidden_at is null and hidden_by is null and hidden_reason is null)
      or (hidden_at is not null and hidden_by is not null
          and coalesce(btrim(hidden_reason), '') <> '')
    );
end $$;

/* 清單預設只看沒隱藏的,那是最常跑的查詢 */
create index if not exists reviews_visible_idx
  on public.reviews (checkout_date desc) where hidden_at is null;


-- ============================================================
-- ② 統計要排除隱藏的
-- ============================================================
/*
 * ★★ 使用者選的是「不算」。所以這一步會**改變歷史數字** ——
 *    藏掉一則四星，那一棟的平均就會往上跑。
 *
 *    那是這個功能的重點，不是副作用:藏起來卻照算的話，
 *    畫面會變成「列表 12 則、統計寫 13 則」，
 *    而沒有人知道差的那一則在哪裡。
 *
 * ★ 逐段對照線上定義改，只多一個 `and r.hidden_at is null`。
 *   其餘一個字都不動 —— 順手改別的東西的話，
 *   數字變了會分不出是哪一項造成的。
 */
CREATE OR REPLACE FUNCTION public.review_stats(p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date)
 RETURNS TABLE(estate_id uuid, estate_name text, manager text, sort integer, review_count bigint, avg_rating numeric)
 LANGUAGE sql STABLE
AS $function$
  select e.id, e.name, e.manager, e.sort, count(r.id), round(avg(r.overall_rating), 2)
  from estates e
  join properties p on p.estate_id = e.id
  join reviews r on r.property_id = p.id
  where e.active
    and r.hidden_at is null
    and (p_from is null or r.checkout_date >= p_from)
    and (p_to is null or r.checkout_date <= p_to)
  group by e.id, e.name, e.manager, e.sort
  order by e.sort;
$function$;

CREATE OR REPLACE FUNCTION public.manager_stats(p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date)
 RETURNS TABLE(manager text, avg_rating numeric, s5 bigint, s4 bigint, s3 bigint, s2 bigint, s1 bigint, total bigint)
 LANGUAGE sql STABLE
AS $function$
  select
    coalesce(e.manager, '未指派'),
    round(avg(r.overall_rating), 2),
    count(*) filter (where r.overall_rating >= 5),
    count(*) filter (where r.overall_rating >= 4 and r.overall_rating < 5),
    count(*) filter (where r.overall_rating >= 3 and r.overall_rating < 4),
    count(*) filter (where r.overall_rating >= 2 and r.overall_rating < 3),
    count(*) filter (where r.overall_rating < 2),
    count(*)
  from reviews r
  join properties p on p.id = r.property_id
  join estates e on e.id = p.estate_id
  where e.active
    and r.hidden_at is null
    and (p_from is null or r.checkout_date >= p_from)
    and (p_to is null or r.checkout_date <= p_to)
  group by coalesce(e.manager, '未指派')
  order by 1;
$function$;

/*
 * ★ `cleaning_staff_stats` **不用改** —— 那支算的是 cleaning_records，
 *   跟 reviews 沒有關係。查過了，不是漏掉的。
 */


-- ============================================================
-- ③ 權限
-- ============================================================
/*
 * 現有的 `reviews_write` 政策已經是 manager + super_admin，
 * 剛好就是使用者選的兩個角色 —— **這一支不改 RLS**。
 *
 * ★ 少改一樣東西就少一個出錯的地方。
 *   下面的驗證會確認那條政策真的還是那兩個角色，
 *   不是假設它沒被人動過。
 */


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('178_hide_review');
  end if;
end $$;


-- ============================================================
-- 驗證
-- ============================================================
/*
 * ★★ 最重要的一題:藏起來之後，統計會不會真的少一則。
 *
 *   問的是**結果**（統計的數字），不是「函式定義裡有沒有那一行」——
 *   後者等於把上面那段 SQL 抄一次檢查自己（README 9.4 #12，174 的教訓）。
 */
do $$
declare v_rid uuid; v_uid uuid; v_est uuid;
        n0 bigint; a0 numeric; n1 bigint; a1 numeric; v_msg text;
begin
  select id into v_uid from public.profiles limit 1;
  select r.id, e.id into v_rid, v_est
    from public.reviews r
    join public.properties p on p.id = r.property_id
    join public.estates e on e.id = p.estate_id
   where e.active and r.hidden_at is null
   limit 1;

  if v_rid is null or v_uid is null then
    insert into _chk178 values (1, '★★ 藏起來之後統計會少一則', '⚠ 測不出來',
      '找不到可測的評價（要有 property 且物業是營運中）');
    return;
  end if;

  begin
    select review_count, avg_rating into n0, a0
      from public.review_stats() where estate_id = v_est;

    update public.reviews
       set hidden_at = now(), hidden_by = v_uid, hidden_reason = '__178測試__'
     where id = v_rid;

    select review_count, avg_rating into n1, a1
      from public.review_stats() where estate_id = v_est;

    v_msg := case when n1 = n0 - 1
                  then '✅ ' || n0 || ' → ' || n1 || ' 則'
                       || '，平均 ' || coalesce(a0::text, '—') || ' → ' || coalesce(a1::text, '—')
                  else '❌ 還是 ' || coalesce(n1::text, '(null)') || ' 則' end;
    raise exception using errcode = 'restrict_violation', message = '__rollback__';
  exception when others then
    if sqlerrm <> '__rollback__' then
      v_msg := '❌ ' || sqlerrm;
    end if;
  end;

  insert into _chk178 values (1, '★★ 藏起來之後統計會少一則', coalesce(v_msg, '⚠ 沒跑到'),
    '使用者選的是「不算」—— 平均星等會跟著變,那是重點不是副作用');
end $$;


/*
 * ★★ 第二重要:爬蟲再同步一次，hidden_at 會不會被蓋掉。
 *
 *   蓋掉的話症狀是「藏好的評價過幾小時自己回來了」——
 *   而畫面上不會有任何跡象,使用者只會覺得刪除鍵沒用。
 *
 *   這裡模擬 PostgREST 的 upsert:欄位清單裡**沒有** hidden_*。
 */
do $$
declare v_rid uuid; v_uid uuid; v_aid text; v_still timestamptz; v_msg text;
begin
  select id into v_uid from public.profiles limit 1;
  select id, airbnb_review_id into v_rid, v_aid from public.reviews limit 1;
  if v_rid is null or v_uid is null then return; end if;

  begin
    update public.reviews
       set hidden_at = now(), hidden_by = v_uid, hidden_reason = '__178測試__'
     where id = v_rid;

    -- 爬蟲寫回來的樣子:只帶它自己會產生的欄位
    insert into public.reviews (airbnb_review_id, guest_name, overall_rating, comment, imported_via)
    values (v_aid, '__178測試__', 5, '爬蟲重新同步', 'auto')
    on conflict (airbnb_review_id) do update
      set guest_name = excluded.guest_name,
          overall_rating = excluded.overall_rating,
          comment = excluded.comment,
          imported_via = excluded.imported_via;

    select hidden_at into v_still from public.reviews where id = v_rid;
    v_msg := case when v_still is not null
                  then '✅ 同步之後還是隱藏的'
                  else '❌ 被蓋掉了 —— 藏好的評價會自己回來' end;
    raise exception using errcode = 'restrict_violation', message = '__rollback__';
  exception when others then
    if sqlerrm <> '__rollback__' then
      v_msg := '❌ ' || sqlerrm;
    end if;
  end;

  insert into _chk178 values (2, '★★ 爬蟲同步不會把隱藏蓋掉', coalesce(v_msg, '⚠ 沒跑到'),
    'PostgREST upsert 取欄位聯集,而每一列都沒有 hidden_* —— 這裡實測確認');
end $$;


/*
 * ★ 三欄不完整要被擋下來。這一題要的是 ❌（擋下來）才算對。
 */
do $$
declare v_rid uuid; v_msg text;
begin
  select id into v_rid from public.reviews limit 1;
  if v_rid is null then return; end if;
  begin
    update public.reviews set hidden_at = now() where id = v_rid;   -- 少了 by 與 reason
    v_msg := '❌ 沒擋 —— 會出現沒有人負責的隱藏';
    raise exception using errcode = 'restrict_violation', message = '__rollback__';
  exception when others then
    if sqlerrm = '__rollback__' then
      null;
    elsif sqlerrm like '%rv_hidden_chk%' then
      v_msg := '✅ 擋下來了';
    else
      v_msg := '⚠ 擋下來了但原因不同:' || sqlerrm;
    end if;
  end;
  insert into _chk178 values (3, '★ 只填 hidden_at 會被擋', coalesce(v_msg, '⚠ 沒跑到'),
    '查得到是誰藏的、為什麼藏,才有人敢把它放回去');
end $$;


select "檢查項目", "結果", "說明" from (

  select c.ord, c.item as "檢查項目", c.result as "結果", c.note as "說明"
    from _chk178 c

  union all
  select 4, '★ 可以隱藏的角色',
         coalesce((select array_to_string(regexp_matches(pg_get_expr(polqual, polrelid),
                                                         '\{(.*?)\}'), '')
                     from pg_policy
                    where polrelid = 'public.reviews'::regclass
                      and polname = 'reviews_write'), '⚠ 找不到那條政策'),
         '使用者選的是「經理 + 總管理員」—— 現有政策剛好就是,所以這支不改 RLS'

  union all
  select 5, '目前的評價',
         count(*)::text || ' 則，其中隱藏 '
         || count(*) filter (where hidden_at is not null)::text || ' 則',
         '這支只加欄位與規則,一則都沒有動'
    from public.reviews

) v order by ord;
