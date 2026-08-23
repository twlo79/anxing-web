-- migration_137：長租認列改由「契約」推導，不再跟著訂單走
--
-- ============================================================
-- 【付租金與認列是兩件事】（2026-08-16 使用者指定）
--
-- 現在 gen_recognitions 是**逐張訂單**拆的:訂單怎麼切，認列就怎麼跟著切。
-- 結果是**繳法會改變認列**，而那在會計上是錯的:
--
--     月繳  12 張訂單，每張跨兩個日曆月 → 每個月出現**兩列**
--     年繳  1 張訂單繳清   → 按晚數拆   → 每列的單價是 總額 ÷ 總天數
--     季繳  4 張訂單       → 又是另一種切法
--
-- 同一份契約、同樣的租金，只因為租客選了不同繳法，
-- 損益表上每個月的數字就不一樣。
--
--
-- ============================================================
-- 【中間月份加起來還會多錢】
--
-- 8A2 周雅婷（月租 146,370，租期 2025-11-26 ~ 2026-11-25）現在的 7 月:
--
--     訂單 202606（06-26~07-26）的 7 月部分   25/30 → $121,975
--     訂單 202607（07-26~08-26）的 7 月部分    6/31 → $ 28,329
--     ─────────────────────────────────────────────────
--                                                     $150,304
--
-- 而 7 月應該就是 $146,370。多出 $3,935 ——
-- 因為 `25/30 + 6/31 ≠ 1`:兩張單的每晚單價不一樣
-- （一張除以 30 天、一張除以 31 天）。
--
-- 這種錯不會有任何徵兆:每一列自己看都合理，只有加起來才不對，
-- 而沒有人會去加。
--
--
-- ============================================================
-- 【新規則：只看契約】
--
--   認列(某月) = 月租 × (該月落在租期內的天數 ÷ 該月的天數)
--
--     首月   2025-11    5/30  → $ 24,395
--     中間   2025-12 ~ 2026-10  整月 → $146,370   ← 分子分母相同,必定整額
--     末月   2026-11   25/30  → $121,975
--
-- 首尾相加 = $146,370 = 剛好一個月。合計 = 12 × 月租。
--
-- **中間月份必定是整額**,因為 n = dim。這是規則本身保證的，
-- 不是算出來剛好 —— 也就是說它不會因為 30/31 天的差異而漂移。
--
--
-- ============================================================
-- 【短租不動】
--
-- 短租照晚數拆是**對的** —— 一筆五晚的訂單跨月，本來就該按晚數分。
-- 那裡沒有「月租」這個概念，也沒有繳法的問題。
--
-- 所以這支只接管 `source = 'longterm'` 且 `contract_id` 有值的訂單。
--
--
-- ============================================================
-- 【order_id 怎麼掛】
--
-- `revenue_recognitions.order_id` 是 not null 且有外鍵。
-- 契約推導出來的認列要掛在某一張訂單上 ——
-- 選**涵蓋該月天數最多**的那一張（年繳就是同一張掛 12 次）。
--
-- 掛哪一張只影響「從認列點回訂單」，不影響金額。
--
--
-- ============================================================
-- 【欄位語意跟著改】
--
--     total_amount  = 月租（不是訂單金額）
--     total_nights  = 該日曆月的天數
--     month_nights  = 該月落在租期內的天數
--
-- 於是畫面上讀起來是「這個月認列了 5/30 個月的租金」——
-- 中間月份 31/31、金額相同,營收頁的第二行就不會印（見 lib/revenue-row），
-- 一個月剛好一列乾淨的數字。

create or replace function public.gen_contract_recognitions(ct contracts)
returns void language plpgsql security definer as $fn$
declare
  ms date; me date; lease_end date;
  n int; dim int; amt numeric;
  total numeric := 0; acc numeric := 0;
  last_ms date := null;
  ename text; pname text;
  oid uuid;
