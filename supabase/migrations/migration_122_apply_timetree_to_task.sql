-- migration_122：把 TimeTree 的排班套到 hk_task 上
--
-- ============================================================
-- 【兩份資料各有一半】
--
--   hk_task        哪天、哪間、什麼工作      ← 從訂單長出來，完整且會自動跟著改
--   hk_work_item   誰做                      ← TimeTree 匯入的，訂單沒有這個資訊
--
-- 缺的那一半正好互補。這支就是把「誰做」套到「哪天哪間」上面。
--
--
-- ============================================================
-- 【為什麼不直接拿 TimeTree 覆蓋整個月】
--
-- 直覺是「TimeTree 是人排的，比較準，整個月換掉就好」。那會弄丟東西：
--
--   1. TimeTree 的月曆每天只顯示前幾筆，其餘收成「+3」。
--      抓取要逐一點開才拿得到全部 —— 漏掉的那幾筆如果先把
--      自動產生的刪光，就**永遠不見了**，而且沒有任何跡象。
--
--   2. 自動產生的那些跟訂單連動：訂單改日期，工作跟著搬。
--      換成手動的之後那條線就斷了，之後延住兩晚不會有人知道。
--
-- 所以這支**只覆蓋「指派給誰」，不刪任何工作**。
-- 兩邊對不上的地方寫進報告，讓人自己看 —— 那份差異本身就是資訊：
-- TimeTree 有而 ERP 沒有的，多半是公區清潔、贈品這類訂單推導不出來的；
-- ERP 有而 TimeTree 沒有的，多半是排班漏了。

create or replace function public.hk_apply_timetree(
  p_from date, p_to date, p_dry boolean default true
) returns table(item text, n bigint, detail text)
language plpgsql security definer set search_path = public as $fn$
declare
  v_assigned bigint := 0;
  v_created  bigint := 0;
begin
  if current_role_of() not in ('manager', 'super_admin') then
    return query select '權限不足'::text, 0::bigint, '只有主管以上能套用排班'::text;
    return;
  end if;

  /*
   * 兩張對照表。
   *
   * 【房源】hk_property.code ↔ properties.name（或 aliases）
   * 【人員】hk_staff.name    ↔ staff.name（或 aliases）
   *
   * 對不上的不猜。猜錯的成本是「工作被指派給錯的人」——
   * 那個人不會知道，而該做的人也不會知道。
   */
  create temp table _tt_map on commit drop as
  select wi.id            as wi_id,
         wi.work_date,
         wi.work_type,
         wi.property_code,
         p.id             as property_id,
         s.id             as staff_id,
         hs.name          as hk_staff_name
    from hk_work_item wi
    left join hk_property hp on hp.code = wi.property_code
    left join properties  p  on p.name = hp.code or p.name = any(hp.aliases)
                                or p.name = wi.property_code
    left join hk_staff    hs on hs.id = wi.staff_id
    left join staff       s  on s.name = hs.name or hs.name = any(coalesce(s.aliases, '{}'))
   where wi.work_date between p_from and p_to;

  if not p_dry then
    /*
     * 一、有對到的工作 → 蓋掉指派。
     *
     * 同一天同一間可能有好幾筆（退房清潔 ＋ 入住清潔），
     * 工作類型也要對上才算同一筆 —— 不然退房的班會被指派成入住的人。
     */
    with hit as (
      update hk_task t
         set staff_id = m.staff_id
        from _tt_map m
       where t.work_date  = m.work_date
         and t.property_id = m.property_id
         and t.work_type  = m.work_type
         and m.staff_id is not null
         and t.done_at is null            -- 做完的不動,那是已經發生的事實
      returning t.id
    ) select count(*) into v_assigned from hit;

    /*
     * 二、TimeTree 有、ERP 沒有的 → 補一筆人工工作。
     *
     * 那些是訂單推導不出來的：公區清潔、贈品補充、細清。
     * 標成人工（auto_kind = null）—— 它們沒有對應的訂單，
     * 不該跟著任何訂單的日期跑。
     */
    with miss as (
      insert into hk_task (work_date, property_id, work_type, staff_id, note)
      select m.work_date, m.property_id, m.work_type, m.staff_id, 'TimeTree 匯入'
        from _tt_map m
       where m.property_id is not null
         and not exists (
           select 1 from hk_task t
            where t.work_date = m.work_date
              and t.property_id = m.property_id
              and t.work_type = m.work_type)
      returning id
    ) select count(*) into v_created from miss;
  end if;

  -- ── 報告 ────────────────────────────────────
  return query
  select '期間'::text, 0::bigint, (p_from::text || ' ~ ' || p_to::text
    || case when p_dry then '（試算,沒有寫入）' else '' end);

  return query select 'TimeTree 排班筆數'::text, count(*), ''::text from _tt_map;

  return query
  select '★ 套上指派'::text,
         case when p_dry then
           (select count(*) from _tt_map m join hk_task t
              on t.work_date = m.work_date and t.property_id = m.property_id
             and t.work_type = m.work_type
            where m.staff_id is not null and t.done_at is null)
         else v_assigned end,
         '把「誰做」寫到已經存在的工作上'::text;

  return query
  select '★ 補上 ERP 沒有的工作'::text,
         case when p_dry then
           (select count(*) from _tt_map m
             where m.property_id is not null
               and not exists (select 1 from hk_task t
                     where t.work_date = m.work_date and t.property_id = m.property_id
                       and t.work_type = m.work_type))
         else v_created end,
         '公區清潔、贈品這些訂單推導不出來的'::text;

  return query
  select '⚠ 房源對不到'::text, count(*),
         coalesce(string_agg(distinct property_code, '、'), '')
    from _tt_map where property_id is null and property_code is not null;

  return query
  select '⚠ 人員對不到'::text, count(*),
         coalesce(string_agg(distinct hk_staff_name, '、'), '')
    from _tt_map where staff_id is null and hk_staff_name is not null;

  /*
   * ERP 有而 TimeTree 沒有的。
   *
   * 這個數字要看：多半是「排班漏了那幾間」——
   * 訂單說那天有人退房，但沒有人被排去清。
   */
  return query
  select '★ 還是沒人指派的'::text, count(*),
         '訂單說那天要清,但排班表上沒有 —— 這幾筆要人補'::text
    from hk_task t
   where t.work_date between p_from and p_to
     and t.staff_id is null and t.done_at is null;
end $fn$;

grant execute on function public.hk_apply_timetree(date, date, boolean) to authenticated;

comment on function public.hk_apply_timetree(date, date, boolean) is
  '把 TimeTree 匯入的排班（hk_work_item）的「誰做」套到 hk_task 上。'
  '只覆蓋指派，不刪任何工作 —— TimeTree 的抓取可能不完整，'
  '先刪再補會把漏掉的那幾筆永遠弄丟。預設 dryRun。';


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('122_apply_timetree_to_task');
  end if;
end $$;


-- ============================================================
-- 先看看七、八月會怎麼樣（試算，一個字都不寫）
-- ============================================================
--
-- 【為什麼一次看兩個月】
-- 七月的排班已經確定、也做完了，八月還在進行中。兩個月放在一起看，
-- 「房源對不到」「人員對不到」那兩個數字才有基準 ——
-- 只看八月的話，分不出「這個名字是新來的」還是「主檔一直都缺」。
--
-- 數字合理之後把最後一個參數改成 false 實際套用：
--
--     select * from hk_apply_timetree('2026-07-01', '2026-08-31', false);
--
select item as "檢查項目", n as "筆數", detail as "說明"
  from public.hk_apply_timetree('2026-07-01', '2026-08-31', true);
