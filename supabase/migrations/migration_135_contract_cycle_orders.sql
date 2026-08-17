-- migration_135：月租單改成跟著契約週期走（月中起租不再從月初開始）
--
-- ============================================================
-- 【收款與認列是兩件事】（2026-08-16 使用者指正）
--
-- 我第一版把這兩件事混在一起，而且方向搞反了。先把模型寫清楚:
--
--     訂單（orders）      = **繳款單**。定期月繳,客戶繳的是**整月**。
--                          7/16 起租 → 7/16~8/16 繳一個月 $170,000
--
--     認列（recognitions）= **當月該認多少**。由 gen_recognitions 依晚數自動拆。
--                          那張單會被拆成 7 月 16 天、8 月 15 天
--
-- 也就是說 —— **金額本來就不該按比例拆**。要拆的是認列，
-- 而那一段早就寫好了、而且是對的。
--
--
-- ============================================================
-- 【真正的 bug：訂單期間從月初開始】
--
-- gen_contract_orders 原本是:
--
--     ms := date_trunc('month', ct.start_date)::date;   ← 跳到月初
--     while ms < ct.end_date loop
--       me := ms + interval '1 month';                  ← 一個日曆月
--
-- 契約 2026-07-16 起租，它開出來的第一張是 **2026-07-01 ~ 2026-08-01**。
--
-- 兩個後果:
--
--   1. 認列跟著錯。gen_recognitions 是照 checkin/checkout 拆的,
--      所以 7 月認了 31 天 $170,000 —— 而租客 7/15 之前根本還沒住進來。
--   2. 尾巴少一期。租期到 2027-07-15,但迴圈在 2027-06 就停了,
--      2027-07-01~07-15 那半個月沒有單。
--
-- 一頭多、一尾少，**整份契約的總額剛好抵銷** ——
-- 所以合計對得上，錯的只有每一期落在哪個月。
-- 那也正是為什麼這個 bug 活了這麼久。
--
--
-- ============================================================
-- 【改法：期間跟著契約週期】
--
--     2026-07-16 ~ 2026-08-16    $170,000
--     2026-08-16 ~ 2026-09-16    $170,000
--     ⋯
--     2027-06-16 ~ 2027-07-16    $170,000      共 12 期
--
-- **金額一毛都不用改。** 只有 checkin / checkout / nights 會動。
--
-- 這件事很重要:
--   · 已收款的單金額不變 → 跟 order_payments 的實收永遠對得上
--   · order_key 不變（還是用 checkin 的年月組,7/16 → 202607）
--   · 只有營收認列會重新分配 —— 那正是要修的東西
--
-- 認列由 gen_recognitions 在 orders 更新時自動重算，這支不用碰。
--
--
-- ============================================================
-- 【最後一期可能不足月】
--
-- 大多數契約的 end_date + 1 剛好是週期邊界（2026-07-16 ~ 2027-07-15）。
-- 但有些不是 —— 17B5 迄 2028-10-30、萩嗨嗨 迄 2026-08-30。
--
-- 那種情況最後一期比一個月短，金額按天數比例，
-- 而且**餘數全給最後一期**（這個專案一貫的分攤慣例,
-- 跟 gen_recognitions 同一套,使用者也確認過）。
--
--
-- ============================================================
-- 【order_key 撞鍵：同一間房兩份契約重疊】
--
-- `order_key` 是 `LT_房號_年月`，**不含契約 id**。
-- 南京10-2 有「舊房客（小姐）」與「林文琇」兩份契約在
-- 2025-11 ~ 2026-02 同時活著 —— 重疊的月份組出同一個鍵。
--
-- 舊契約那張已收款、刪不掉，於是新契約那一期開不出來。
-- 硬插的下場是整份 migration 回滾,前面幾百份算對的一起白做。
--
-- 所以記進 contract_order_conflicts 然後跳過。**對不上的不猜。**
-- 那張表有東西就代表有一期的錢沒開單，要人去看是哪兩份契約重疊。


create table if not exists public.contract_order_conflicts (
  contract_id    uuid not null references public.contracts(id) on delete cascade,
  ym             text not null,
  room           text,
  want_start     date,
  want_end       date,
  want_amount    numeric,
  blocked_by_key text,
  seen_at        timestamptz not null default now(),
  primary key (contract_id, ym)
);

comment on table public.contract_order_conflicts is
  '契約月租單開不出來的期數。原因幾乎都是「同一間房兩份契約在時間上重疊」——'
  'order_key 是 LT_房號_年月,不含契約,重疊的月份會撞鍵。'
  '這張表有東西就代表**有一期的錢沒有開單**,要人去看是哪兩份契約重疊了。';


create or replace function public.gen_contract_orders(ct contracts)
returns void language plpgsql as $fn$
declare
  p_start date; p_end date; full_end date;
  n int; full_n int;
  lease_end date;                    -- 排他的租期結束 = end_date + 1
  total numeric := 0; acc numeric := 0; amt numeric;
  periods int := 0; idx int := 0;
  starts date[] := '{}';
  ymtxt text; k text;
  v_id uuid; v_paid boolean;