begin
  if ct.start_date is null or ct.end_date is null
     or ct.monthly_rent is null or ct.monthly_rent <= 0 then return; end if;

  lease_end := (ct.end_date + 1)::date;   -- end_date 含當日

  select e.name into ename from estates e where e.id = ct.estate_id;

  /*
   * 先清掉這份契約底下所有訂單的既有認列。
   *
   * 【為什麼整份清掉而不是逐張訂單】
   * 新的認列是**契約層級**的 —— 一列可能對應到別張訂單。
   * 逐張清的話會留下對不上的殘留,而那些殘留在營收表上
   * 看起來就是正常的一列,沒有人查得出來。
   */
  delete from revenue_recognitions r
   where r.order_id in (
     select o.id from orders o
      where o.contract_id = ct.id and o.imported_via = 'contract'
   );

  if not ct.active then return; end if;

  -- ── 第一趟：總額與最後一個月 ──
  ms := date_trunc('month', ct.start_date)::date;
  while ms < lease_end loop
    me  := (ms + interval '1 month')::date;
    n   := least(me, lease_end) - greatest(ms, ct.start_date);
    if n > 0 then
      dim     := me - ms;
      total   := total + ct.monthly_rent::numeric * n / dim;
      last_ms := ms;
    end if;
    ms := me;
  end loop;
  total := round(total);

  -- ── 第二趟：寫入 ──
  ms := date_trunc('month', ct.start_date)::date;
  while ms < lease_end loop
    me := (ms + interval '1 month')::date;
    n  := least(me, lease_end) - greatest(ms, ct.start_date);
    if n > 0 then
      dim := me - ms;
      if ms = last_ms then
        amt := total - acc;                                    -- 餘數全給最後一期
      else
        amt := trunc(ct.monthly_rent::numeric * n / dim);
        acc := acc + amt;
      end if;

      /*
       * 挑一張訂單來掛。取**跟這個月重疊天數最多**的那一張 ——
       * 年繳只有一張，12 個月都掛它;月繳就會各掛各的。
       */
      select o.id into oid
        from orders o
       where o.contract_id = ct.id and o.imported_via = 'contract'
         and o.checkin < me and o.checkout > ms
       order by (least(o.checkout, me) - greatest(o.checkin, ms)) desc, o.checkin
       limit 1;

      -- 沒有任何訂單涵蓋這個月就跳過。認列不能沒有 order_id（外鍵），
      -- 而硬掛一張不相干的訂單比少一列更難查
      if oid is not null then
        select p.name into pname from properties p
         where p.id = (select o.property_id from orders o where o.id = oid);
        pname := coalesce(pname, ct.room);

        insert into revenue_recognitions(
          order_id, ym, period_start, period_end, source,
          estate_id, property_id, estate_name, property_raw, guest_name,
          checkin, checkout, total_amount, total_nights, month_nights, month_amount, fee_type)
        values (
          oid, to_char(ms, 'YYYYMM'),
          greatest(ms, ct.start_date), least(me, lease_end), 'longterm',
          ct.estate_id,
          (select o.property_id from orders o where o.id = oid),
          ename, pname, ct.tenant_name,
          ct.start_date, lease_end,
          ct.monthly_rent,        -- total_amount = 月租,不是訂單金額
          dim,                    -- total_nights = 該日曆月天數
          n,                      -- month_nights = 落在租期內的天數
          amt, null);
      end if;
    end if;
    ms := me;
  end loop;
end $fn$;

comment on function public.gen_contract_recognitions(contracts) is
  '長租認列。**只看契約，不看訂單怎麼開、怎麼繳**（migration_137）—— '
  '認列(某月) = 月租 × 該月落在租期內的天數 ÷ 該月天數。'
  '中間月份 n = dim 必定整額,首尾才是零頭,兩者相加剛好一個月。'
  '欄位語意:total_amount = 月租、total_nights = 該月天數、month_nights = 租期內天數。'
  'order_id 掛重疊最多的那張訂單（年繳就是同一張掛 12 次）—— 只影響回查,不影響金額。';


