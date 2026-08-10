-- migration_95：訂單日期守衛 ＋ 新增「雜項購置」會計科目
--
-- ============================================================
-- 【一、為什麼要擋 checkout < checkin】
--
-- 2026-08 的營收健檢抓到一筆：
--
--     PV_2025-08-30_A5_be966d  胡恩寧  A5
--     入住 2025-08-30 / 退房 2025-08-29 / 晚數 0 / 金額 450,000
--
-- 退房日比入住日早一天（匯入時年份打錯），nights = 0。
-- gen_recognitions() 開頭就有一道守衛：
--
--     if o.nights is null or o.nights <= 0 then return; end if;
--
-- 直接 return，不產生任何認列 —— 那是為了避免分攤公式除以零。
-- 守衛本身是對的，但代價是**這筆 45 萬從來沒有進過任何營收數字，而且不報錯**。
--
-- 資料庫層擋掉的話，匯入端打錯會當場失敗，而不是靜靜地少一筆營收。
--
--
-- ============================================================
-- 【陷阱：一次性收入的 checkin = checkout】
--
-- 不能無條件要求 checkout > checkin。加費、折讓、契約固定加費
-- 都是「同一天」的列：
--
--     shortterm 頁的加費   checkin: f.date, checkout: f.date, nights: 0
--     契約折讓 CDIS_…      同上
--     契約固定加費 CRC_…    同上
--
-- 無條件加上去會把這些全部擋掉，而它們是正確的資料。
-- 所以拆成兩條：**任何訂單不能倒退**，**住宿型訂單至少要住一晚**。
--
--
-- ============================================================
-- 【NOT VALID：先擋新的，舊的另外修】
--
-- 直接加約束會因為既有的違規列而失敗，整支跑不動。
-- 用 NOT VALID：**新增與修改立刻受約束，既有列先放過**。
-- 修完既有的那幾筆之後，再跑最下面那行 VALIDATE 把保護補滿。
--
-- 這個順序很重要 —— 先擋住出血，再處理存量。


-- ============================================================
-- 0. 先看有哪些既有違規列（只讀）
-- ============================================================

select
  o.order_key as 訂單鍵, o.source as 來源, o.imported_via as 產生方式,
  o.property_raw as 房源, o.guest_name as 客戶,
  o.checkin as 入住, o.checkout as 退房, o.nights as 晚數, o.amount as 金額,
  o.paid as 已收款,
  case
    when o.checkout < o.checkin then '❌ 退房早於入住'
    else '❌ 住宿型訂單但同一天（住不到一晚）'
  end as 問題,
  case when exists (select 1 from public.revenue_recognitions r where r.order_id = o.id)
       then '有認列' else '⚠ 完全沒有認列 —— 這筆錢沒進過營收' end as 認列狀況
from public.orders o
where o.checkin is not null and o.checkout is not null
  and (o.checkout < o.checkin
       or (o.source not in ('oneoff', 'airbnb_cancelled') and o.checkout = o.checkin))
order by o.amount desc nulls last;


-- ============================================================
-- 1. 兩條約束
-- ============================================================

-- 任何訂單都不能「退房早於入住」—— 沒有任何業務情境是這樣
alter table public.orders drop constraint if exists ord_dates_chk;
alter table public.orders add constraint ord_dates_chk
  check (checkin is null or checkout is null or checkout >= checkin) not valid;

/*
 * 住宿型訂單至少要住一晚。
 *
 * 排除 oneoff 與 airbnb_cancelled —— 那兩種是「一次性收入」，
 * 記的是某一天發生的一筆錢（加費、折讓、取消費），
 * checkin = checkout 是它們正確的樣子，不是錯誤。
 */
alter table public.orders drop constraint if exists ord_stay_nights_chk;
alter table public.orders add constraint ord_stay_nights_chk
  check (
    checkin is null or checkout is null
    or source in ('oneoff', 'airbnb_cancelled')
    or checkout > checkin
  ) not valid;

comment on constraint ord_dates_chk on public.orders is
  '退房不能早於入住。2026-08 有一筆匯入時年份打錯（退房比入住早一天）,'
  'nights=0 讓 gen_recognitions 直接 return,45 萬從來沒進過營收而且不報錯。';
comment on constraint ord_stay_nights_chk on public.orders is
  '住宿型訂單至少一晚。oneoff / airbnb_cancelled 例外 —— '
  '一次性收入的 checkin = checkout 是正確的（加費、折讓、取消費都是單日）。';


-- ============================================================
-- 2. 新增會計科目「雜項購置」
--
-- kind = 'expense'：只用於支出。收入側用不到這個科目。
-- sort 接在專業服務費（140）與停車費（150）之間的空檔。
-- ============================================================

insert into public.account_codes (code, name, sort, active, kind) values
  ('misc_asset', '雜項購置', 145, true, 'expense')
