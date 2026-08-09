-- migration_90：會計科目分收入／支出，並正名租金科目
--
-- ============================================================
-- 【要解決什麼】
--
-- 會計科目主檔到今天為止**只有支出**。20 個科目全部是花錢的方向，
-- 營收那邊從來沒有接上科目 —— 訂單只靠 source（airbnb/longterm/office…）
-- 與 fee_type 分類，會計要出損益表時得自己在 Excel 裡對一次。
--
-- 這一支是把收入接進來的第一步：**先把「方向」這個概念建進主檔**，
-- 並補上第一個收入科目。訂單自動帶科目留到下一支。
--
--
-- ============================================================
-- 【為什麼一定要先有 kind，不能只是 insert 一筆收入科目】
--
-- 支出頁與請款單的科目下拉是直接
--
--     select code, name from account_codes order by sort
--
-- 全撈。這時候塞一個「租金收入」進去，它會**立刻出現在支出的下拉裡**，
-- 使用者可以把一筆支出歸到「租金收入」底下 ——
-- 而那筆錢會在支出報表裡以「租金收入」為名出現，看起來像資料庫壞掉。
--
-- 所以 kind 跟 rent_income 必須同一支進去，不能分兩次。
--
--
-- ============================================================
-- 【正名】
--
--     rent  房租支出 → 租金支出
--     新增  rent_income 租金收入
--
-- 《商業會計處理準則》的科目是「租金收入／租金支出」，「房租」是口語。
-- 送給記帳士或報稅時用標準名稱可以少解釋很多次。
--
-- **只改 name，不改 code。** 既有支出是靠 code 掛著的
-- （expenses.account_code → account_codes.code 有外鍵），
-- 改 code 會讓所有既有支出對不到科目 —— migration_46 改「差旅交通」時
-- 就是走這條路，這裡沿用。


-- ============================================================
-- 1. 方向欄位
--
-- 用單一 kind 而不是 for_income / for_expense 兩個布林：
-- 兩個布林可以同時是 false，那是一個沒有意義卻存得進去的狀態。
-- kind 只有三個合法值，寫不出無意義的組合。
-- ============================================================

alter table public.account_codes
  add column if not exists kind text not null default 'expense';

-- 既有 20 個科目全部是支出，default 已經處理掉。
-- 但如果這支被重跑、或有人手動塞了怪值，先正規化再上約束 ——
-- 不然 add constraint 會失敗，而 Supabase SQL Editor 是單一交易，
-- 一個錯誤整支回滾。
update public.account_codes
   set kind = 'expense'
 where kind is null or kind not in ('expense', 'income', 'both');

alter table public.account_codes drop constraint if exists account_codes_kind_chk;
alter table public.account_codes add constraint account_codes_kind_chk
  check (kind in ('expense', 'income', 'both'));

comment on column public.account_codes.kind is
  'expense=只用於支出 / income=只用於收入 / both=兩邊都用（例如清潔費：跟房客收是收入，付清潔公司是支出）。'
  '同一個科目兩用是正常的會計做法 —— 報表上收付各站一邊，不必拆成兩個科目。';


-- ============================================================
-- 2. 正名 + 新增租金收入
-- ============================================================

update public.account_codes set name = '租金支出' where code = 'rent';

-- sort 從 1000 起跳，跟支出科目（10～900）分開。
-- 混在一起的話，之後補其他收入科目要一直重算間距。
insert into public.account_codes (code, name, sort, active, kind) values
  ('rent_income', '租金收入', 1000, true, 'income')
on conflict (code) do update
  set name = excluded.name, kind = excluded.kind, active = true;


-- ============================================================
-- 3. 不讓收入科目被掛到支出上
--
-- 前端下拉會過濾掉，但前端擋不住 API、匯入、或下一個寫程式的人。
-- 而掛錯了不會報錯，只會讓支出報表裡冒出一列「租金收入」，
-- 沒有人知道那是怎麼進去的。
--
-- 只擋 kind='income'。'both' 是刻意設計成兩邊都能用的。
-- ============================================================

create or replace function public.check_account_kind_expense() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare k text; nm text;
begin
  if new.account_code is null then return new; end if;
  select kind, name into k, nm from account_codes where code = new.account_code;
  if k = 'income' then
    raise exception '「%」是收入科目,不能用在支出上。', coalesce(nm, new.account_code);
  end if;
  return new;
end $fn$;

/*
 * 觸發器命名刻意讓它排在 trg_expense_child_sync 前面（a < c）。
 *
 * 同一時機的觸發器按名稱排序執行。排在前面時，遞延子單插入的當下
 * account_code 還是 null（母單的值要等 child_sync 才繼承過來），
 * 直接放行 —— 而母單那筆早就驗過了，不會漏。
 * 排在後面也安全（繼承來的值同樣合法），這裡選前者只是為了少一次查表。
 */
