-- migration_63：合併 南京5 與 台4
--
-- 這兩組被 migration_62 跳過，因為兩筆都是「使用中」，那支的自動規則
-- （同名群組裡剛好一筆 active）判斷不了。查證後兩組都能處理，但
-- **留下哪一筆的判準跟 migration_62 不同**：
--
--   migration_62：留「使用中」的那筆
--   這一支：留「持有 airbnb_listing_id」的那筆
--
-- 理由是 listing id 有 UNIQUE 約束，搬不到另一筆上。留著沒有 id 的那筆
-- 等於把 id 丟掉，之後 Airbnb 用那個 listing 匯入就會再長出一筆新房源。
--
--
-- 【南京5】兩筆都沒有 listing，留有資料的那筆
--   e79f3ece…  0 訂單 / 0 評價 / 0 清潔 / 無 listing / 2026-07-16 建
--   ddd85d06…  67 訂單 / 4 評價 / 無 listing / 2026-07-20 建   ← 留這筆
--   前者是空殼，誤建的。既然沒有 listing id 也沒有任何資料引用，直接刪掉。
--
-- 【台4】同一間房被拆成兩筆
--   6bbf8d1a…  listing 22868412 / 5 訂單 / 183 評價 / 3 清潔   ← 留這筆
--   ce370f30…  無 listing / 33 訂單 / 3 評價 / 2026-07-20 建
--   兩筆的訂單 property_raw 都是「台4」、都屬於「台視」，確定是同一間。
--   183 則評價是那個 listing 的完整歷史，而且 listing id 只有前者有。
--   後者的 33 筆訂單搬過去之後就是空的，沒有 listing id 要保留，直接刪掉。

do $$
declare
  pairs constant uuid[][] := array[
    -- [留下, 刪除]
    array['ddd85d06-610f-482e-b35f-56d60189fe1e', 'e79f3ece-1450-4638-ae71-22fd45b2e4b5'],  -- 南京5
    array['6bbf8d1a-8cd1-418e-8eac-b98d88497a97', 'ce370f30-17ba-4399-81f8-58f7b0ef03d8']   -- 台4
  ];
  i int;
  keep_id uuid;
  drop_id uuid;
  nm text;
  left_over int;
begin
  for i in 1 .. array_length(pairs, 1) loop
    keep_id := pairs[i][1];
    drop_id := pairs[i][2];

    -- 已經合併過就跳過。這支要能重複執行 ——
    -- 不能跑第二次的 migration，出事時沒有人敢重跑。
    if not exists (select 1 from properties where id = drop_id) then
      raise notice '% 已不存在，應該是先前跑過了，跳過', drop_id;
      continue;
    end if;
    if not exists (select 1 from properties where id = keep_id) then
      raise exception '要保留的 % 不存在，中止', keep_id;
    end if;

    -- 兩筆必須同名同物業，否則是判斷錯了
    -- （原本這三個條件寫在同一個 not exists 裡，訊息無法分辨是哪一個不成立，
    --   結果重跑時噴出「不同名或不同物業」，實際上只是那筆已經被刪掉了。）
    if not exists (
      select 1 from properties a, properties b
       where a.id = keep_id and b.id = drop_id
         and a.name = b.name
         and a.estate_id is not distinct from b.estate_id
    ) then
      raise exception '% 與 % 不同名或不同物業，中止', keep_id, drop_id;
    end if;

    -- 要刪的那筆不該有 listing id（有的話代表判準用錯了，該留的是它）
    if exists (select 1 from properties where id = drop_id and airbnb_listing_id is not null) then
      raise exception '% 持有 airbnb_listing_id，不能刪除', drop_id;
    end if;

    select name into nm from properties where id = keep_id;

    -- ── 搬資料 ──────────────────────────────────────────────
    update orders                 set property_id = keep_id where property_id = drop_id;
    update reviews                set property_id = keep_id where property_id = drop_id;
    update cleaning_records       set property_id = keep_id where property_id = drop_id;
    update expenses               set property_id = keep_id where property_id = drop_id;
    update deposits               set property_id = keep_id where property_id = drop_id;
    update purchase_request_items set property_id = keep_id where property_id = drop_id;
    delete from staff_properties sp
     where sp.property_id = drop_id
       and exists (select 1 from staff_properties x
                    where x.staff_id = sp.staff_id and x.property_id = keep_id);
    update staff_properties set property_id = keep_id where property_id = drop_id;

    -- 別名併過去，之後用舊寫法匯入才對得到
    update properties p
       set name_aliases = array(
             select distinct x from unnest(
               coalesce(p.name_aliases, '{}') ||
               coalesce((select name_aliases from properties where id = drop_id), '{}')
             ) as x where x is not null and x <> ''
           )
     where p.id = keep_id;

    -- ── 刪除空殼 ────────────────────────────────────────────
    -- properties 的外鍵都是 NO ACTION，所以還有東西引用的話這行會失敗。
    -- 這是好事：刪得掉就代表真的清乾淨了，不用另外寫檢查。
    delete from properties where id = drop_id;

    select count(*) into left_over from properties where name = nm;
    raise notice '合併「%」完成，現在剩 % 筆', nm, left_over;
  end loop;
end $$;


-- ============================================================
-- 驗證
-- ============================================================

-- 1) 這兩間現在各只該有一筆
select p.id, p.name, p.active, p.airbnb_listing_id, p.name_aliases,
       (select count(*) from orders o where o.property_id = p.id)           as 訂單,
       (select count(*) from reviews r where r.property_id = p.id)          as 評價,
       (select count(*) from cleaning_records c where c.property_id = p.id) as 清潔
from properties p
where p.name in ('南京5', '台4')
order by p.name;
-- 預期：南京5 → 67 訂單 / 4 評價；台4 → 38 訂單 / 186 評價 / 3 清潔

-- 2) 全站還有沒有同名房源（應為空）
select name, count(*) as 筆數, count(*) filter (where active) as 使用中
from properties where name not like '舊-%'
group by name having count(*) > 1 order by name;

-- 3) 被 migration_62 改名停用的那些，底下應該全空
select p.name, p.airbnb_listing_id,
       (select count(*) from orders o where o.property_id = p.id)  as 訂單,
       (select count(*) from reviews r where r.property_id = p.id) as 評價
from properties p where p.name like '舊-%' order by p.name;