/*
 * gen_recognitions 讓開:長租且有契約的訂單交給上面那支。
 *
 * **不刪掉原本的邏輯** —— 沒有 contract_id 的長租訂單（手動建的）
 * 還是走原本那條。一次改兩件事，出問題時分不出是哪一件。
 */
create or replace function public.gen_recognitions(o orders)
returns void language plpgsql security definer as $fn$
declare
  ms date; me date; n int; ename text; pname text;
  last_ms date; acc numeric := 0; amt numeric;
begin
  -- 長租且掛在契約上的:認列由 gen_contract_recognitions 依契約產生
  if o.source = 'longterm' and o.contract_id is not null then return; end if;

  select e.name into ename from estates e where e.id = o.estate_id;
  select p.name into pname from properties p where p.id = o.property_id;
  pname := coalesce(pname, o.property_raw);

  if o.source in ('oneoff', 'airbnb_cancelled') then
    if o.checkin is null or o.amount is null then return; end if;
    ms := date_trunc('month', o.checkin)::date;
    insert into revenue_recognitions(order_id, ym, period_start, period_end, source, estate_id, property_id,
      estate_name, property_raw, guest_name, checkin, checkout, total_amount, total_nights, month_nights, month_amount, fee_type)
    values (o.id, to_char(o.checkin,'YYYYMM'), ms, (ms + interval '1 month')::date, 'oneoff', o.estate_id, o.property_id,
      ename, pname, o.guest_name, o.checkin, o.checkout, o.amount, coalesce(o.nights,0), 0, o.amount, coalesce(o.fee_type,'取消費'));
    return;
  end if;

  if o.checkin is null or o.checkout is null or o.nights is null or o.nights <= 0 then return; end if;
  last_ms := date_trunc('month', o.checkout - 1)::date;
  ms := date_trunc('month', o.checkin)::date;
  while ms < o.checkout loop
    me := (ms + interval '1 month')::date;
    n := greatest(0, least(o.checkout, me) - greatest(o.checkin, ms));
    if n > 0 then
      if ms = last_ms then amt := o.amount - acc;
      else amt := trunc(o.amount * n / o.nights); acc := acc + amt; end if;
      insert into revenue_recognitions(order_id, ym, period_start, period_end, source, estate_id, property_id,
        estate_name, property_raw, guest_name, checkin, checkout, total_amount, total_nights, month_nights, month_amount, fee_type)
      values (o.id, to_char(ms,'YYYYMM'), greatest(o.checkin, ms), least(o.checkout, me),
        case when o.source = 'partner' then 'airbnb' else o.source end,
        o.estate_id, o.property_id,
        ename, pname, o.guest_name, o.checkin, o.checkout, o.amount, o.nights, n, amt, null);
    end if;
    ms := me;
  end loop;
end $fn$;

comment on function public.gen_recognitions(orders) is
  '訂單 → 營收認列，照晚數拆。**長租且有 contract_id 的不走這裡** —— '
  '那些由 gen_contract_recognitions 依契約產生（migration_137）,'
  '因為繳法（月繳／季繳／年繳）不該改變認列。';


/*
 * 契約異動 → 重算認列。
 *
 * 掛在 contracts 上而不是 orders —— 認列現在是契約層級的東西。
 * 但月租單的異動也要重算（訂單被刪掉的話 order_id 會掛不上），
 * 所以 gen_contract_orders 跑完之後也呼叫一次。
 */
create or replace function public.trg_contracts_recog() returns trigger
language plpgsql security definer as $fn$
begin
  if tg_op = 'DELETE' then return old; end if;   -- 訂單被 cascade 刪掉時認列跟著走
  perform public.gen_contract_recognitions(new);
  return new;
end $fn$;

drop trigger if exists trg_contracts_recog on public.contracts;
create trigger trg_contracts_recog
  after insert or update on public.contracts
  for each row execute function public.trg_contracts_recog();


