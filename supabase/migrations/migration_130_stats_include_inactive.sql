-- migration_130：評價統計納入停用物業
--
-- ============================================================
-- 【同一頁上兩個數字，兩套規則】
--
-- 房源評價頁的總覽卡說「所有平均評價 4.90，1,091 筆，5 星 1,012」，
-- 但點下去彈出的清單是 **1,454 筆**。同一頁、同一個篩選、差 442 筆。
--
-- 原因:總覽卡走 `review_stats()` / `manager_stats()`，那兩支長這樣 ——
--
--     from estates e
--     join properties p on p.estate_id = e.id
--     join reviews   r on r.property_id = p.id
--     where e.active                      ← 這裡
--
-- 而彈出的清單直接查 `reviews`，沒有這個條件。
--
-- 清查結果（2026-08-15）:
--
--     ★ 有算到          1,091 筆   （5 星 1,012）
--     物業已停用：其他     286 筆   （5 星   251）
--     物業已停用：洪家     212 筆   （5 星   191）
--     沒掛房源 / 已刪除       0 筆
--
-- 資料是乾淨的 —— 498 筆全部來自兩個停用物業。所以這不是 bug，
-- 是「停用物業的評價算不算」沒有講清楚，而畫面上寫的是「所有」。
--
--
-- ============================================================
-- 【使用者決定:全部算進來】（2026-08-15）
--
-- 那 498 則評價是真的有人住過、真的寫下的。物業後來不做了，
-- 不代表那段時間的服務沒有發生過。
--
-- **停用是「現在還管不管這棟」，不是「這些事有沒有發生過」。**
-- 拿它來當統計的篩選條件，等於讓一個營運狀態去改寫歷史。
--
-- 影響要知道:
--
--   1. 總平均會從 4.90 掉一點（納入的 498 筆五星率 88.8%，低於現有的 93%）
--   2. **管家評比的分數與筆數會變** —— 曾經帶過洪家的管家，
--      那段成績現在會算進來。這是刻意的:那本來就是他做的。
--
-- 兩個都是「數字變了」而不是「數字錯了」。第一次打開會嚇一跳，
-- 所以下面的自檢把前後對照印出來。
--
--
-- ============================================================
-- 【為什麼不是改前端】
--
-- 前端只是呼叫 RPC。在前端補一個「含停用」的參數的話，
-- 三個呼叫點各要記得傳，而漏掉的那個不會報錯 ——
-- 只會安靜地少算 498 筆，也就是現在這個狀況。
--
-- 規則寫在 SQL 裡，只有一份。

/*
 * 一定要先 drop。
 *
 * `create or replace function` **改不了回傳型別** —— 這次多了 `active` 一欄，
 * 直接 replace 會噴 `cannot change return type of existing function`，
 * 而 SQL Editor 把整份包在一個交易裡,那一行失敗會讓下面的 manager_stats
 * 也一起回滾。
 */
drop function if exists public.review_stats(date, date);

create function public.review_stats(
  p_from date default null, p_to date default null
) returns table(
  estate_id uuid, estate_name text, manager text,
  sort int, review_count bigint, avg_rating numeric,
  /*
   * 多回一欄，讓畫面標得出「這棟已經停用」。
   *
   * 納入但不標示的話，物業排行榜上會突然多兩個已經不做的物業，
   * 看起來像資料錯了 —— 而「數字變了」跟「數字錯了」在畫面上長得一樣。
   */
  active boolean
) language sql stable as $fn$
  /*
   * 沒有 `where e.active`。
   *
   * 停用物業的評價照算 —— 那些住宿真的發生過。
   * 停用只表示「現在不管這棟了」，不該回頭改寫歷史統計。
   */
  select e.id, e.name, e.manager, e.sort, count(r.id), round(avg(r.overall_rating), 2), e.active
  from estates e
  join properties p on p.estate_id = e.id
  join reviews r on r.property_id = p.id
  where (p_from is null or r.checkout_date >= p_from)
    and (p_to   is null or r.checkout_date <= p_to)
  group by e.id, e.name, e.manager, e.sort, e.active
  order by e.sort;
