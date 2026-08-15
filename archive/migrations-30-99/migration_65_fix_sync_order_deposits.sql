-- migration_65：修正 sync_order_deposits 的陣列串接
--
-- 症狀：短租訂單只要押金填大於 0 就存不進去，錯誤是
--   malformed array literal: "TWD"
--   QUERY: keep := keep || 'TWD'
--
-- 原因（migration_56 埋的）：
--   keep 是 text[]，而 `陣列 || 未定型的字串字面值` 在 Postgres 裡
--   會被解析成「陣列 || 陣列」—— 它試圖把 'TWD' 當成陣列字面值來解析。
--
--   下一行的 `keep := keep || c` 沒問題，因為 c 宣告成 text，型別是明確的。
--   只有字面值那一行會炸。這也是為什麼押金 0 的訂單一直沒事：
--   那個分支根本不會執行。
--
-- 修法：改用 array_append，意圖明確且不依賴型別推導。
--
-- 影響：這支函式從 migration_56 上線後就壞著，期間所有「短租訂單填押金」
--       的操作都失敗。押金為 0 的訂單不受影響。

create or replace function public.sync_order_deposits() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  l jsonb;
  keep text[] := '{}';
  c text;
  a numeric;
begin
  -- 台幣押金
  if coalesce(new.deposit, 0) > 0 then
    keep := array_append(keep, 'TWD');
    insert into deposits (order_id, currency, amount, estate_id, property_id, room, guest_name)
    values (new.id, 'TWD', new.deposit, new.estate_id, new.property_id, new.property_raw, new.guest_name)
    on conflict (order_id, currency) where order_id is not null
    do update set amount = excluded.amount, estate_id = excluded.estate_id,
                  property_id = excluded.property_id, room = excluded.room,
                  guest_name = excluded.guest_name, orphaned = false;
  end if;

  -- 外幣押金（fx_deposit: [{"cur":"USD","amt":300}, ...]）
  for l in select * from jsonb_array_elements(coalesce(new.fx_deposit, '[]'::jsonb)) loop
    c := nullif(l->>'cur', '');
    a := coalesce((l->>'amt')::numeric, 0);
    if c is not null and a > 0 then
      keep := array_append(keep, c);
      insert into deposits (order_id, currency, amount, estate_id, property_id, room, guest_name)
      values (new.id, c, a, new.estate_id, new.property_id, new.property_raw, new.guest_name)
      on conflict (order_id, currency) where order_id is not null
      do update set amount = excluded.amount, estate_id = excluded.estate_id,
                    property_id = excluded.property_id, room = excluded.room,
                    guest_name = excluded.guest_name, orphaned = false;
    end if;
  end loop;

  -- 金額被改成 0 或幣別被移除。還沒收錢的直接清掉；
  -- 已經收了的留著標記 orphaned —— 錢在我們手上，紀錄不能無聲消失。
  delete from deposits
   where order_id = new.id and not (currency = any(keep)) and received_on is null;
  update deposits set orphaned = true
   where order_id = new.id and not (currency = any(keep)) and received_on is not null;

  return new;
end $$;


-- ============================================================
-- 驗證
-- ============================================================

-- 直接試一筆。成功的話 deposits 會多一列。
update public.orders set deposit = 20000
 where order_key = 'PV_2026-06-26_A8_dd8154';

select o.order_key, o.guest_name, o.property_raw, o.deposit,
       d.id as 押金列, d.amount, d.currency, d.received_on, d.orphaned
from public.orders o
left join public.deposits d on d.order_id = o.id
where o.guest_name ilike '%馬森%'
order by o.checkin desc;

-- 順帶確認：改回 0 之後那列會被清掉（因為還沒收款）
-- update public.orders set deposit = 0 where order_key = 'PV_2026-06-26_A8_dd8154';
