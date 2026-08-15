-- migration_91：收入自動掛會計科目（名目 → 計入科目的對應）
--
-- ============================================================
-- 【要解決什麼】
--
-- 支出從第一天就有會計科目，**收入從來沒有**。
-- 3,549 筆租金訂單、全部的一次性收入，都只靠 source 與 fee_type 分類，
-- 會計要出損益表得自己在 Excel 裡對一次。
--
-- 這一支把收入接上科目表。**使用者完全不用選** —— 訂單表單不會多任何欄位，
-- 科目由 source 與 fee_type（名目）推導出來，資料庫自己填。
--
--
-- ============================================================
-- 【名目 ≠ 會計科目 —— 這一版跟上一版草稿的差別】
--
-- 上一版草稿把兩層搞混了，跑去改科目名稱（修繕維護→修繕費）、
-- 把水電瓦斯拆成三個。使用者指正：**那些是名目，不是會計科目**。
--
-- 名目是收款畫面上選的細項（水費、電費、瓦斯費……），
-- 會計科目是損益表上的分類，本來就該比名目粗。
-- 正確做法是**科目表一個字不動**，中間補一層「名目計入哪個科目」：
--
--     名目                          計入科目
--     ────────────────────────────────────────
--     水費 / 電費 / 瓦斯費      →  水電瓦斯   (utility)
--     修繕費                    →  修繕維護   (repair)
--     網路費                    →  網路第四台 (internet)
--     管理費                    →  管理費     (mgmtfee)
--     清潔費                    →  清潔費     (cleaning)
--     停車費                    →  停車費     (parking)   ← 新增科目
--     設備費                    →  設備費     (equipment) ← 新增科目
--     其他 / 沒填 / 舊值取消費  →  其他       (other)
--
--     長租 / 辦公室 / 公司登記
--     Airbnb / Agoda / 私下 / 搭檔 → 租金收入 (rent_income, migration_90)
--
-- 停車費與設備費是使用者確認要新增的 —— 它們不是租金（房客可以只租房
-- 不租車位），也不該埋進「其他」（每月穩定發生，埋進去就永遠答不出
-- 「車位一年收多少」）。
--
--
-- ============================================================
-- 【回填為什麼要護欄】
--
-- orders 上有 orders_recognize 觸發器：
--
--     AFTER INSERT OR DELETE OR UPDATE → 刪掉該訂單的認列，重新產生
--
-- 所以回填 account_code 這個「跟金額無關」的欄位，會讓**全部營收認列重算**。
-- 理論上重算結果應該一模一樣，但 gen_recognitions 被 migration_53（進位）、
-- 75（fee_type 預設）、76（週期性）改過三次 —— 萬一今天的函式跟當初寫入時
-- 行為不同，回填會靜靜地改寫歷史營收，而且沒有任何跡象。
--
-- 所以動之前先存三個指紋（筆數、總額、逐月總額的雜湊），動完再比一次。
-- 任何一個對不上就 raise exception，整支回滾 —— 一分錢都不會被改到。


-- ============================================================
-- 1. 科目主檔：只補、不改
--
-- 既有科目的 code 與名稱**一個都不動**。
-- ============================================================

-- 使用者確認新增的兩個。sort 接在專業服務費（140）後面。
insert into public.account_codes (code, name, sort, active, kind) values
  ('parking',   '停車費', 150, true, 'both'),
  ('equipment', '設備費', 151, true, 'both')
on conflict (code) do update set kind = excluded.kind, active = true;

-- 收入的名目會計入這幾個既有科目，所以它們從「只能支出」翻成「收支兩用」。
-- 同一個科目兩邊都用是正常的會計做法：清潔費跟房客收是收入、
-- 付清潔公司是支出，損益表上各站一邊。名稱、code、sort 都不動。
update public.account_codes set kind = 'both'
 where code in ('utility', 'repair', 'internet', 'mgmtfee', 'cleaning', 'other')
   and kind = 'expense';


-- ============================================================
-- 2. 名目 → 計入科目
--
-- 獨立成函式而不是寫死在觸發器裡，因為回填、驗證、之後的報表都要用同一份規則。
-- 兩個地方各寫一次的話，總有一天會不一致，而不一致不會報錯。
--
-- IMMUTABLE：只看參數、不查表、同樣輸入永遠同樣輸出。
-- ============================================================

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
        -- 認不得的一律計入「其他」。這裡涵蓋 migration_75 之前的舊值「取消費」——
        -- 那支已經把 orders 上的值改掉了，這裡是保底，不是主要路徑。
        else 'other'
      end
    -- 其餘全部計入租金收入：長租、辦公室、公司登記、Airbnb、Agoda、私下、搭檔
    else 'rent_income'
  end
