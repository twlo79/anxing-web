/*
 * audit_hk_verify_202608 —— 用 SQL 重算一次八月的間數與點數（唯讀）
 * ============================================================
 * 2026-09-02 使用者：「看一下 這些數字有對嗎 請驗算」
 *
 * ============================================================
 * 【★★★ 為什麼這樣驗算才有意義】
 *
 * 畫面上的「各物業合計 = 各列相加」是**必然成立**的 ——
 * 那些數字都出自同一支 `eachShare`，加起來當然對。
 * 拿它當驗算等於用同一把尺量兩次（CLAUDE.md 2026-09-02:
 * 「拿兩個問法不同的檢查互相比較」的反面 —— 這次是問法完全相同）。
 *
 * ★ 所以這支**用 SQL 從 hk_work_item 重算一次**，
 *   跟前端的 TypeScript 是兩份獨立的實作。兩邊對得起來才叫驗算。
 *
 * ============================================================
 * 【複製了前端的哪些規則】
 *
 *   ① 排除 `贈品補充`（當 include_gift = false 時）
 *   ② 排除「沒有房源、而且沒有手填間數與點數」的（hkParse:filterItems）
 *   ③ 排除 `count_workload = false` 的工作類型
 *   ④ 合掃各 1/人數（同一天、同一房源、同一工作類型 = 同一份工）
 *   ⑤ 同一個人在同一份工上重複出現只算一次
 *   ⑥ 間數 = coalesce(units_override, 1) / 人數
 *   ⑦ 點數 = points_override / 人數；沒填就用 間數 × properties.clean_points
 *
 * ★★ 這幾條如果我抄錯了，兩邊就會對不起來 —— 而**那本身就是有用的資訊**:
 *   對不起來時先看是哪一條，不要預設是前端錯。
 */

-- ══════════════════════════════════════════════════════════
-- ① 各物業的間數與點數（SQL 版）
-- ══════════════════════════════════════════════════════════
with base as (
  select w.id, w.work_date, w.work_type, w.staff_id,
         w.property_code, w.units_override, w.points_override,
         hp.property_id,
         coalesce(e.name, '⚠ 未歸物業') as estate,
         pr.clean_points
    from public.hk_work_item w
    left join public.hk_property hp on hp.code = w.property_code
    left join public.properties  pr on pr.id = hp.property_id
    left join public.estates      e on e.id = pr.estate_id
    left join public.hk_work_type wt on wt.code = w.work_type
   where w.period = '202608'
     and w.staff_id is not null
     -- ② 沒有房源、也沒有手填間數／點數的不算
     and (coalesce(w.property_code, '') <> ''
          or w.units_override is not null
          or w.points_override is not null)
     -- ③ 不計工作量的類型不算
     and coalesce(wt.count_workload, true)
     -- ① 贈品補充（設定為不含時）。★ 這裡固定排除，
     --    如果 hk_setting 的 include_gift 是 true，這一支會比畫面少
     and w.work_type <> '贈品補充'
),
/* ④⑤ 同一份工有幾個**不同的人** */
crew as (
  select work_date, coalesce(property_id::text, '') as pid, work_type,
         count(distinct staff_id) as n
    from base group by 1, 2, 3
),
/* 同一個人在同一份工上重複出現只算一次 */
dedup as (
  select distinct on (b.work_date, coalesce(b.property_id::text, ''), b.work_type, b.staff_id)
         b.*, c.n
    from base b
    join crew c on c.work_date = b.work_date
               and c.pid = coalesce(b.property_id::text, '')
               and c.work_type = b.work_type
   order by b.work_date, coalesce(b.property_id::text, ''), b.work_type, b.staff_id, b.id
),
calc as (
  select estate,
         coalesce(units_override, 1)::numeric / n                     as units,
         case when points_override is not null
              then points_override::numeric / n
              when clean_points is not null
              then (coalesce(units_override, 1)::numeric / n) * clean_points
              else 0 end                                             as points,
         case when points_override is null and clean_points is null
              then 1 else 0 end                                      as unknown
    from dedup
)
select
  estate                                     as "物業",
  round(sum(units), 2)                       as "間數（SQL 算的）",
  round(sum(points), 2)                      as "點數（SQL 算的）",
  sum(unknown)                               as "算不出點數的筆數"
