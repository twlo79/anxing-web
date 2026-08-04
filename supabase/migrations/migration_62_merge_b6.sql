-- migration_62：合併 B6 的新舊 listing
--
-- 症狀：properties 裡有兩筆都叫 B6，看起來像改名改錯了。
--
-- 查證結果：兩筆都是 B6，不是重複建檔。同一個房間先後有兩個 Airbnb listing：
--
--   9582acc0…  舊 listing 1394094851635909156（標題寫 B6）  已停用  1 訂單 / 4 評價
--   b48e159f…  現行 listing 1690594271053849788（標題無房號）使用中  27 訂單 / 1 評價 / 4 清潔
--
-- 現行那筆的 listing 標題沒有房號，所以無法從標題判斷。用日曆回推確認：
-- 它唯一那則評價（Morgane，2025-10-31 退房）對得到一筆 property_raw='B6'、
-- 房客同名的訂單 —— 確定是 B6。
--
-- 問題在報表被切成兩半：B6 的評價 4 則在停用那筆、1 則在使用中那筆，
-- 評價統計只會算到其中一邊。
--
-- 【為什麼不直接刪掉舊那筆】
-- airbnb_listing_id 是 UNIQUE，舊的 listing id 搬不到現行那筆上。
-- 刪掉之後萬一 Airbnb 用舊 listing 再匯入一次，匯入端會自動長出一筆新房源，
-- 資料又被切開一次。所以舊那筆保留、改成明確的名字、維持停用，純粹佔著那個 id。

do $$
declare
  keep_id uuid := 'b48e159f-b88f-4f28-8562-13c84e0798cd';  -- 現行
  old_id  uuid := '9582acc0-3e4e-4869-8c36-629503d33c48';  -- 舊 listing
  old_title text;
begin
  -- 防呆：兩筆都必須存在，否則直接中止，不要做半套
  if not exists (select 1 from properties where id = keep_id)
     or not exists (select 1 from properties where id = old_id) then
    raise exception '找不到其中一筆房源，中止。請先確認 id 是否正確。';
  end if;

  select name_aliases[1] into old_title from properties where id = old_id;

  -- ── 搬資料 ──────────────────────────────────────────────
  -- 注意：更新 orders.property_id 會觸發 trg_sync_order_deposits
  -- （那支觸發器監聽 property_id），押金列會跟著改歸屬，這是對的。
  -- 也會觸發 orders_recognize 重算該筆的營收認列。
  update orders  set property_id = keep_id where property_id = old_id;
  update reviews set property_id = keep_id where property_id = old_id;
  -- 其餘幾張表在預覽時都是 0 筆，仍然照搬以防之後有人補資料進去
  update cleaning_records       set property_id = keep_id where property_id = old_id;
  update expenses               set property_id = keep_id where property_id = old_id;
  update deposits               set property_id = keep_id where property_id = old_id;
  update purchase_request_items set property_id = keep_id where property_id = old_id;
  -- staff_properties 是複合主鍵，直接改可能撞主鍵，先刪掉重複的再改
  delete from staff_properties sp
   where sp.property_id = old_id
     and exists (select 1 from staff_properties x
                  where x.staff_id = sp.staff_id and x.property_id = keep_id);
  update staff_properties set property_id = keep_id where property_id = old_id;

  -- ── 把舊標題加進現行房源的別名 ──────────────────────────
  -- 匯入端的房源比對會查別名。不加的話，之後若有用舊標題的資料進來，
  -- 又會對不到而變成「未識別房源」。
  if old_title is not null then
    update properties
       set name_aliases = array(select distinct unnest(name_aliases || old_title))
     where id = keep_id;
  end if;

  -- ── 舊那筆改成明確的名字 ────────────────────────────────
  -- 不刪除，理由見檔頭。改名是為了下次有人看到不會再以為是重複建檔。
  update properties
     set name = '舊-B6',
         active = false
   where id = old_id;
end $$;


-- ============================================================
-- 驗證
-- ============================================================

-- 舊那筆底下應該全部清空
select 'orders' as 表, count(*) as 殘留 from orders where property_id = '9582acc0-3e4e-4869-8c36-629503d33c48'
union all select 'reviews', count(*) from reviews where property_id = '9582acc0-3e4e-4869-8c36-629503d33c48'
union all select 'cleaning_records', count(*) from cleaning_records where property_id = '9582acc0-3e4e-4869-8c36-629503d33c48'
union all select 'expenses', count(*) from expenses where property_id = '9582acc0-3e4e-4869-8c36-629503d33c48'
union all select 'deposits', count(*) from deposits where property_id = '9582acc0-3e4e-4869-8c36-629503d33c48';

-- 現行那筆現在應該有 28 訂單 / 5 評價 / 4 清潔
select p.id, p.name, p.active, p.airbnb_listing_id, p.name_aliases,
       (select count(*) from orders o where o.property_id = p.id)           as 訂單,
       (select count(*) from reviews r where r.property_id = p.id)          as 評價,
       (select count(*) from cleaning_records c where c.property_id = p.id) as 清潔
from properties p
where p.id in ('b48e159f-b88f-4f28-8562-13c84e0798cd',
               '9582acc0-3e4e-4869-8c36-629503d33c48');

-- 現在只該有一筆叫 B6，另一筆是「舊-B6」且已停用
select id, name, active from properties where name like '%B6%' order by name;

-- 順帶檢查：還有沒有其他同名的房源（同樣的合併問題）
select name, count(*) as 筆數, string_agg(id::text, ' | ') as ids
from properties
group by name having count(*) > 1
order by name;