begin
  /*
   * 房號空白的契約一律跳過 —— 那些是**辦公室登記 / 公司登記**
   * （使用者確認，2026-08-16），本來就不屬於某一間房。
   * 它們走 `LTC_{契約id}_`，由前端契約頁產生（見 lib/ltKey.keyBase）。
   *
   * 原本只擋 `ct.room is null`，擋不掉空字串 —— 於是這支會組出
   * `LT__202510` 去插，撞上另一套產生器已經開好的單。
   * 兩套產生器對同一份契約動手，就是那個 23505 的由來。
   */
  if ct.room is null or btrim(ct.room) = '' then return; end if;
  if ct.start_date is null or ct.end_date is null then return; end if;

  if not ct.active or ct.monthly_rent is null or ct.monthly_rent <= 0 then
    delete from orders
     where contract_id = ct.id and imported_via = 'contract' and paid = false;
    return;
  end if;

  lease_end := (ct.end_date + 1)::date;   -- end_date 是含當日

  -- ── 第一趟：期間與總額 ──
  p_start := ct.start_date;
  while p_start < lease_end loop
    full_end := (p_start + interval '1 month')::date;
    p_end    := least(full_end, lease_end);
    n        := p_end - p_start;
    full_n   := full_end - p_start;
    if n > 0 then
      -- 足月就整額;不足月按天數比例（只有最後一期可能不足月）
      total    := total + (case when n = full_n then ct.monthly_rent::numeric
                                else ct.monthly_rent::numeric * n / full_n end);
      periods  := periods + 1;
      starts   := starts || p_start;
    end if;
    p_start := full_end;
  end loop;
  total := round(total);

  /*
   * 清掉不在目標期間的自動單（未收款的才刪）。
   * 同時處理:租期改短多出來的、起日移動之後讓位的、
   * 以及「月中起租多一期」那個老 bug 留下的尾巴。
   */
  delete from orders
   where contract_id = ct.id and imported_via = 'contract' and paid = false
     and not (checkin = any(starts));

  -- ── 第二趟：寫入 ──
  p_start := ct.start_date;
  while p_start < lease_end loop
    full_end := (p_start + interval '1 month')::date;
    p_end    := least(full_end, lease_end);
    n        := p_end - p_start;
    full_n   := full_end - p_start;
    if n > 0 then
      idx := idx + 1;
      if idx = periods then
        amt := total - acc;                        -- 餘數全給最後一期
      else
        amt := trunc(case when n = full_n then ct.monthly_rent::numeric
                          else ct.monthly_rent::numeric * n / full_n end);
        acc := acc + amt;
      end if;

      -- 鍵用 checkin 的年月組。週期期間各自落在不同的日曆月，鍵不會重複
      ymtxt := to_char(p_start, 'YYYYMM');
      k     := 'LT_' || ct.room || '_' || ymtxt;

      /*
       * 同一個月如果有重複的自動單（歷史遺留），先清掉多的只留一張。
       * 留的優先順序:已收款的優先 —— 那張上面掛著收款紀錄與發票。
       */
      delete from orders o
       where o.contract_id = ct.id and o.imported_via = 'contract' and not o.paid
         and o.checkin >= date_trunc('month', p_start)::date
         and o.checkin <  (date_trunc('month', p_start) + interval '1 month')::date
         and o.id <> (select x.id from orders x
                       where x.contract_id = ct.id and x.imported_via = 'contract'
                         and x.checkin >= date_trunc('month', p_start)::date
                         and x.checkin <  (date_trunc('month', p_start) + interval '1 month')::date
                       order by x.paid desc, x.checkin limit 1);

      /*
       * 用**日曆月**找對應的那一列，不用精確 checkin ——
       * checkin 正在從 07-01 移到 07-16，拿移動後的值去找移動前的列永遠找不到。
       */
      select o.id, o.paid into v_id, v_paid
        from orders o
       where o.contract_id = ct.id and o.imported_via = 'contract'
         and o.checkin >= date_trunc('month', p_start)::date
         and o.checkin <  (date_trunc('month', p_start) + interval '1 month')::date
       limit 1;

      if v_id is not null then
        /*
         * 有這一期。
         *
         * **checkin / checkout / nights 一定要一起更新** ——
         * 認列是 gen_recognitions 照 checkin/checkout 拆的,
         * 只改金額不改期間的話認列還是落在錯的月份。
         *
         * `not v_paid` 是刻意的:已收款的單這支永遠不碰。
         * 那些要改的話走 migration_136 —— 而**金額不會變**,
         * 所以那一步比原本的計畫安全得多。
         */
        if not v_paid then
          delete from orders o
           where o.order_key = k and o.imported_via = 'contract'
             and not o.paid and o.id <> v_id;

          if exists (select 1 from orders o where o.order_key = k and o.id <> v_id) then
            -- 鍵被一張刪不掉的單佔著 → 保留原鍵，只改期間與金額。
            -- 鍵不漂亮但資料是對的;硬要改名就是整支炸掉
            update orders
               set amount = amt, guest_name = ct.tenant_name, estate_id = ct.estate_id,
                   property_raw = ct.room, checkin = p_start, checkout = p_end, nights = n
             where id = v_id;
          else
            update orders
               set order_key = k, amount = amt, guest_name = ct.tenant_name,
                   estate_id = ct.estate_id, property_raw = ct.room,
                   checkin = p_start, checkout = p_end, nights = n
             where id = v_id;
          end if;
        end if;

      else
        delete from orders o
         where o.order_key = k and o.imported_via = 'contract' and not o.paid;

        if exists (select 1 from orders o where o.order_key = k) then
          insert into public.contract_order_conflicts
            (contract_id, room, ym, want_start, want_end, want_amount, blocked_by_key, seen_at)
          values (ct.id, ct.room, ymtxt, p_start, p_end, amt, k, clock_timestamp())
          on conflict (contract_id, ym) do update
            set want_start = excluded.want_start, want_end = excluded.want_end,
                want_amount = excluded.want_amount, seen_at = excluded.seen_at;
        else
          insert into orders (order_key, source, estate_id, property_raw, guest_name,
            checkin, checkout, nights, amount, deposit, note, imported_via, contract_id, paid)
          values (k, 'longterm', ct.estate_id, ct.room, ct.tenant_name,
            p_start, p_end, n, amt, 0, '契約應收', 'contract', ct.id, false);
        end if;
      end if;
    end if;
    p_start := full_end;
  end loop;
