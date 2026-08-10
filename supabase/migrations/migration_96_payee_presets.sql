-- migration_96：常用收款對象（廠商帳號）主檔
--
-- ============================================================
-- 【要解決什麼】
--
-- 每開一張匯款的請款單，都要重打四個欄位：
--
--     銀行代碼 / 廠商收款帳號 / 公司名(戶名) / 統編
--
-- 同一家廠商一年開十幾張單，就重打十幾次。
-- **打錯的代價是錢匯到別的帳戶** —— 而且不會有任何跡象，
-- 要等對方說沒收到才知道，那時候錢已經出去了。
--
-- 存成主檔之後選一次就自動帶入，而且每一張單帶的是同一組數字。
--
--
-- ============================================================
-- 【為什麼不直接從歷史請款單挑】
--
-- 「上次那家怎麼填的」可以從既有的單撈出來，但那份清單裡
-- **正確的與打錯的混在一起**，而且看起來一模一樣。
-- 從歷史挑等於把打錯的那次繼續傳下去。
--
-- 主檔是「這一組是對的」的唯一來源，改一次全站跟著改。
--
--
-- ============================================================
-- 【不動 purchase_requests 的既有欄位】
--
-- 請款單仍然自己存 payee_bank_code / payee_account / payee_company / payee_tax_id
-- —— **刻意不改成外鍵**。
--
-- 請款單是歷史憑證：那張單當初匯到哪個帳戶，是既成事實。
-- 掛外鍵的話，主檔改了帳號，三年前那張單上顯示的帳號會跟著變，
-- 而銀行的匯款紀錄不會 —— 兩邊對不起來，卻沒有人說得出為什麼。
--
-- 主檔只負責「填的時候少打幾個字」，填完就脫鉤。


-- ============================================================
-- 1. 主檔
-- ============================================================

