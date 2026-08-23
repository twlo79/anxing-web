-- migration_138：認列真正脫離訂單（order_id 可為 null、加 contract_id）
--
-- ============================================================
-- 【137 沒有做到它自己宣稱的事】
--
-- 137 的標題是「認列改由契約推導」，但實作上留了一句:
--
--     -- 沒有任何訂單涵蓋這個月就跳過。認列不能沒有 order_id（外鍵）
--     if oid is not null then ... end if;
--
-- 也就是**認列仍然被訂單綁著**。訂單少開一期，認列就少一列。
--
-- 對帳跑出來的證據（2026-08-16）:
--
--     宸曲(限)    租期 2025-09-20 ~ 2026-09-19
--                 認列應為 18,900，實際 17,902，差 −998
--
-- 少的正好是 2026-09 那個零頭月。而那個月沒有訂單 ——
-- 辦公室登記走 `LTC_` 由前端產生，用的是日曆月，最後一期沒開。
--
-- 十七份契約全是同一個症狀。
--
--
-- ============================================================
-- 【真正分開要做兩件事】
--
--   1. `order_id` 改成可為 null   —— 沒有對應訂單也認得了
--   2. 加 `contract_id`           —— 認列自己知道屬於哪份契約，
--                                     不用繞 order_id → orders.contract_id
--
-- 之後:
--
--     應繳（orders）              契約週期 ＋ 繳法
--     認列（revenue_recognitions）契約租期 ＋ 日曆月
--
-- 兩張表各自完整。訂單開錯、少開、多開，認列都不受影響 ——
-- 而**兩者的差額本身就是有用的資訊**（7B1 的 $70,558 就是這樣抓到的）。
--
--
-- ============================================================
-- 【為什麼不乾脆把訂單也修好就好】
--
-- 因為那是兩個問題。`LTC_` 的訂單少開一期要改前端的產生器,
-- 而那要先決定辦公室登記的期間怎麼算（另一個決定）。
--
-- 認列不該等那個決定。**它現在就可以是對的。**

alter table public.revenue_recognitions
  alter column order_id drop not null;

alter table public.revenue_recognitions
  add column if not exists contract_id uuid references public.contracts(id) on delete cascade;

create index if not exists idx_recog_contract
  on public.revenue_recognitions (contract_id);

comment on column public.revenue_recognitions.order_id is
  '對應的訂單。**可為 null**（migration_138）—— 認列是契約層級的，'
  '那個月沒有訂單（少開、或繳法讓它落在別張上）也照認。'
  '掛哪一張只影響回查,不影響金額。';
comment on column public.revenue_recognitions.contract_id is
  '長租認列所屬的契約（migration_138）。短租與一次性收入是 null。'
  '有這一欄之後,認列不用繞 order_id 就知道自己屬於誰 —— '
  '訂單被刪或改掛別份契約時,認列不會跟著飄走。';


/*
 * 回填既有的長租認列。
 * 走 order_id → orders.contract_id，那是 138 之前唯一的關聯路徑。
 */
update public.revenue_recognitions r
   set contract_id = o.contract_id
  from public.orders o
 where o.id = r.order_id and o.contract_id is not null
   and r.contract_id is null;


create or replace function public.gen_contract_recognitions(ct contracts)
returns void language plpgsql security definer as $fn$
declare
  ms date; me date; lease_end date;
  n int; dim int; amt numeric;
  total numeric := 0; acc numeric := 0;
  last_ms date := null;
  ename text; pname text; pid uuid;
  oid uuid;
begin
  if ct.start_date is null or ct.end_date is null
     or ct.monthly_rent is null or ct.monthly_rent <= 0 then return; end if;

  lease_end := (ct.end_date + 1)::date;
  select e.name into ename from estates e where e.id = ct.estate_id;

  /*
   * 清掉這份契約的既有認列。
   *
   * **用 contract_id 清，不再走 order_id**（migration_138）——
   * 走訂單的話,那些 order_id 是 null 的列永遠清不掉,
   * 每跑一次就多一份,而畫面上看起來只是「這個月的收入變兩倍」。
   */
  delete from revenue_recognitions where contract_id = ct.id;

  if not ct.active then return; end if;

  -- ── 第一趟：總額與最後一個月 ──
  ms := date_trunc('month', ct.start_date)::date;
  while ms < lease_end loop
    me := (ms + interval '1 month')::date;
    n  := least(me, lease_end) - greatest(ms, ct.start_date);
    if n > 0 then
      dim     := me - ms;
      total   := total + ct.monthly_rent::numeric * n / dim;
      last_ms := ms;
    end if;
    ms := me;
  end loop;
  total := round(total);

  -- ── 第二趟：寫入。**每一個月都寫，有沒有訂單都寫** ──
  ms := date_trunc('month', ct.start_date)::date;
  while ms < lease_end loop
    me := (ms + interval '1 month')::date;
    n  := least(me, lease_end) - greatest(ms, ct.start_date);
    if n > 0 then
      dim := me - ms;
      if ms = last_ms then amt := total - acc;
      else amt := trunc(ct.monthly_rent::numeric * n / dim); acc := acc + amt; end if;

      -- 挑重疊最多的訂單來掛。**找不到就掛 null,那一列照樣存在**
      select o.id, o.property_id into oid, pid
        from orders o
       where o.contract_id = ct.id and o.imported_via = 'contract'
         and o.checkin < me and o.checkout > ms
       order by (least(o.checkout, me) - greatest(o.checkin, ms)) desc, o.checkin
       limit 1;

      select p.name into pname from properties p where p.id = pid;
      pname := coalesce(pname, ct.room);

      insert into revenue_recognitions(
        order_id, contract_id, ym, period_start, period_end, source,
        estate_id, property_id, estate_name, property_raw, guest_name,
        checkin, checkout, total_amount, total_nights, month_nights, month_amount, fee_type)
      values (
        oid, ct.id, to_char(ms, 'YYYYMM'),
        greatest(ms, ct.start_date), least(me, lease_end), 'longterm',
        ct.estate_id, pid, ename, pname, ct.tenant_name,
        ct.start_date, lease_end,
        ct.monthly_rent, dim, n, amt, null);
    end if;
    ms := me;
  end loop;