$fn$;

comment on function public.order_account_code(text, text) is
  '收入的名目（source + fee_type）計入哪個會計科目。使用者不選,由這份規則推導。'
  '回填與觸發器共用同一份 —— 分開寫總有一天會不一致,而不一致不會報錯。';


-- ============================================================
-- 3. 欄位與觸發器
-- ============================================================

alter table public.orders
  add column if not exists account_code text references public.account_codes(code);

create index if not exists orders_account_code_idx on public.orders (account_code);

comment on column public.orders.account_code is
  '收入計入的會計科目。**由觸發器自動填,前端不要寫** —— 規則在 order_account_code()。';

/*
 * 一律覆寫，不保留手動值。
 *
 * 使用者明確說「收入不用選的就自動填」，所以不存在「手動指定」這件事。
 * 若改成「只在 null 時填」，前端或匯入不小心寫進一個值就再也校正不回來，
 * 而報表看起來一切正常。
 */
create or replace function public.sync_order_account() returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  new.account_code := public.order_account_code(new.source, new.fee_type);
  return new;
end $fn$;

drop trigger if exists trg_orders_account on public.orders;
create trigger trg_orders_account
  before insert or update on public.orders
  for each row execute function public.sync_order_account();


-- ============================================================
-- 4. 回填 —— 帶認列指紋的護欄（見檔頭）
-- ============================================================

do $$
declare
  n int;
  n0 bigint; n1 bigint;          -- 認列筆數
  s0 numeric; s1 numeric;        -- 認列總額
  h0 text;    h1 text;           -- 逐月總額的雜湊
begin
  select count(*), coalesce(sum(month_amount), 0) into n0, s0 from public.revenue_recognitions;
  -- round() 再轉字串：numeric 的 1234 與 1234.00 值相同但文字不同，
  -- 不正規化的話會誤報「分佈變了」而白白回滾一支正確的 migration
  select md5(string_agg(ym || ':' || t::text, '|' order by ym)) into h0
    from (select ym, round(sum(month_amount)) t from public.revenue_recognitions group by ym) x;

  update public.orders
     set account_code = public.order_account_code(source, fee_type)
   where account_code is distinct from public.order_account_code(source, fee_type);
  get diagnostics n = row_count;
  raise notice 'ℹ 回填 % 筆訂單的會計科目', n;

  select count(*), coalesce(sum(month_amount), 0) into n1, s1 from public.revenue_recognitions;
  select md5(string_agg(ym || ':' || t::text, '|' order by ym)) into h1
    from (select ym, round(sum(month_amount)) t from public.revenue_recognitions group by ym) x;

  if n0 <> n1 then
    raise exception '營收認列的筆數被動到了：% → %。這支只該補一個分類欄位。', n0, n1;
  end if;
  if s0 <> s1 then
    raise exception '營收總額被動到了：% → %，差 %。這支只該補一個分類欄位。', s0, s1, s1 - s0;
  end if;
  if h0 is distinct from h1 then
    raise exception '逐月營收的分佈被動到了（總額相同但某些月份互相搬移）。這支只該補一個分類欄位。';
  end if;
  raise notice '✅ 營收認列完全沒變：% 筆、合計 %', n1, s1;
end $$;


-- ============================================================
-- 5. 不讓支出專用科目掛到收入上
--
-- 跟 migration_90 擋收入科目掛到支出上是對稱的一道。
-- 前端根本沒有這個下拉，所以只可能從 API、匯入、或未來的程式進來 ——
-- 而掛錯了不會報錯，只會讓損益表的收入側冒出一列「保險費」。
-- ============================================================

create or replace function public.check_account_kind_income() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare k text; nm text;
begin
  if new.account_code is null then return new; end if;
  select kind, name into k, nm from account_codes where code = new.account_code;
  if k = 'expense' then
    raise exception '「%」是支出科目,不能計入收入。', coalesce(nm, new.account_code);
  end if;
  return new;
end $fn$;