create table if not exists public.payee_presets (
  id          uuid primary key default gen_random_uuid(),
  -- 下拉裡顯示的名字。可以跟戶名不同（「愛皮旅行社」vs「愛皮旅行社有限公司」）
  label       text not null,
  bank_code   text,
  account     text not null,
  company     text,
  tax_id      text,
  note        text,
  sort        int  not null default 0,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.payee_presets is
  '常用收款對象。請款單匯款時選一次自動帶入四個欄位。'
  '**請款單不掛外鍵** —— 那張單當初匯到哪裡是既成事實,主檔之後改了不該回頭改歷史。';
comment on column public.payee_presets.label is
  '下拉顯示名。可以比戶名短,例如戶名「愛皮旅行社有限公司」顯示成「愛皮旅行社」。';
comment on column public.payee_presets.account is
  '帳號。不做格式檢查 —— 各銀行長度不同,而且有些會帶分隔符號。';

-- 統編格式跟契約那邊一致（migration 之前就有的規則）
alter table public.payee_presets drop constraint if exists payee_presets_tax_chk;
alter table public.payee_presets add constraint payee_presets_tax_chk
  check (tax_id is null or tax_id = '' or tax_id ~ '^[0-9]{8}$');

/*
 * 同一個帳號不要建兩次。
 *
 * 只擋啟用中的 —— 停用的舊帳號要留著（歷史單上看得到它的存在），
 * 而且同一家換過帳號時，新舊兩筆會短暫並存。
 */
create unique index if not exists payee_presets_account_uniq
  on public.payee_presets (account) where active;

create index if not exists payee_presets_sort_idx on public.payee_presets (sort, label);


-- ============================================================
-- 2. RLS
--
-- 讀：所有登入者（填請款單的人都要選得到）
-- 寫：會計、主管、總經理 —— 跟收付款帳號主檔同一組人。
--     一般人員不能改,因為改錯的後果是全站的單都匯到錯的帳戶。
-- ============================================================

alter table public.payee_presets enable row level security;

drop policy if exists pp_read on public.payee_presets;
create policy pp_read on public.payee_presets for select
  using (current_role_of() is not null);

drop policy if exists pp_write on public.payee_presets;
create policy pp_write on public.payee_presets for all
  using (current_role_of() = any (array['accountant', 'manager', 'super_admin']))
  with check (current_role_of() = any (array['accountant', 'manager', 'super_admin']));


-- ============================================================
-- 2b. 收付款帳號也開放給會計
--
-- 「權限管理」那一頁現在開放兩個分頁給會計：收付款帳號、常用帳號。
-- 但 payment_accounts 的寫入政策原本是 super_admin only ——
-- **前端開了而 RLS 沒開，會計按下去會靜靜地存不進去**：
-- Supabase 對 RLS 擋掉的 update 不回錯誤，只回「0 列受影響」，
-- 畫面看起來像成功，重新整理才發現沒改到。
--
-- 只加會計。manager 不需要 —— 他不碰付款主檔。
-- **不開放「權限管理」分頁**（改人員角色）：能改角色就能把自己改成總經理，
-- 而請款單的兩票制正是 manager 一票 + super_admin 一票。
-- ============================================================

drop policy if exists pay_acct_write on public.payment_accounts;
create policy pay_acct_write on public.payment_accounts for all
  using (current_role_of() = any (array['accountant', 'super_admin']))
  with check (current_role_of() = any (array['accountant', 'super_admin']));


-- ============================================================
-- 3. 【刻意不自動帶入既有資料】
--
-- 第一版有一段「從既有請款單把用過的帳號灌進來」。拿掉了。
--
-- 【為什麼拿掉】
-- 那段確實省事（一次帶出 21 組），但**歷史單裡填錯的東西也一起進來**。
-- 實際跑出來就有兩筆：
--
--     顯示名 8088          帳號 8088          ← 那是安幸自己的付款帳號代號,
--                                              被誤填進「廠商收款帳號」欄
--     悅晟環保有限公司籌備處  帳號 悅晟環保…    ← 帳號欄放的是公司名
--
-- 主檔的價值在於「**這一組是對的**」—— 混進沒人確認過的資料，
-- 它就只是另一份歷史清單，而且選下去會把錯的值帶進新單。
--
-- 所以改成由會計自己一筆一筆建：
-- 「權限管理 → 常用帳號 → + 新增」。建進來的每一筆都是有人看過的。
--
-- 要臨時查歷史單填過什麼，用這個（只讀，不寫進主檔）：
--
--   select distinct on (payee_account)
--          payee_company as 戶名, payee_bank_code as 銀行代碼,
--          payee_account as 帳號, payee_tax_id as 統編, created_at as 最近使用
--     from purchase_requests
--    where payment_method = 'transfer' and coalesce(trim(payee_account),'') <> ''
--    order by payee_account, created_at desc;
-- ============================================================


-- ============================================================
-- 驗證
--
-- 包在 exception 裡：驗證失敗只發警告，不要把上面的變更整包回滾掉。
-- ============================================================

do $$
declare n int;
begin
  select count(*) into n from information_schema.tables
   where table_schema = 'public' and table_name = 'payee_presets';
  if n = 1 then raise notice '✅ payee_presets 已建立';
  else raise warning '❌ 表不存在'; return; end if;

  select count(*) into n from pg_tables
   where schemaname = 'public' and tablename = 'payee_presets' and rowsecurity;
  if n = 1 then raise notice '✅ RLS 已啟用';
  else raise warning '❌ RLS 沒開'; end if;

  select count(*) into n from pg_indexes
   where schemaname = 'public' and indexname = 'payee_presets_account_uniq';
  if n = 1 then raise notice '✅ 帳號唯一索引已建立（只擋啟用中的）';
  else raise warning '❌ 唯一索引不存在,同一個帳號會被建兩次'; end if;

  select count(*) into n from public.payee_presets;
  if n = 0 then
    raise notice 'ℹ 常用帳號目前是空的 —— 這是刻意的。'
                 '請到「權限管理 → 常用帳號」由會計逐筆建立,'
                 '主檔裡的每一組都要是有人確認過的。';
  else
    raise notice 'ℹ 目前有 % 組常用帳號', n;
  end if;

  -- 帶出來的資料有沒有缺戶名（下拉會不好認）
  -- 收付款帳號的寫入政策有沒有放行會計
  select count(*) into n from pg_policies
   where schemaname = 'public' and tablename = 'payment_accounts'
     and policyname = 'pay_acct_write' and qual like '%accountant%';
  if n = 1 then raise notice '✅ 收付款帳號已開放給會計編輯';
  else raise warning '❌ payment_accounts 的寫入政策沒放行會計 —— 畫面開了但會靜靜存不進去'; end if;

  select count(*) into n from pg_policies
   where schemaname = 'public' and tablename = 'payee_presets' and policyname = 'pp_write';
  if n = 1 then raise notice '✅ 常用帳號的寫入政策已建立（會計/主管/總經理）';
  else raise warning '❌ payee_presets 沒有寫入政策'; end if;


exception when others then
  raise warning '驗證區出錯（上面的變更不受影響）:%', sqlerrm;
end $$;


-- ── 目前的常用帳號（第一次跑會是空的,由會計自己建）──────
select label as 顯示名, bank_code as 銀行代碼, account as 帳號,
       company as 戶名, tax_id as 統編, active as 啟用中
from public.payee_presets
order by sort, label;


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    raise notice '%', (select public.record_migration('96_payee_presets'));
  else
    raise notice '尚未建立 schema_migrations（migration_70），這支沒有被記錄';
  end if;
end $$;
