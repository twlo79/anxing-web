-- migration_112：清掉重複匯入的訂單（29 組、多算約 78 萬營收）
--
-- ============================================================
-- 【怎麼會有重複】
--
-- 同一批 Airbnb 訂單被匯入兩次，用了兩種不同的 order_key：
--
--   舊匯入：AB_<日期>_<房源>_<雜湊>  /  PV_…  /  OO_…
--   爬蟲：  HM<Airbnb 確認碼>
--
-- 而且舊的 key 產生器不穩定 —— 跨年那幾天算錯年份：
--
--   AB_2025-12-31_亞曼尼_b94317
--   AB_2026-12-31_亞曼尼_6f28c7   ← 同一筆，入住日都是 2025-12-31
--
-- 所以同一筆訂單在兩次匯入產生了兩個不同的鍵，去重整個失效。
-- 姓名也對不上（一次存全名「Jung Yang」，一次存名字「Jung」），
-- 這正是「不能用姓名當識別」的實證。
--
--
-- ============================================================
-- 【為什麼走 soft_delete 而不是 delete】
--
-- 這支一次動 29 筆訂單、影響七十幾萬營收。判斷錯了要救得回來。
--
-- soft_delete 會把整列（含營收認列）搬進回收桶，原表真的 delete ——
-- 所以營收馬上正確，而且在「刪除紀錄」頁按一下就能復原。
--
--
-- ============================================================
-- 【保留哪一筆】
--
--   1. 其中一筆是 HM（Airbnb 確認碼）→ 保留它。確認碼是 Airbnb 給的，
--      延住、改名、換房都不會變，之後同步也認得它。
--   2. 兩筆都不是 HM → 保留姓名比較完整的那筆（資訊比較多）。
--
-- 兩筆都是 HM 的話會被擋下來列出來 —— 那代表 Airbnb 真的有兩筆訂單，
-- 不該由程式決定刪哪一個。
-- ============================================================

do $$
declare
  v_admin  uuid;
  v_row    record;
  v_res    jsonb;
  v_done   int := 0;
  v_fail   int := 0;
  v_skip   int := 0;