on conflict (code) do update
  set name = excluded.name, kind = excluded.kind, active = true;


-- ============================================================
-- 驗證
--
-- 包在 exception 裡：驗證失敗只發警告，不要把上面的變更整包回滾掉。
-- ============================================================

do $$
declare n int; t text;
begin
  -- 約束在不在
  select count(*) into n from pg_constraint
   where conrelid = 'public.orders'::regclass
     and conname in ('ord_dates_chk', 'ord_stay_nights_chk');
  if n = 2 then raise notice '✅ 兩條日期約束都建立了';
  else raise warning '❌ 只建立了 % 條', n; end if;

  -- ★ 一次性收入必須被排除,否則加費與折讓會全部寫不進去
  select pg_get_constraintdef(oid) into t from pg_constraint
   where conrelid = 'public.orders'::regclass and conname = 'ord_stay_nights_chk';
  if position('oneoff' in t) > 0 then
    raise notice '✅ 一次性收入已排除（加費/折讓/取消費的 checkin=checkout 不受影響）';
  else raise warning '❌ 沒有排除 oneoff —— 加費與折讓會全部存不進去!'; end if;

  -- 既有違規列還有幾筆（NOT VALID 所以不會擋,但要知道還剩幾筆要修）
  select count(*) into n from public.orders o
   where o.checkin is not null and o.checkout is not null
     and (o.checkout < o.checkin
          or (o.source not in ('oneoff','airbnb_cancelled') and o.checkout = o.checkin));
  if n = 0 then
    raise notice '✅ 沒有既有違規列 —— 可以直接跑最下面的 VALIDATE 把保護補滿';
  else
    raise warning 'ℹ 還有 % 筆既有違規列（上面第 0 段列出來了）。'
                  '新的寫入已經擋住了,修完那幾筆再跑 VALIDATE。', n;
  end if;

  -- 會計科目
  select name into t from public.account_codes where code = 'misc_asset';
  if t = '雜項購置' then raise notice '✅ 會計科目「雜項購置」已建立';
  else raise warning '❌ 科目沒建起來'; end if;

  select count(*) into n from public.account_codes where active;
  raise notice 'ℹ 目前啟用中的會計科目 % 個', n;

exception when others then
  raise warning '驗證區出錯（上面的變更不受影響）:%', sqlerrm;
end $$;


-- ── 約束真的擋得住嗎（實測）─────────────────────────
--
-- 只讀 pg_constraint 驗證得到「約束存在」，驗證不到「它真的擋得住」。
-- 這裡用 savepoint 實際插一筆再回滾，不留任何痕跡。

do $$
declare blocked_bad boolean := false; passed_oneoff boolean := false;
begin
  -- (1) 退房早於入住 → 應該被擋
  begin
    insert into public.orders (order_key, source, checkin, checkout, nights, amount)
    values ('__DATE_PROBE_BAD__', 'private', current_date, current_date - 1, 0, 1);
  exception when check_violation then blocked_bad := true;
  end;
  if blocked_bad then raise notice '✅ 退房早於入住會被擋下來';
  else raise warning '❌ 沒擋住!'; end if;

  -- (2) 一次性收入同一天 → 應該要能寫入
  begin
    insert into public.orders (order_key, source, checkin, checkout, nights, amount)
    values ('__DATE_PROBE_OK__', 'oneoff', current_date, current_date, 0, 1);
    passed_oneoff := true;
  exception when others then
    raise warning '❌ 一次性收入被擋住了!加費與折讓會全部存不進去:%', sqlerrm;
  end;
  if passed_oneoff then raise notice '✅ 一次性收入（同一天）照常寫得進去'; end if;

  -- 清掉測試列（第 1 筆被擋下來所以本來就不存在）
  delete from public.orders where order_key in ('__DATE_PROBE_BAD__', '__DATE_PROBE_OK__');
  raise notice '✅ 測試資料已清除';
exception when others then
  raise warning '實測出錯:%', sqlerrm;
  delete from public.orders where order_key in ('__DATE_PROBE_BAD__', '__DATE_PROBE_OK__');
end $$;


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    raise notice '%', (select public.record_migration('95_order_dates_and_account'));
  else
    raise notice '尚未建立 schema_migrations（migration_70），這支沒有被記錄';
  end if;
end $$;


-- ============================================================
-- 【修完既有違規列之後，再跑這兩行】
--
-- VALIDATE 會掃過全表確認沒有違規，通過之後約束就是完全生效的
-- （NOT VALID 期間只擋新寫入，既有列不檢查）。
-- 還有違規列時這兩行會失敗 —— 那是對的，表示還沒修完。
--
--   alter table public.orders validate constraint ord_dates_chk;
--   alter table public.orders validate constraint ord_stay_nights_chk;
-- ============================================================
