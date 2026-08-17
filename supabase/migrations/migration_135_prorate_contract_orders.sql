-- migration_135：月中起租的月租單改成頭尾按比例
--
-- ============================================================
-- 【問題】（2026-08-16 使用者發現，10A5）
--
-- 契約 2026-07-16 ~ 2027-07-15，月租 170,000。
-- 現在產出來的 7 月月租單是:
--
--     2026-07-01 ~ 2026-08-01　31 天　$170,000
--
-- 也就是**向租客收了 7/01~7/15 這 15 天的錢，而那時他還沒起租**。
--
-- 原因在 gen_contract_orders:
--
--     ms := date_trunc('month', ct.start_date)::date;   ← 直接跳到月初
--     ...
--     values (..., ms, me, (me - ms), ct.monthly_rent, ...)  ← 一律整月整額
--
-- 它只認「這個日曆月」，完全沒有看 start_date 是幾號。
--
-- 尾端也一樣。租期 2026/6/6~2027/6/5 剛好 12 個月，但它碰到 13 個日曆月，
-- 於是產 13 張整額月租單 —— **多收一個月**。
-- （這件事 supabase/查-月中起租多一期.sql 已經記了很久，一直沒修。）
--
--
-- ============================================================
-- 【使用者決定：照日曆月，頭尾按比例】（2026-08-16）
--
--     2026-07-16 ~ 2026-08-01    16 天    170,000 × 16/31
--     2026-08-01 ~ 2026-09-01    整月     170,000
--     ⋯
--     2027-07-01 ~ 2027-07-16    15 天    170,000 × 15/31
--
-- 【為什麼不是照契約週期（7/16~8/16 每期整額）】
-- 那樣每一期都跨兩個日曆月，營收認列每個月都會被拆成兩段 ——
-- 對帳時每一個月都要加兩筆才對得上一間房。
-- 照日曆月的話只有頭尾兩張是零頭，中間十一張乾乾淨淨。
--
--
-- ============================================================
-- 【分攤慣例：無條件捨去，餘數全給最後一期】
--
-- 這是這個專案一貫的做法（migration_53 的營收認列、gen_recognitions
-- 都是這樣），使用者也明確確認過（2026-08-16）。
--
-- 所以要先知道「總共應該收多少」才能算餘數。定義:
--
--     應收總額 = Σ(每一期的 月租 × 該期天數 / 該日曆月天數)，四捨五入
--
-- 10A5:16/31 + 11 個整月 + 15/31 = 12 個月 = 2,040,000。
--
-- 兩趟迴圈:第一趟只加總，第二趟才寫入。
-- 一趟算不出來 —— 最後一期要用到「前面全部的合計」。
--
-- 【為什麼用 numeric 不用 float】
-- 170000 * 16 / 31 用浮點會得到 87741.93548387097 這種東西，
-- 而 trunc 之後每期差一元、十二期差十二元 —— 那筆錢沒有人找得回來。
--
--
-- ============================================================
-- 【end_date 是含當日】
--
-- 「2026/6/6 ~ 2027/6/5 剛好 12 個月」（查-月中起租多一期.sql 的原話）——
-- 6/5 是最後一天，所以排他的邊界是 end_date + 1。
--
-- 少加這個 1 的話最後一期會短一天，而 16 + 14 = 30 ≠ 31，
-- 整份契約就少收一天的錢。這種一天的差每期都對得起來、只有總額對不起來，
-- 是最難查的一種。
--
--
-- ============================================================
-- 【這一支不動任何資料】
--
-- 只換函式。既有的月租單要等 migration_136 才會重算 ——
-- 那一支會動到已收款的單，所以要先看過對照表再跑。
-- 結尾的自檢就是那張對照表（預覽，不寫入）。

