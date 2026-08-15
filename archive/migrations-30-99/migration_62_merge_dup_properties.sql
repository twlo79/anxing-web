-- migration_62：合併同名房源（新舊 Airbnb listing）
--
-- 症狀：properties 裡有好幾組同名的房源，看起來像改名改錯了。
--
-- 查證（以 B6 為例）：兩筆都是同一個房間，不是重複建檔。
-- 同一個房間先後有兩個 Airbnb listing —— 舊的下架、開了新的，
-- 兩邊各留了一部分歷史：
--
--   9582acc0…  舊 listing（標題寫 B6）  已停用  1 訂單 / 4 評價
--   b48e159f…  現行 listing（標題無房號）使用中  27 訂單 / 1 評價 / 4 清潔
--
-- 現行那筆的標題沒有房號，無法從標題判斷，改用日曆回推確認：
-- 它唯一那則評價（Morgane，2025-10-31 退房）對得到一筆 property_raw='B6'、
-- 房客同名的訂單 —— 確定是 B6。
--
-- 問題在報表被切成兩半：評價統計只會算到其中一邊。
--
--
-- 【自動處理的條件 —— 刻意保守】
-- 只處理「同名群組裡剛好一筆 active、其餘都 inactive」的情況。
-- 那種情況的判斷是明確的：使用中的那筆是現行房源。
--
-- 兩筆都 active、或全都 inactive 的群組**不動**，列在最後讓人自己看。
-- 那些可能根本是兩個不同的房間剛好同名，自動合併會把資料混在一起，
-- 而且合併後很難拆回去。
--
--
-- 【為什麼不刪掉舊那筆】
-- airbnb_listing_id 是 UNIQUE，舊的 listing id 搬不到現行那筆上。
-- 刪掉之後萬一 Airbnb 用舊 listing 再匯入一次，匯入端會自動長出一筆新房源，
-- 資料又被切開一次。所以舊那筆保留、改名成「舊-{原名}」、維持停用，
-- 純粹佔著那個 listing id。

do $$
declare
  grp      record;
  keep_id  uuid;
  old_row  record;
  moved    int;
  total    int := 0;
  groups   int := 0;
begin
  for grp in
    select p.name,
           count(*)                                as n,
           count(*) filter (where p.active)        as n_active
      from properties p
     where p.name not like '舊-%'          -- 已經處理過的不再碰
     group by p.name
    having count(*) > 1
  loop
    -- 只有「剛好一筆 active」才自動處理
    if grp.n_active <> 1 then
      raise notice '跳過「%」：% 筆同名、% 筆使用中，無法自動判斷哪筆是現行的',
        grp.name, grp.n, grp.n_active;
      continue;
    end if;

    select id into keep_id from properties where name = grp.name and active;
    groups := groups + 1;

    for old_row in
      select id, name, name_aliases, airbnb_listing_id
        from properties
       where name = grp.name and not active
    loop
      -- ── 搬資料 ──────────────────────────────────────────
      -- 更新 orders.property_id 會觸發 trg_sync_order_deposits（它監聽 property_id）
      -- 與 orders_recognize（重算營收認列）。兩者都是我們要的。
      update orders                 set property_id = keep_id where property_id = old_row.id;
      get diagnostics moved = row_count; total := total + moved;
      update reviews                set property_id = keep_id where property_id = old_row.id;
      get diagnostics moved = row_count; total := total + moved;
      update cleaning_records       set property_id = keep_id where property_id = old_row.id;
      update expenses               set property_id = keep_id where property_id = old_row.id;
      update deposits               set property_id = keep_id where property_id = old_row.id;
      update purchase_request_items set property_id = keep_id where property_id = old_row.id;

      -- staff_properties 是複合主鍵，直接改會撞鍵，先刪掉會重複的那幾筆
      delete from staff_properties sp
       where sp.property_id = old_row.id
         and exists (select 1 from staff_properties x
                      where x.staff_id = sp.staff_id and x.property_id = keep_id);
      update staff_properties set property_id = keep_id where property_id = old_row.id;

      -- ── 舊房源的別名併進現行房源 ────────────────────────
      -- 匯入端的房源比對會查別名。不併的話，之後有用舊標題的資料進來
      -- 會對不到而變成「未識別房源」。
      update properties
         set name_aliases = array(
               select distinct x from unnest(
                 coalesce(name_aliases, '{}') || coalesce(old_row.name_aliases, '{}')
               ) as x
               where x is not null and x <> ''
             )
       where id = keep_id;

      -- ── 舊那筆改名並停用 ────────────────────────────────
      update properties set name = '舊-' || old_row.name, active = false
       where id = old_row.id;

      raise notice '合併「%」：% → %', grp.name, old_row.id, keep_id;
    end loop;
  end loop;

  raise notice '完成：處理 % 組同名房源，搬動 % 筆訂單與評價', groups, total;
end $$;


-- ============================================================
-- 驗證
-- ============================================================

-- 1) 還有沒有同名的房源？
--    剩下的都是「無法自動判斷」的，要人工決定：
--    看兩筆的 airbnb_listing_id 與訂單的 property_raw，
--    確認是同一個房間還是剛好同名的兩間。
select p.name, count(*) as 筆數,
       count(*) filter (where p.active) as 使用中,
       string_agg(p.id::text || '(' || coalesce(p.airbnb_listing_id, '無 listing') || ')', E'\n') as 明細
from properties p
where p.name not like '舊-%'
group by p.name having count(*) > 1
order by p.name;

-- 2) 被改名的舊房源，底下應該全空
select p.name, p.id, p.airbnb_listing_id,
       (select count(*) from orders o where o.property_id = p.id)           as 訂單,
       (select count(*) from reviews r where r.property_id = p.id)          as 評價,
       (select count(*) from cleaning_records c where c.property_id = p.id) as 清潔
from properties p
where p.name like '舊-%'
order by p.name;

-- 3) B6 的結果（合併前 27+1 訂單、1+4 評價）
select p.id, p.name, p.active, p.airbnb_listing_id, p.name_aliases,
       (select count(*) from orders o where o.property_id = p.id)           as 訂單,
       (select count(*) from reviews r where r.property_id = p.id)          as 評價,
       (select count(*) from cleaning_records c where c.property_id = p.id) as 清潔
from properties p
where p.name like '%B6%'
order by p.name;

-- 4) 有沒有訂單掛在停用的房源上（不該有）
select p.name, count(*) as 訂單數
from orders o join properties p on p.id = o.property_id
where not p.active
group by p.name order by 2 desc;