$fn$;

comment on function public.review_stats(date, date) is
  '各物業的評價數與平均。**含停用物業**（migration_130）—— '
  '停用是「現在還管不管這棟」,不是「這些事有沒有發生過」。'
  '前端要區分的話看 estates.active,不要在這裡濾掉。';


create or replace function public.manager_stats(
  p_from date default null, p_to date default null
) returns table(
  manager text, avg_rating numeric,
  s5 bigint, s4 bigint, s3 bigint, s2 bigint, s1 bigint, total bigint
) language sql stable as $fn$
  select
    coalesce(m.name, '未指派'),
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
  /*
   * lateral 而不是普通 join —— 普通 join 在任期重疊時會把同一則評價
   * 變成兩列（雖然有排他約束擋著，但那是兩道防線）。
   * limit 1 保證一則評價只會算一次。
   */
  left join lateral (
    select s.name
    from public.estate_managers em
    join public.staff s on s.id = em.staff_id
    where em.estate_id = e.id
      and r.checkout_date >= em.start_date
      and (em.end_date is null or r.checkout_date <= em.end_date)
    limit 1
  ) m on true
  -- 同上：不濾 e.active。曾經帶過洪家的管家，那段成績本來就是他做的
  where (p_from is null or r.checkout_date >= p_from)
    and (p_to   is null or r.checkout_date <= p_to)
  group by coalesce(m.name, '未指派')
  order by 1
$fn$;

comment on function public.manager_stats(date, date) is
  '管家評分。依**退房日**回查 estate_managers 決定歸屬 —— '
  '改管家不會動到歷史成績。查不到任期的落在「未指派」。'
  '**含停用物業**（migration_130）—— 曾經帶過那棟的成績本來就算他的。';


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('130_stats_include_inactive');
  end if;
end $$;


-- ============================================================
-- 驗證
-- ============================================================
do $$
declare n bigint; a numeric;
begin
  drop table if exists _chk130;
  create temp table _chk130 (ord int, item text, result text, detail text);

  -- 資料庫的真相
  select count(*), round(avg(overall_rating), 2) into n, a from public.reviews;
  insert into _chk130 values (1, '★ reviews 全部', n || ' 筆・平均 ' || a, '這是基準');

  -- review_stats 現在應該等於上面
  select sum(review_count) into n from public.review_stats();
  insert into _chk130 values (2, '★★ review_stats 合計', n || ' 筆',
    case when n = (select count(*) from public.reviews)
         then '✅ 跟 reviews 對上了（原本是 1,091）'
         else '❌ 還是對不上 —— 除了 e.active 之外還有別的條件在濾' end);

  select sum(total) into n from public.manager_stats();
  insert into _chk130 values (2, '★★ manager_stats 合計', n || ' 筆',
    case when n = (select count(*) from public.reviews)
         then '✅ 跟 reviews 對上了'
         else '❌ 對不上 —— 可能有評價的退房日落在所有任期之外' end);

  -- 這次多進來的是哪些
  insert into _chk130
  select 5, '新納入：' || e.name, count(*) || ' 筆',
         '平均 ' || round(avg(r.overall_rating), 2)
    from public.reviews r
    join public.properties p on p.id = r.property_id
    join public.estates e on e.id = p.estate_id
   where not e.active
   group by e.name;

  /*
   * 管家評比前後對照。
   *
   * 這一段是給人看的，不是給程式看的 —— 數字會變，
   * 而「變了」跟「錯了」在畫面上長得一模一樣。
   * 先看過一次就不會慌。
   */
  insert into _chk130
  select 8, '管家：' || manager, total || ' 筆・' || avg_rating,
         '（含停用物業之後的數字）'
    from public.manager_stats();
end $$;

select item as "檢查項目", result as "結果", detail as "說明"
from _chk130 order by ord, item;