/*
 * ============================================================
 * 【身分改用 (contract_id, checkin)，不再用 order_key】
 *
 * 第一版用 `on conflict (order_key)`，跑下去直接炸:
 *
 *     duplicate key value violates unique constraint "uq_contract_order_month"
 *     Key (contract_id, checkin)=(23032edd…, 2025-10-01) already exists.
 *
 * 資料庫上還有一條 `uq_contract_order_month (contract_id, checkin)`，
 * 而 `on conflict (order_key)` **攔不到它** —— 一個 insert 只能宣告一個
 * 衝突目標，另一條約束擋下來就是直接拋錯。
 *
 * 會撞到是因為 order_key 是 `LT_房號_年月` 組出來的:
 * 房號改過的契約，舊單掛著舊房號的 key，新的 key 對不上 → 走 insert →
 * 撞上 (contract_id, checkin)。
 *
 * 【真正的身分是什麼】
 * 「這份契約的這一期」—— 也就是 (contract_id, checkin)。
 * order_key 只是給人看的編號，它會因為改房號而變，本來就不該當主鍵用。
 *
 * 所以改成:先清掉不屬於目標期間的自動單，再以 (contract_id, checkin) upsert，
 * order_key 變成**被更新的欄位**而不是比對的依據。
 */
create or replace function public.gen_contract_orders(ct contracts)
returns void language plpgsql as $fn$
declare
  ms date; me date; ymtxt text;
  p_start date; p_end date;          -- 這一期實際涵蓋的區間（日曆月 ∩ 租期）
  n int;                             -- 這一期的天數
  dim int;                           -- 該日曆月的天數
  lease_end date;                    -- 排他的租期結束 = end_date + 1
  last_ms date := null;              -- 最後一個有天數的月份
  total numeric := 0;                -- 應收總額
  acc numeric := 0;                  -- 前面各期已開出的合計
  amt numeric;
  starts date[] := '{}';             -- 目標期間的起日，用來清掉不該存在的
  k text;
begin
  /*
   * ============================================================
   * 【房號空白的契約一律跳過 —— 那些不歸這支管】
   *
   * 原本只擋 `ct.room is null`。但房號是**空字串**的契約擋不掉，
   * 於是它組出 `LT__202510` 這種鍵去 insert，撞上
   * uq_contract_order_month —— 因為那一期早就存在了，
   * 只是鍵長得不一樣。
   *
   * 房號空白的契約（公司登記、辦公室租金這種本來就不屬於某一間房）
   * 走的是 **`LTC_{契約id}_`**，由前端的契約頁產生（見 lib/ltKey.keyBase）。
   * 兩套產生器同時對同一份契約動手，就是現在這個結果。
   *
   * 這裡不改成也走 LTC_ —— 那會變成資料庫和前端搶著產同一批單，
   * 而它們的算法目前不一樣。先讓這支退出，界線劃清楚。
   *
   * ⚠ 代價:**房號空白的契約沒有套用到「頭尾按比例」**，
   * 它們仍然是整月整額。要一起修的話得先決定由誰產。
   */
  if ct.room is null or btrim(ct.room) = '' then return; end if;
  if ct.start_date is null or ct.end_date is null then return; end if;
  if not ct.active or ct.monthly_rent is null or ct.monthly_rent <= 0 then
    -- 契約停用或沒有月租:未收款的自動單全部清掉,不留半套
    delete from orders
     where contract_id = ct.id and imported_via = 'contract' and paid = false;
    return;
  end if;

  lease_end := (ct.end_date + 1)::date;

  -- ── 第一趟：算應收總額、收集目標起日 ──
  ms := date_trunc('month', ct.start_date)::date;
  while ms < lease_end loop
    me      := (ms + interval '1 month')::date;
    p_start := greatest(ms, ct.start_date);
    p_end   := least(me, lease_end);
    n       := p_end - p_start;
    if n > 0 then
      dim     := me - ms;
      total   := total + ct.monthly_rent::numeric * n / dim;
      last_ms := ms;
      starts  := starts || p_start;
    end if;
    ms := me;
  end loop;
  total := round(total);

  /*
   * 清掉這份契約底下**不在目標期間**的自動單（未收款的才刪）。
   *
   * 這一段同時處理三種情況:
   *   · 租期改短 → 尾巴多出來的期數
   *   · 起日從月初改成月中 → 舊的 10-01 那張要讓位給 10-16
   *   · 「月中起租多一期」那個老 bug 留下的第 13 張
   *
   * 已收款的不刪 —— 錢進來過的單不該無聲消失。那些留著會在
   * migration_136 的報表上被列出來讓人看。
   */
  delete from orders
   where contract_id = ct.id and imported_via = 'contract' and paid = false
     and not (checkin = any(starts));

  -- ── 第二趟：寫入。除最後一期外無條件捨去，餘數全給最後一期 ──
  ms := date_trunc('month', ct.start_date)::date;
  while ms < lease_end loop
    me      := (ms + interval '1 month')::date;
    p_start := greatest(ms, ct.start_date);
    p_end   := least(me, lease_end);
    n       := p_end - p_start;
    if n > 0 then
      dim := me - ms;
      if ms = last_ms then
        amt := total - acc;
      else
        amt := trunc(ct.monthly_rent::numeric * n / dim);
        acc := acc + amt;
      end if;
      ymtxt := to_char(ms, 'YYYYMM');
      k     := 'LT_' || ct.room || '_' || ymtxt;

      /*
       * order_key 上也有唯一約束。房號改過時那個 key 可能還被
       * **別的列**佔著（同房號的舊契約、或這份契約的另一期）——
       * 不先讓開的話 upsert 會撞第二條約束，而 on conflict 只擋得住一條。
       */
      delete from orders
       where order_key = k and imported_via = 'contract' and paid = false
         and not (contract_id = ct.id and checkin = p_start);

      insert into orders (order_key, source, estate_id, property_raw, guest_name,
        checkin, checkout, nights, amount, deposit, note, imported_via, contract_id, paid)
      values (k, 'longterm', ct.estate_id, ct.room, ct.tenant_name,
        p_start, p_end, n, amt, 0, '契約應收', 'contract', ct.id, false)
      on conflict on constraint uq_contract_order_month do update
        /*
         * **checkout / nights 一定要一起更新。**
         *
         * 舊版只更新 amount，所以既有的單改了金額也還是掛在原本的期間 ——
         * 畫面上會變成「16 天的錢配 31 天的期間」，
         * 而營收認列是照 checkin/checkout 拆的，會拆錯月。
         *
         * checkin 不用寫 —— 它是衝突鍵的一部分，本來就相等。
         */
        set order_key = excluded.order_key, amount = excluded.amount,
            guest_name = excluded.guest_name, estate_id = excluded.estate_id,
            property_raw = excluded.property_raw,
            checkout = excluded.checkout, nights = excluded.nights
        where orders.imported_via = 'contract' and orders.paid = false;
    end if;
    ms := me;
  end loop;