end $fn$;

comment on function public.gen_contract_recognitions(contracts) is
  '長租認列。**只看契約 —— 訂單有沒有開、開幾張、怎麼繳都不影響**（migration_138）。'
  '認列(某月) = 月租 × 該月落在租期內的天數 ÷ 該月天數。'
  '中間月份 n = dim 必定整額,首尾零頭相加剛好一個月。'
  'order_id 找不到就是 null —— 那一列照樣存在,因為錢確實該認。'
  '清理用 contract_id,不能用 order_id（null 的清不掉,會越跑越多）。';


-- ── 全量重算 ───────────────────────────────────────
do $$
declare ct public.contracts;
begin
  for ct in select * from public.contracts loop
    perform public.gen_contract_recognitions(ct);
  end loop;
end $$;


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('138_recognition_independent');
  end if;
end $$;


-- ============================================================
-- 驗證
-- ============================================================
do $$
declare n int; m numeric;
begin
  drop table if exists _chk138;
  create temp table _chk138 (ord int, item text, result text, detail text);

  insert into _chk138 values (1, 'order_id 可為 null',
    case when (select is_nullable from information_schema.columns
                where table_schema='public' and table_name='revenue_recognitions'
                  and column_name='order_id') = 'YES' then '✅' else '❌' end, '');

  insert into _chk138 values (1, 'contract_id 欄位',
    case when exists (select 1 from information_schema.columns
                       where table_schema='public' and table_name='revenue_recognitions'
                         and column_name='contract_id') then '✅' else '❌' end, '');

  /*
   * 【最重要的一條】認列合計 = 用同一個公式算出來的應為。
   *
   * 用真算法對比，不用「月租 × 月數」—— 那個公式假設租期落在整數個月上，
   * 我已經在 136、137 各錯過一次。
   */
  with c as (
    select id, monthly_rent, start_date, (end_date + 1)::date as lease_end
      from public.contracts
     where active and start_date is not null and end_date is not null
       and monthly_rent is not null and monthly_rent > 0
  ), want as (
    select c.id, round(sum(
             c.monthly_rent::numeric
             * (least((gs + interval '1 month')::date, c.lease_end)
                - greatest(gs::date, c.start_date))
             / ((gs + interval '1 month')::date - gs::date))) as w
      from c, generate_series(date_trunc('month', c.start_date), c.lease_end, '1 month') gs
     where gs::date < c.lease_end
       and least((gs + interval '1 month')::date, c.lease_end) > greatest(gs::date, c.start_date)
     group by c.id
  ), got as (
    select contract_id, sum(month_amount) s
      from public.revenue_recognitions where contract_id is not null group by 1
  )
  select count(*) into n from want
    left join got on got.contract_id = want.id
   where abs(coalesce(got.s, 0) - want.w) > 1;
  insert into _chk138 values (2, '★★ 認列合計對不上的',
    case when n = 0 then '✅ 全部對上' else '❌ ' || n || ' 份' end,
    '用真算法比（Σ 月租 × n/dim），不是「月租 × 月數」');

  select count(*) into n from (
    select contract_id, ym from public.revenue_recognitions
     where contract_id is not null group by 1,2 having count(*) > 1) t;
  insert into _chk138 values (2, '★★ 同契約同月多列的',
    case when n = 0 then '✅ 0 個' else '❌ ' || n || ' 個' end, '一份契約一個月只能有一列');

  select count(*) into n from public.revenue_recognitions
   where contract_id is not null and order_id is null;
  insert into _chk138 values (3, '★ 沒有對應訂單的認列', n || ' 列',
    case when n = 0 then '每個月都有訂單涵蓋'
         else '**這些月份的錢該認但沒開單** —— 幾乎都是辦公室登記(LTC_)少開最後一期' end);

  insert into _chk138
  select 4, '　' || coalesce(r.property_raw, r.guest_name, '?') || ' ' || r.ym,
         '$' || to_char(r.month_amount, 'FM999,999,999'),
         r.month_nights || '/' || r.total_nights || '　該月有認列但沒有月租單'
    from public.revenue_recognitions r
   where r.contract_id is not null and r.order_id is null
   order by r.ym limit 30;

  /*
   * 應繳 vs 認列的差額。**這一條不是錯誤，是報表。**
   * 差額本身就是資訊:7B1 多開一張 $70,558 就是這樣抓到的。
   */
  select count(*) into n from (
    select c.id from public.contracts c
      left join (select contract_id, sum(amount) s from public.orders
                  where imported_via='contract' group by 1) o on o.contract_id = c.id
      left join (select contract_id, sum(month_amount) s from public.revenue_recognitions
                  where contract_id is not null group by 1) r on r.contract_id = c.id
     where c.active and abs(coalesce(o.s,0) - coalesce(r.s,0)) > 1) t;
  insert into _chk138 values (8, '★ 應繳與認列不一致的', n || ' 份',
    '**不是錯誤** —— 差額代表訂單多開／少開,是要人看的清單。查 查-契約月租單對帳.sql');
end $$;

select item as "檢查項目", result as "結果", detail as "說明"
from _chk138 order by ord, item;