from calc
group by estate
union all
select '＝＝ 合計 ＝＝',
       round(sum(units), 2), round(sum(points), 2), sum(unknown)
from calc
order by 1;


-- ══════════════════════════════════════════════════════════
-- ② 同一天、同一房源、同一個人出現兩次的
-- ══════════════════════════════════════════════════════════
/*
 * ★★ 使用者在日誌上看到 08-09 庭玉 B08 **出現兩列**。
 *
 * 兩種可能，這一段分辨得出來:
 *
 *   工作類型不同   合法（退房清潔 ＋ 加強清潔是兩次不同的工作），
 *                  只是日誌上沒有顯示類型，所以看起來一樣
 *   工作類型相同   **重複的資料** —— 那一間那天被算了兩次
 *
 * ★ 後者要處理:間數與點數都會多一份，而畫面上看不出來
 *   （同一天、同一間、同一個人，只是多了一列）。
 */
select
  w.work_date                                as "日期",
  w.property_code                            as "房源",
  s.name                                     as "誰做的",
  count(*)                                   as "幾列",
  string_agg(distinct w.work_type, '、')      as "工作類型",
  string_agg(coalesce(w.source, '?'), '、')   as "來源",
  case when count(distinct w.work_type) = 1
       then '⚠⚠⚠ 類型相同 —— 重複的資料，那一間被算了兩次'
       else '✅ 類型不同，是兩次不同的工作' end   as "★ 判斷"
from public.hk_work_item w
left join public.hk_staff s on s.id = w.staff_id
where w.period = '202608'
group by w.work_date, w.property_code, s.name
having count(*) > 1
order by w.work_date;


-- ══════════════════════════════════════════════════════════
-- ③ 每個人的間數（跟上方卡片對照）
-- ══════════════════════════════════════════════════════════
/*
 * ★★★ 這是最重要的一條:**各物業的合計必須等於每個人的合計相加**。
 *   兩個數字在同一個畫面上，對不起來的話兩邊都失去意義。
 */
with base as (
  select w.id, w.work_date, w.work_type, w.staff_id, hp.property_id,
         w.units_override
    from public.hk_work_item w
    left join public.hk_property hp on hp.code = w.property_code
    left join public.hk_work_type wt on wt.code = w.work_type
   where w.period = '202608' and w.staff_id is not null
     and (coalesce(w.property_code, '') <> ''
          or w.units_override is not null or w.points_override is not null)
     and coalesce(wt.count_workload, true)
     and w.work_type <> '贈品補充'
),
crew as (
  select work_date, coalesce(property_id::text, '') pid, work_type,
         count(distinct staff_id) n
    from base group by 1, 2, 3
),
dedup as (
  select distinct on (b.work_date, coalesce(b.property_id::text, ''), b.work_type, b.staff_id)
         b.*, c.n
    from base b
    join crew c on c.work_date = b.work_date
               and c.pid = coalesce(b.property_id::text, '')
               and c.work_type = b.work_type
   order by b.work_date, coalesce(b.property_id::text, ''), b.work_type, b.staff_id, b.id
)
select
  coalesce(s.name, '（沒有人）')                          as "人員",
  round(sum(coalesce(d.units_override, 1)::numeric / d.n), 2) as "間數（SQL 算的）"
from dedup d
left join public.hk_staff s on s.id = d.staff_id
group by s.name
union all
select '＝＝ 合計 ＝＝',
       round(sum(coalesce(d.units_override, 1)::numeric / d.n), 2)
from dedup d
order by 1;