end $fn$;

comment on function public.gen_contract_orders(contracts) is
  '契約 → 月租單。**照日曆月，頭尾按比例**（migration_135）—— '
  '月中起租的第一期只收 start_date 到月底，最後一期只收到 end_date 當天。'
  'end_date 是含當日,所以排他邊界是 end_date + 1 —— 少加這個 1 會整份少收一天。'
  '分攤:除最後一期外無條件捨去,餘數全給最後一期（跟 gen_recognitions 同一套）。'
  '**已收款的單不覆蓋** —— 要改那些走 migration_136。';


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('135_prorate_contract_orders');
  end if;
end $$;


-- ============================================================
-- 驗證 ＋ 預覽（**不寫入任何資料**）
-- ============================================================
do $$
declare n int; m numeric;
begin
  drop table if exists _chk135;
  create temp table _chk135 (ord int, item text, result text, detail text);

  insert into _chk135 values (1, 'gen_contract_orders 已更新',
    case when pg_get_functiondef('public.gen_contract_orders(contracts)'::regprocedure)
              like '%lease_end%' then '✅' else '❌' end,
    '這一支只換函式,沒有動任何一張月租單');

  -- 有幾份契約是月中起租（只算有房號的 —— 沒房號的這支不管）
  select count(*) into n from public.contracts
   where start_date is not null and extract(day from start_date) <> 1
     and room is not null and btrim(room) <> '';
  insert into _chk135 values (2, '★ 月中起租・有房號的契約', n || ' 份',
    '1 號起租的不受影響 —— 它們的第一期本來就是整月');

  /*
   * 房號空白的契約走 LTC_{契約id}_，由前端產生。
   * 這支跳過它們 —— 兩套產生器搶同一份契約就是這次撞約束的原因。
   * 但那代表它們**沒有套用到頭尾按比例**，要單獨列出來讓人知道。
   */
  select count(*) into n from public.contracts
   where start_date is not null and (room is null or btrim(room) = '');
  insert into _chk135 values (3, '★★ 房號空白的契約（這支不管）',
    case when n = 0 then '0 份' else '⚠ ' || n || ' 份' end,
    '走 LTC_{契約id}_，由前端契約頁產生。**沒有套用頭尾按比例**，'
    '仍然整月整額。要一起修得先決定由誰產');

  insert into _chk135
  select 4, '　（LTC）' || coalesce(c.tenant_name, '?'),
         to_char(c.start_date, 'YYYY-MM-DD') || ' ~ ' || to_char(c.end_date, 'YYYY-MM-DD'),
         '月租 $' || to_char(c.monthly_rent, 'FM999,999,999')
         || '・已開 ' || count(o.id) || ' 張'
         || case when extract(day from c.start_date) <> 1
                 then '　⚠ 月中起租但沒按比例' else '' end
    from public.contracts c
    left join public.orders o on o.contract_id = c.id and o.imported_via = 'contract'
   where c.start_date is not null and c.end_date is not null
     and (c.room is null or btrim(c.room) = '')
   group by c.id, c.tenant_name, c.start_date, c.end_date, c.monthly_rent
   order by 2;

  /*
   * 這些契約現在總共開了多少、照新規則應該是多少。
   *
   * 【為什麼要算兩個數字】
   * 只看「差幾張單」看不出嚴重性 —— 差一張 17 萬跟差一張 8 千
   * 在筆數上一模一樣。要看金額才知道這件事有多大。
   */
  insert into _chk135
  select 5, '★★ 月中起租契約・目前已開月租單',
         count(*) || ' 張',
         '合計 $' || to_char(coalesce(sum(o.amount), 0), 'FM999,999,999')
         || '（其中已收款 ' || count(*) filter (where o.paid) || ' 張）'
    from public.contracts c
    join public.orders o on o.contract_id = c.id and o.imported_via = 'contract'
   where c.start_date is not null and extract(day from c.start_date) <> 1;

  insert into _chk135
  select 6, '★★ 照契約應收（月租 × 月數）',
         count(*) || ' 份契約',
         '合計 $' || to_char(coalesce(sum(
           c.monthly_rent *
           ((extract(year from c.end_date)::int * 12 + extract(month from c.end_date)::int)
            - (extract(year from c.start_date)::int * 12 + extract(month from c.start_date)::int))
         ), 0), 'FM999,999,999')
    from public.contracts c
   where c.start_date is not null and c.end_date is not null
     and c.monthly_rent is not null and extract(day from c.start_date) <> 1;

  /*
   * 逐份列出來。這張表是給人看的 ——
   * migration_136 會動到已收款的單，而「已收款」代表錢真的進來過。
   * 沒看過這張表就跑下一支的話，改壞了沒有人會發現。
   */
  insert into _chk135
  select 8, '　' || c.room || '（' || coalesce(c.tenant_name, '?') || '）',
         to_char(c.start_date, 'YYYY-MM-DD') || ' ~ ' || to_char(c.end_date, 'YYYY-MM-DD'),
         '月租 $' || to_char(c.monthly_rent, 'FM999,999,999')
         || '・已開 ' || count(o.id) || ' 張 $' || to_char(sum(o.amount), 'FM999,999,999')
         || '・應收 ' || ((extract(year from c.end_date)::int * 12 + extract(month from c.end_date)::int)
              - (extract(year from c.start_date)::int * 12 + extract(month from c.start_date)::int))
         || ' 個月 $' || to_char(c.monthly_rent *
              ((extract(year from c.end_date)::int * 12 + extract(month from c.end_date)::int)
               - (extract(year from c.start_date)::int * 12 + extract(month from c.start_date)::int)),
              'FM999,999,999')
         || case when count(o.id) filter (where o.paid) > 0
                 then '　⚠ 已收款 ' || count(o.id) filter (where o.paid) || ' 張' else '' end
    from public.contracts c
    join public.orders o on o.contract_id = c.id and o.imported_via = 'contract'
   where c.start_date is not null and c.end_date is not null
     and c.monthly_rent is not null and extract(day from c.start_date) <> 1
   group by c.id, c.room, c.tenant_name, c.start_date, c.end_date, c.monthly_rent
   order by 2;

  insert into _chk135 values (9, '★ 下一步', 'migration_136',
    '看過上面每一份契約的差額之後再跑。這一支還沒有動任何資料');
end $$;

select item as "檢查項目", result as "結果", detail as "說明"
from _chk135 order by ord, item;