end $fn$;

comment on function public.gen_contract_orders(contracts) is
  '契約 → 月租單。**期間跟著契約週期走**（migration_135）—— '
  '7/16 起租的第一期是 7/16~8/16,不是 7/01~8/01。'
  '訂單是繳款單,客戶繳整月,所以**金額不按比例拆**;'
  '要拆的是營收認列,那是 gen_recognitions 依 checkin/checkout 自動做的。'
  'end_date 含當日,排他邊界是 end_date + 1。'
  '最後一期若不足月才按天數比例,餘數全給它。'
  '房號空白的契約（辦公室登記）不歸這支管,走 LTC_ 由前端產生。'
  '**已收款的單不碰** —— 要改那些走 migration_136。';


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('135_contract_cycle_orders');
  end if;
end $$;


-- ============================================================
-- 驗證 ＋ 預覽（**不寫入任何月租單**）
-- ============================================================
do $$
declare n int;
begin
  drop table if exists _chk135;
  create temp table _chk135 (ord int, item text, result text, detail text);

  insert into _chk135 values (1, 'gen_contract_orders 已更新',
    case when pg_get_functiondef('public.gen_contract_orders(contracts)'::regprocedure)
              like '%full_end%' then '✅' else '❌' end,
    '期間跟著契約週期走。**這一支只換函式,沒有動任何一張月租單**');

  insert into _chk135 values (1, 'contract_order_conflicts 表',
    case when to_regclass('public.contract_order_conflicts') is not null
         then '✅' else '❌' end,
    '撞鍵時把開不出來的期數記在這裡,不硬插');

  select count(*) into n from public.contracts
   where start_date is not null and extract(day from start_date) <> 1
     and room is not null and btrim(room) <> '';
  insert into _chk135 values (2, '★ 月中起租・有房號的契約', n || ' 份',
    '這些的第一期會從月初移到 start_date。**金額不變,只有期間變**');

  select count(*) into n from public.contracts
   where start_date is not null and (room is null or btrim(room) = '');
  insert into _chk135 values (2, '房號空白的契約（這支不管）', n || ' 份',
    '辦公室登記／公司登記,走 LTC_{契約id}_ 由前端產生');

  /*
   * 同一間房有兩份契約在時間上重疊 —— 這是南京10-2 撞鍵的根因。
   * 這一條不是 0 的話,那些房間的月租單一定有一期開不出來。
   */
  insert into _chk135
  select 5, '★★ 房源重疊：' || a.room,
         a.tenant_name || ' ＋ ' || b.tenant_name,
         to_char(a.start_date,'YYYY-MM-DD') || '~' || to_char(a.end_date,'YYYY-MM-DD')
         || '　與　' || to_char(b.start_date,'YYYY-MM-DD') || '~' || to_char(b.end_date,'YYYY-MM-DD')
         || '　⚠ order_key 會撞,其中一份的月租單開不出來'
    from public.contracts a
    join public.contracts b
      on b.room = a.room and b.id > a.id
     and a.start_date <= b.end_date and b.start_date <= a.end_date
   where a.room is not null and btrim(a.room) <> ''
     and a.start_date is not null and a.end_date is not null
     and b.start_date is not null and b.end_date is not null;

  select count(*) into n from public.contract_order_conflicts;
  insert into _chk135 values (7, '★★ 目前開不出來的期數',
    case when n = 0 then '✅ 0 期' else '⚠ ' || n || ' 期' end,
    '要等 migration_136 跑過才會有值。查 public.contract_order_conflicts');

  insert into _chk135 values (9, '★ 下一步', 'migration_136',
    '先把上面「房源重疊」那幾份契約的日期修好,再跑 136');
end $$;

select item as "檢查項目", result as "結果", detail as "說明"
from _chk135 order by ord, item;
