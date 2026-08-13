-- migration_114：新增「保證金」會計科目（收支兩用）
--
-- ============================================================
-- 【保證金跟「押金」不是同一件事】
--
-- 這兩個名字很像而性質相反，所以先講清楚：
--
--   押金（deposits 那張表）  收了要退，**不是營收**。
--                            退款走核可流程，帳上是負債不是收入。
--
--   保證金（這個科目）        收了就認列的收入 —— 違約沒收、
--                            設備保證金轉列收入、廠商履約保證金…
--
-- 填錯的方向很明確：把該退的錢記成營收，那個月的數字會憑空多出來，
-- 而且報表看起來完全正常。這也是為什麼它是一個**科目**而不是
-- 押金模組裡的一個選項 —— 進了這個科目就代表「這筆錢是我們的了」。
--
--
-- ============================================================
-- 【為什麼 kind 是 'both'】
--
-- 收得到也付得出去：跟房客收違約保證金是收入，
-- 付給房東或平台的履約保證金是支出。
--
-- 同一個科目兩邊都用是正常的會計做法（清潔費、修繕費早就這樣），
-- 損益表上各站一邊。kind 訂成 'income' 的話支出頁選不到它，
-- 訂成 'expense' 的話 orders 上的 trg_orders_kind_guard 會直接擋下訂單。
--
--
-- ============================================================
-- 【為什麼不用回填、也不會動到既有營收】
--
-- 這支只做兩件事：新增一列科目、擴充 order_account_code() 的對照。
-- **完全沒有 update orders**。
--
-- 那很重要：orders 上有 orders_recognize 觸發器，改任何一個欄位都會
-- 讓那筆訂單的營收認列重算。migration_91 為了回填 account_code
-- 得先存三個指紋再比對，就是為了防這件事。
--
-- 這裡沒有既有資料用得到「保證金」（這個名目今天才存在），
-- 所以沒有東西需要回填，也就沒有那個風險。

-- ── 1. 科目主檔 ────────────────────────────────────
-- sort 接在設備費（151）後面
insert into public.account_codes (code, name, sort, active, kind) values
  ('guarantee', '保證金', 152, true, 'both')
on conflict (code) do update set
  name = excluded.name, kind = excluded.kind, active = true;


-- ── 2. 名目 → 計入科目 ─────────────────────────────
-- 只加一行 '保證金' → 'guarantee'，其餘一個字都不動。
create or replace function public.order_account_code(p_source text, p_fee_type text)
returns text language sql immutable as $fn$
  select case
    -- 一次性收入：名目計入對應科目。名目本身照舊存在 fee_type，不動。
    when p_source in ('oneoff', 'airbnb_cancelled') then
      case coalesce(p_fee_type, '其他')
        when '水費'   then 'utility'
        when '電費'   then 'utility'
        when '瓦斯費' then 'utility'
        when '修繕費' then 'repair'
        when '網路費' then 'internet'
        when '管理費' then 'mgmtfee'
        when '清潔費' then 'cleaning'
        when '停車費' then 'parking'
        when '設備費' then 'equipment'
        when '保證金' then 'guarantee'
        -- 認不得的一律計入「其他」
        else 'other'
      end
    -- 其餘全部計入租金收入
    else 'rent_income'
  end
$fn$;


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('114_guarantee_code');
  end if;
end $$;


-- ============================================================
-- 驗證（結果直接是表格 —— raise notice 在 SQL Editor 看不到）
-- ============================================================
do $$
declare n int;
begin
  drop table if exists _chk114;
  create temp table _chk114 (ord int, item text, result text, detail text);

  insert into _chk114
  select 1, '科目已建立',
    case when exists (select 1 from public.account_codes
                       where code = 'guarantee' and name = '保證金'
                         and kind = 'both' and active)
         then '✅ 收支兩用' else '❌' end,
    '收得到（違約沒收）也付得出去（履約保證金）';

  insert into _chk114 values (2, '★ 一次性收入選「保證金」會計入 guarantee',
    case when public.order_account_code('oneoff', '保證金') = 'guarantee'
         then '✅' else '❌ 實際是 ' || public.order_account_code('oneoff', '保證金') end,
    '對不上的話那筆錢會掉進「其他」,報表上再也分不出來');

  insert into _chk114 values (3, '其他名目的對照沒有被改壞',
    case when public.order_account_code('oneoff', '清潔費') = 'cleaning'
          and public.order_account_code('oneoff', '水費') = 'utility'
          and public.order_account_code('private', null) = 'rent_income'
          and public.order_account_code('oneoff', '不存在的名目') = 'other'
         then '✅' else '❌ 對照表被動到了' end, '');

  -- 支出頁的科目下拉是「kind <> income 且 active」,所以 both 會出現
  select count(*) into n from public.account_codes
   where code = 'guarantee' and kind <> 'income' and active;
  insert into _chk114 values (4, '支出頁選得到',
    case when n = 1 then '✅' else '❌' end, '支出的科目下拉條件是 kind <> income');

  -- orders 的守衛只擋 kind = 'expense'
  insert into _chk114 values (5, '★ 訂單不會被守衛擋下來',
    case when (select kind from public.account_codes where code = 'guarantee') <> 'expense'
         then '✅' else '❌ trg_orders_kind_guard 會擋掉整筆訂單' end,
    'kind 訂成 expense 的話,選了保證金的訂單一存檔就被打回來');

  -- 這支不該動到任何一筆既有資料
  select count(*) into n from public.orders where fee_type = '保證金';
  insert into _chk114 values (6, '既有訂單沒有被動到',
    '－ 目前 ' || n || ' 筆用這個名目',
    '這支沒有任何 update orders —— 動了會讓營收認列整批重算');
end $$;

select item as "檢查項目", result as "結果", detail as "說明"
from _chk114 order by ord, item;