begin
  drop table if exists _chk112;
  create temp table _chk112 (ord int, item text, result text, detail text);

  -- soft_delete 的權限看 current_role_of()，而它看 auth.uid()。
  -- SQL Editor 裡 auth.uid() 是 null，不假裝成某個人的話每一筆都會回 NO_PERM。
  select id into v_admin from public.profiles where role = 'super_admin' limit 1;
  if v_admin is null then
    insert into _chk112 values (0, '前置', '❌ 找不到 super_admin', '無法執行');
    return;
  end if;
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_admin::text)::text, true);

  -- ── 找出重複組，並決定保留哪一筆 ──────────────────
  drop table if exists _dup112;
  create temp table _dup112 as
  select
    o1.id as id_a, o2.id as id_b,
    o1.order_key as key_a, o2.order_key as key_b,
    o1.property_raw as room, o1.checkin, o1.checkout, o1.amount,
    o1.guest_name as name_a, o2.guest_name as name_b,
    case
      when o1.order_key like 'HM%' and o2.order_key like 'HM%' then null   -- 兩筆都是確認碼 → 不敢動
      when o1.order_key like 'HM%' then o2.id
      when o2.order_key like 'HM%' then o1.id
      when length(coalesce(o1.guest_name, '')) >= length(coalesce(o2.guest_name, '')) then o2.id
      else o1.id
    end as del_id
  from public.orders o1
  join public.orders o2
    on o1.id < o2.id
   and o1.property_raw = o2.property_raw
   and o1.checkin = o2.checkin
   and o1.checkout = o2.checkout
   and o1.amount = o2.amount
  where coalesce(o1.amount, 0) > 0
    and coalesce(o1.property_raw, '') <> ''
    and o1.order_key not like 'LTC%' and o2.order_key not like 'LTC%'
    and o1.order_key not like 'CRC%' and o2.order_key not like 'CRC%';

  insert into _chk112
  select 1, '找到重複組', count(*) || ' 組', '' from _dup112;

  /*
   * 【有收款或發票就整支中止】
   *
   * 你在 SQL Editor 看到的是當下的快照。真正執行時可能已經有人補了收款 ——
   * 那時直接刪會把錢的紀錄一起帶走，而那是不可接受的。
   * 所以執行前再檢查一次，有就全部不動。
   */
  if exists (
    select 1 from _dup112 d
     where exists (select 1 from public.order_payments p
                    where p.order_id in (d.id_a, d.id_b))
        or exists (select 1 from public.invoices i
                    where i.order_id in (d.id_a, d.id_b))
  ) then
    insert into _chk112
    select 2, '★ 有收款或發票掛在重複組上', '❌ 全部中止',
      string_agg(d.key_a || ' / ' || d.key_b, '、')
    from _dup112 d
    where exists (select 1 from public.order_payments p where p.order_id in (d.id_a, d.id_b))
       or exists (select 1 from public.invoices i where i.order_id in (d.id_a, d.id_b));
    return;
  end if;
  insert into _chk112 values (2, '沒有收款或發票掛在上面', '✅', '可以安全刪除');

  -- 兩筆都是確認碼 → 交人工
  insert into _chk112
  select 3, '★ 兩筆都是 Airbnb 確認碼', '⚠ 跳過 ' || count(*) || ' 組',
    string_agg(key_a || ' / ' || key_b, '、')
  from _dup112 where del_id is null
  having count(*) > 0;

  -- ── 先記下營收影響（刪掉之後就查不到了）──────────
  drop table if exists _rev112;
  create temp table _rev112 as
  select r.ym, sum(r.month_amount)::numeric as amt
  from public.revenue_recognitions r
  where r.order_id in (select del_id from _dup112 where del_id is not null)
  group by r.ym;

  -- ── 逐筆搬進回收桶 ──────────────────────────────
  for v_row in select del_id, key_a, key_b, room, checkin
                 from _dup112 where del_id is not null
  loop
    -- 同一列可能出現在兩組裡（三筆重複）。已經刪掉的就跳過,
    -- 否則第二次會回 NOT_FOUND 被算成失敗。
    if not exists (select 1 from public.orders where id = v_row.del_id) then
      v_skip := v_skip + 1;
      continue;
    end if;

    v_res := public.soft_delete('orders', v_row.del_id,
      format('重複匯入（%s / %s，%s %s）', v_row.key_a, v_row.key_b, v_row.room, v_row.checkin));

    if (v_res->>'ok')::boolean then
      v_done := v_done + 1;
    else
      v_fail := v_fail + 1;
      insert into _chk112 values (5, '❌ 刪除失敗', v_row.key_a || ' / ' || v_row.key_b,
        v_res->>'message');
    end if;
  end loop;

  insert into _chk112 values (4, '已移到回收桶',
    case when v_fail = 0 then '✅ ' || v_done || ' 筆' else '⚠ ' || v_done || ' 筆' end,
    case when v_skip > 0 then v_skip || ' 筆先前已刪除,跳過' else '可到「設定 → 紀錄」復原' end);

  /*
   * 每個月的營收會少多少。
   *
   * 用 revenue_recognitions 的 month_amount，不是訂單金額 ——
   * 一筆跨月的訂單會攤到好幾個月，直接看訂單金額對不上報表。
   * 這份清單就是「報表數字為什麼變了」的答案，先印出來，
   * 不然刪完之後你只會看到數字莫名其妙變小。
   */
  insert into _chk112
  select 7, '　' || ym || ' 營收減少', to_char(amt, 'FM999,999,999'), ''
  from _rev112 order by ym;

  insert into _chk112
  select 7, '營收減少合計', to_char(coalesce(sum(amt), 0), 'FM999,999,999'),
    count(*) || ' 個月份受影響'
  from _rev112;

  -- ── 確認沒有殘留 ────────────────────────────────
  insert into _chk112
  select 6, '★ 還有沒有重複',
    case when count(*) = 0 then '✅ 沒有了' else '⚠ 還有 ' || count(*) || ' 組' end,
    coalesce(string_agg(key_a || ' / ' || key_b, '、'), '')
  from (
    select o1.order_key as key_a, o2.order_key as key_b
    from public.orders o1
    join public.orders o2
      on o1.id < o2.id and o1.property_raw = o2.property_raw
     and o1.checkin = o2.checkin and o1.checkout = o2.checkout
     and o1.amount = o2.amount
    where coalesce(o1.amount, 0) > 0 and coalesce(o1.property_raw, '') <> ''
      and o1.order_key not like 'LTC%' and o2.order_key not like 'LTC%'
      and o1.order_key not like 'CRC%' and o2.order_key not like 'CRC%'
  ) s;
end $$;


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('112_dedupe_orders');
  end if;
end $$;


-- ============================================================
-- 結果
-- ============================================================
select item as "項目", result as "結果", detail as "說明"
from _chk112 order by ord, item;