/*
 * 命名讓它排在 trg_orders_account 之後（同時機的觸發器按名稱排序，a < k）——
 * 要先讓自動填把值寫好，才輪到守衛檢查。排在前面的話檢查的是舊值，等於沒檢查。
 */
drop trigger if exists trg_orders_kind_guard on public.orders;
create trigger trg_orders_kind_guard
  before insert or update on public.orders
  for each row execute function public.check_account_kind_income();


notify pgrst, 'reload schema';


-- ============================================================
-- 驗證
--
-- 包在 exception 裡：驗證失敗只發警告，不要把上面的變更整包回滾掉
-- （migration_76 就是那樣一夜白做）。
-- ============================================================

do $$
declare n int; t text;
begin
  select count(*) into n from information_schema.columns
   where table_schema = 'public' and table_name = 'orders' and column_name = 'account_code';
  if n = 1 then raise notice '✅ orders.account_code 已建立';
  else raise warning '❌ 欄位不存在'; return; end if;

  select count(*) into n from public.orders where account_code is null;
  if n = 0 then raise notice '✅ 每一筆訂單都計入會計科目了';
  else raise warning '❌ 還有 % 筆訂單沒有科目', n; end if;

  select count(*) into n from public.orders o
    join public.account_codes a on a.code = o.account_code
   where a.kind = 'expense';
  if n = 0 then raise notice '✅ 沒有收入計入支出專用科目';
  else raise warning '❌ 有 % 筆收入計入支出專用科目', n; end if;

  -- 既有科目一個都不該被改名 —— 這一版就是因為上一版改了名目才重寫的
  select name into t from public.account_codes where code = 'repair';
  if t = '修繕維護' then raise notice '✅ 修繕維護的名稱沒有被動到';
  else raise warning '❌ repair 的名稱變成「%」了,應該維持「修繕維護」', t; end if;
  select name into t from public.account_codes where code = 'utility';
  if t = '水電瓦斯' then raise notice '✅ 水電瓦斯的名稱沒有被動到';
  else raise warning '❌ utility 的名稱變成「%」了,應該維持「水電瓦斯」', t; end if;

  select count(*) into n from public.account_codes where code in ('parking', 'equipment');
  if n = 2 then raise notice '✅ 停車費與設備費兩個新科目都建好了';
  else raise warning '❌ 新科目只建了 % 個', n; end if;

  select count(*) into n from public.account_codes where kind in ('income', 'both');
  raise notice 'ℹ 收入可計入的科目 % 個', n;

exception when others then
  raise warning '驗證區出錯（上面的變更不受影響）:%', sqlerrm;
end $$;


-- ── 對應規則的逐條實測 ─────────────────────────────
--
-- **刻意不插假訂單去測。** orders 上還有 orders_recognize 與
-- trg_sync_order_deposits 兩個觸發器,插一筆會連帶產生營收認列與押金列;
-- 就算最後刪掉,中途出錯就會留下對不到訂單的孤兒資料。
--
-- 而且插一筆只測得到一條路徑。order_account_code() 是純函式（IMMUTABLE，
-- 不查表、無副作用），直接呼叫可以把**每一條分支**都走過,涵蓋度反而更高。
-- 觸發器本身只有一行 new.account_code := 該函式,另外驗它掛對位置就夠。

