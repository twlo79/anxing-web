-- ============================================================
-- migration_210：房務支出補回 estate_id
--
-- 【症狀】
-- 支出頁的「用途」欄，房務清潔那幾十筆整欄是「—」。
--
-- 【原因】
-- 排班統計的「產生本月支出」寫入時只給了 `property_id`，沒給 `estate_id`。
-- 而支出頁的「用途」欄讀的是 `estate_id`（房源只在抽屜裡才看得到）。
--
-- ★★★ 這是「同一件事的兩個欄位只寫了一個」——
--   `purpose_type` 寫了 'estate'，卻沒有 estate。
--   兩個欄位一起才構成「用途」，而漏掉的那個**不會報錯**:
--   查詢成功、金額正確、只有畫面上少一個字。
--
-- 前端已經在同一輪修好（`estIdByProp`），這一支補既有資料。
--
-- 【範圍】
-- ★ 只動 tags 含「房務」而且 estate_id 是 null 的。
--   其他來源的支出可能有它們自己的理由留空 —— 不順手一起改，
--   「對不上的不猜」（CLAUDE.md）。非房務的同樣形狀在下面第 3 列報數字，
--   有幾筆先看到，要不要動另外決定。
--
-- 【怎麼跑】整份貼進 Supabase SQL Editor，看最後那張表。
-- ============================================================

begin;

-- ── 1. 補 estate_id ──────────────────────────────────────────
update public.expenses e
   set estate_id = p.estate_id
  from public.properties p
 where p.id = e.property_id
   and e.estate_id is null
   and e.property_id is not null
   and p.estate_id is not null
   and e.tags @> array['房務']::text[];

-- ── 2. 記一筆 ────────────────────────────────────────────────
select public.record_migration(
  210,
  'migration_210_hk_expense_estate',
  '房務支出補回 estate_id（產生時只寫了 property_id，支出頁的用途欄因此整欄空白）'
);

commit;

-- ============================================================
-- 自檢。★ `raise notice` 在 SQL Editor 看不到，所以回成一張表。
--
-- ★★ 基準值不用「改動前的數字」—— 那個會被這支自己改掉
--   （CLAUDE.md 2026-09-02）。這裡問的都是改完之後應該成立的事實。
-- ============================================================
with hk as (
  select * from public.expenses where tags @> array['房務']::text[]
)
select '1. 房務支出總筆數' as 檢查,
       count(*)::text     as 結果,
       '參考值，不判斷對錯' as 判定
  from hk

union all
select '2. 房務支出還有幾筆 estate_id 空的',
       count(*)::text,
       case when count(*) = 0 then '✅ 補完了'
            else '⚠ 這些的 property_id 對不到房源，或房源自己就沒有物業'
       end
  from hk
 where estate_id is null
   and property_id is not null

union all
-- ★ 人事費的正隆那筆本來就沒有 property_id（正隆沒有「整棟」這個房源），
--   它的 estate_id 是產生時直接寫的 —— 不該被算成漏掉
select '3. 房務支出裡沒有 property_id 的（人事費・整個物業）',
       count(*)::text,
       case when count(*) = count(*) filter (where estate_id is not null)
            then '✅ 這些都有 estate_id'
            else '❌ 有人事費連物業都沒有，去看 hk_labor_cost'
       end
  from hk
 where property_id is null

union all
select '4. 非房務的支出裡，有房源卻沒物業的',
       count(*)::text,
       '這一支沒動它們。要不要一起補另外決定'
  from public.expenses
 where estate_id is null
   and property_id is not null
   and not (coalesce(tags, '{}') @> array['房務']::text[])

union all
-- ★★ 補完的物業必須真的是那個房源的物業，不是隨便填一個
select '5. estate_id 與房源的物業對不上的',
       count(*)::text,
       case when count(*) = 0 then '✅ 沒有錯置'
            else '❌ 有支出掛在錯的物業底下'
       end
  from hk e
  join public.properties p on p.id = e.property_id
 where e.estate_id is not null
   and p.estate_id is not null
   and e.estate_id <> p.estate_id

union all
select '6. 這一支有沒有被記錄',
       coalesce(max(name), '（沒記到）'),
       case when count(*) = 1 then '✅' else '❌ record_migration 沒寫進去' end
  from public.schema_migrations
 where version = 210;