drop trigger if exists trg_expense_account_kind on public.expenses;
create trigger trg_expense_account_kind
  before insert or update on public.expenses
  for each row execute function public.check_account_kind_expense();

drop trigger if exists trg_pri_account_kind on public.purchase_request_items;
create trigger trg_pri_account_kind
  before insert or update on public.purchase_request_items
  for each row execute function public.check_account_kind_expense();


-- PostgREST 要重讀 schema，前端才看得到 kind 這一欄
notify pgrst, 'reload schema';


-- ============================================================
-- 驗證
--
-- 包在 exception 裡：驗證失敗只發警告，不要把上面的 schema 變更
-- 整包回滾掉（migration_76 就是那樣一夜白做）。
-- ============================================================

do $$
declare n int; t text;
begin
  select count(*) into n from information_schema.columns
   where table_schema = 'public' and table_name = 'account_codes' and column_name = 'kind';
  if n = 1 then raise notice '✅ account_codes.kind 已建立';
  else raise warning '❌ kind 欄位不存在'; return; end if;

  -- 約束存在，而且三個值都在裡面
  select pg_get_constraintdef(oid) into t from pg_constraint
   where conname = 'account_codes_kind_chk';
  if t is not null and position('income' in t) > 0 and position('both' in t) > 0 then
    raise notice '✅ kind 的值域約束已建立';
  else raise warning '❌ account_codes_kind_chk 不存在或值域不對'; end if;

  select name into t from public.account_codes where code = 'rent';
  if t = '租金支出' then raise notice '✅ rent 已正名為「租金支出」';
  else raise warning '❌ rent 的名稱是「%」,不是「租金支出」', t; end if;

  select kind into t from public.account_codes where code = 'rent_income';
  if t = 'income' then raise notice '✅ rent_income「租金收入」已建立,方向 = 收入';
  else raise warning '❌ rent_income 不存在或方向不對（目前 %）', t; end if;

  -- 既有支出一筆都不該被動到 —— code 沒改，外鍵沒斷
  select count(*) into n from public.expenses e
   where e.account_code is not null
     and not exists (select 1 from public.account_codes a where a.code = e.account_code);
  if n = 0 then raise notice '✅ 既有支出的科目全部對得到（沒有孤兒）';
  else raise warning '❌ 有 % 筆支出的科目對不到主檔', n; end if;

  select count(*) into n from public.expenses where account_code = 'rent';
  raise notice 'ℹ 目前掛在「租金支出」的支出有 % 筆（名稱改了,歸屬不變）', n;

  select count(*) into n from public.account_codes where kind = 'expense';
  raise notice 'ℹ 支出科目 % 個', n;
  select count(*) into n from public.account_codes where kind in ('income', 'both');
  raise notice 'ℹ 收入可用科目 % 個', n;

exception when others then
  raise warning '驗證區出錯（schema 變更不受影響）:%', sqlerrm;
end $$;


-- ── 收入科目擋支出的實測 ───────────────────────────
--
-- 只讀系統目錄驗證不到「觸發器真的會擋」—— 觸發器是程序碼，
-- 要跑過才知道（migration_65 就是這樣漏掉的）。
--
-- 整段在 savepoint 裡做，而且**插的是一筆全新的假資料，不碰任何既有列**。
-- 結尾一定 rollback to savepoint，資料庫不留痕跡。

do $$
declare blocked boolean := false;
begin
  begin
    insert into public.expenses (spent_on, amount, account_code, purpose_type, item_name)
    values (current_date, 1, 'rent_income', 'office', '__kind_probe__');
    -- 走到這行代表沒被擋下來
  exception when others then
    if sqlerrm like '%收入科目%' then blocked := true;
    else raise warning '被擋下來了,但錯誤訊息不是預期的:%', sqlerrm; blocked := true;
    end if;
  end;

  if blocked then raise notice '✅ 收入科目掛到支出上會被擋下來';
  else raise warning '❌ 收入科目沒有被擋,支出可以歸到「租金收入」底下'; end if;

  -- 保險：萬一真的插進去了（沒被擋），把它刪掉,不要留假資料
  delete from public.expenses where item_name = '__kind_probe__';

exception when others then
  raise warning '擋收入科目的實測出錯:%', sqlerrm;
  delete from public.expenses where item_name = '__kind_probe__';
end $$;


-- ── 目前的科目表 ───────────────────────────────────
select kind, code, name, sort, active
from public.account_codes
order by case kind when 'expense' then 1 when 'both' then 2 else 3 end, sort, code;


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    raise notice '%', (select public.record_migration('90_account_kind'));
  else
    raise notice '尚未建立 schema_migrations（migration_70），這支沒有被記錄';
  end if;
end $$;