-- ── 全量重算 ───────────────────────────────────────
do $$
declare ct public.contracts; c int := 0;
begin
  for ct in select * from public.contracts loop
    perform public.gen_contract_recognitions(ct);
    c := c + 1;
  end loop;
  raise notice '重算 % 份契約', c;
end $$;


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('137_contract_recognitions');
  end if;
end $$;


-- ============================================================
-- 驗證
-- ============================================================
do $$
declare n int; m numeric;
begin
  drop table if exists _chk137;
  create temp table _chk137 (ord int, item text, result text, detail text);

  insert into _chk137 values (1, 'gen_contract_recognitions',
    case when to_regprocedure('public.gen_contract_recognitions(contracts)') is not null
         then '✅' else '❌' end, '長租認列改由契約推導');

  insert into _chk137 values (1, 'gen_recognitions 已讓開',
    case when pg_get_functiondef('public.gen_recognitions(orders)'::regprocedure)
              like '%contract_id is not null then return%' then '✅' else '❌' end,
    '長租且有契約的訂單不再走逐張拆');

  /*
   * 【最重要的一條】每份契約的認列合計 = 月租 × 月數。
   *
   * 這是新規則的數學保證（首尾相加剛好一個月），
   * 對不上就代表算法有洞。容許 1 元誤差（分攤捨去）。
   */
  select count(*) into n
    from public.contracts c
    join (select o.contract_id, sum(r.month_amount) s
            from public.revenue_recognitions r
            join public.orders o on o.id = r.order_id
           where o.imported_via = 'contract'
           group by o.contract_id) x on x.contract_id = c.id
   where c.active and c.start_date is not null and c.end_date is not null
     and c.monthly_rent is not null
     and abs(x.s - c.monthly_rent *
         ((extract(year from c.end_date)::int * 12 + extract(month from c.end_date)::int)
          - (extract(year from c.start_date)::int * 12 + extract(month from c.start_date)::int))) > 1;
  insert into _chk137 values (2, '★★ 認列合計對不上契約的',
    case when n = 0 then '✅ 全部對上' else '❌ ' || n || ' 份' end,
    '認列合計應該 = 月租 × 月數。首尾零頭相加剛好一個月,中間必定整額');

  /*
   * 【第二重要】同一份契約、同一個月**只能有一列**。
   * 現在的問題正是「一個月兩列」，這條盯住它不再發生。
   */
  select count(*) into n from (
    select o.contract_id, r.ym
      from public.revenue_recognitions r
      join public.orders o on o.id = r.order_id
     where o.imported_via = 'contract'
     group by o.contract_id, r.ym having count(*) > 1
  ) t;
  insert into _chk137 values (2, '★★ 同契約同月出現多列的',
    case when n = 0 then '✅ 0 個' else '❌ ' || n || ' 個' end,
    '一份契約一個月只能有一列 —— 這正是改這支的原因');

  -- 中間月份必須是整額
  select count(*) into n
    from public.revenue_recognitions r
    join public.orders o on o.id = r.order_id
    join public.contracts c on c.id = o.contract_id
   where o.imported_via = 'contract' and r.month_nights = r.total_nights
     and abs(r.month_amount - c.monthly_rent) > 1;
  insert into _chk137 values (3, '★★ 整月卻不是整額的',
    case when n = 0 then '✅ 0 列' else '❌ ' || n || ' 列' end,
    'month_nights = total_nights 就是整月,金額必須等於月租');

  -- 拿 8A2 出來看（使用者就是從這一筆發現的）
  insert into _chk137
  select 5, '★ 8A2 ' || r.ym,
         '$' || to_char(r.month_amount, 'FM999,999,999'),
         r.month_nights || '/' || r.total_nights || '　'
         || to_char(r.period_start, 'MM-DD') || '~' || to_char(r.period_end - 1, 'MM-DD')
    from public.revenue_recognitions r
    join public.orders o on o.id = r.order_id
   where o.property_raw = '8A2' and o.imported_via = 'contract'
   order by r.ym;
end $$;

select item as "檢查項目", result as "結果", detail as "說明"
from _chk137 order by ord, item;