do $$
declare bad int := 0;
begin
  -- 名目那一側。錯一條就會有一整類收入計錯科目,而且報表看起來很正常。
  if public.order_account_code('oneoff', '水費')     <> 'utility'     then bad := bad + 1; raise warning '❌ 水費該計入水電瓦斯'; end if;
  if public.order_account_code('oneoff', '電費')     <> 'utility'     then bad := bad + 1; raise warning '❌ 電費該計入水電瓦斯'; end if;
  if public.order_account_code('oneoff', '瓦斯費')   <> 'utility'     then bad := bad + 1; raise warning '❌ 瓦斯費該計入水電瓦斯'; end if;
  if public.order_account_code('oneoff', '修繕費')   <> 'repair'      then bad := bad + 1; raise warning '❌ 修繕費該計入修繕維護'; end if;
  if public.order_account_code('oneoff', '網路費')   <> 'internet'    then bad := bad + 1; raise warning '❌ 網路費該計入網路第四台'; end if;
  if public.order_account_code('oneoff', '管理費')   <> 'mgmtfee'     then bad := bad + 1; raise warning '❌ 管理費'; end if;
  if public.order_account_code('oneoff', '清潔費')   <> 'cleaning'    then bad := bad + 1; raise warning '❌ 清潔費'; end if;
  if public.order_account_code('oneoff', '停車費')   <> 'parking'     then bad := bad + 1; raise warning '❌ 停車費'; end if;
  if public.order_account_code('oneoff', '設備費')   <> 'equipment'   then bad := bad + 1; raise warning '❌ 設備費'; end if;
  if public.order_account_code('oneoff', '其他')     <> 'other'       then bad := bad + 1; raise warning '❌ 其他'; end if;
  -- 保底：沒填、以及 migration_75 之前的舊值
  if public.order_account_code('oneoff', null)       <> 'other'       then bad := bad + 1; raise warning '❌ fee_type 空值'; end if;
  if public.order_account_code('oneoff', '取消費')   <> 'other'       then bad := bad + 1; raise warning '❌ 舊值取消費'; end if;
  if public.order_account_code('airbnb_cancelled', null) <> 'other'   then bad := bad + 1; raise warning '❌ Airbnb 取消'; end if;
  -- 租金收入那一側
  if public.order_account_code('longterm', null)     <> 'rent_income' then bad := bad + 1; raise warning '❌ 長租'; end if;
  if public.order_account_code('office',   null)     <> 'rent_income' then bad := bad + 1; raise warning '❌ 辦公室'; end if;
  if public.order_account_code('company',  null)     <> 'rent_income' then bad := bad + 1; raise warning '❌ 公司登記'; end if;
  if public.order_account_code('airbnb',   null)     <> 'rent_income' then bad := bad + 1; raise warning '❌ Airbnb'; end if;
  if public.order_account_code('agoda',    null)     <> 'rent_income' then bad := bad + 1; raise warning '❌ Agoda'; end if;
  if public.order_account_code('private',  null)     <> 'rent_income' then bad := bad + 1; raise warning '❌ 私下'; end if;
  if public.order_account_code('partner',  null)     <> 'rent_income' then bad := bad + 1; raise warning '❌ 搭檔'; end if;

  if bad = 0 then raise notice '✅ 20 條對應規則全部正確';
  else raise warning '❌ 有 % 條對應錯誤', bad; end if;

  -- 對應到的 code 一定要在主檔裡,否則外鍵會擋掉新訂單的寫入
  select count(*) into bad from (values
    ('utility'),('repair'),('internet'),('mgmtfee'),('cleaning'),
    ('parking'),('equipment'),('other'),('rent_income')) v(c)
   where not exists (select 1 from public.account_codes a where a.code = v.c);
  if bad = 0 then raise notice '✅ 對應到的科目全部存在於主檔';
  else raise warning '❌ 有 % 個對應到的科目不存在,新訂單會被外鍵擋下來', bad; end if;

exception when others then
  raise warning '對應規則實測出錯:%', sqlerrm;
end $$;


-- 觸發器掛對位置了嗎（順序：先自動填,再守衛檢查）
do $$
declare a text; b text;
begin
  select p.proname into a from pg_trigger t join pg_proc p on p.oid = t.tgfoid
   where t.tgname = 'trg_orders_account' and t.tgrelid = 'public.orders'::regclass;
  select p.proname into b from pg_trigger t join pg_proc p on p.oid = t.tgfoid
   where t.tgname = 'trg_orders_kind_guard' and t.tgrelid = 'public.orders'::regclass;
  if a = 'sync_order_account' and b = 'check_account_kind_income' then
    raise notice '✅ 兩個觸發器都掛好了,自動填排在守衛前面（a < k）';
  else raise warning '❌ 觸發器沒掛好：trg_orders_account=% / trg_orders_kind_guard=%', a, b; end if;
end $$;


-- ── 回填結果：各科目的收入分佈 ─────────────────────
select a.name as 計入科目, count(*) as 訂單數,
       to_char(coalesce(sum(o.amount), 0), 'FM999,999,999') as 金額
from public.orders o
join public.account_codes a on a.code = o.account_code
group by a.name, a.sort
order by count(*) desc;


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    raise notice '%', (select public.record_migration('91_order_account_code'));
  else
    raise notice '尚未建立 schema_migrations（migration_70），這支沒有被記錄';
  end if;
end $$;
