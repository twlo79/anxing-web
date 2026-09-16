/*
 * migration_258_social_ig.sql　2026-09-16
 * 社群經營：IG 版面模擬
 *
 * 【怎麼跑】整份貼進 Supabase SQL Editor，看最後那張自檢表。
 *          ★ 看不到自檢的表格＝失敗了，把錯誤訊息整段貼回來。
 *          ★★ 這支會**自己驗自己**:真的建一個帳號、一張跨 3 格的切圖、
 *            三則貼文，確認約束擋得住該擋的，然後全部退掉。
 *            通不過的話**連前面的 DDL 一起回滾** —— 不會留下半套。
 *
 * ══════════════════════════════════════════════════════════
 * 【為什麼】
 *
 * 使用者 2026-09-16：「多一個社群經營，裡面是 IG 模擬器，
 * 模擬 IG 的版面去放照片與文案，可以直接看感覺。」
 * 後續指定：併進客戶經營、多個模擬頁、切圖（跨 3／6 格）、釘選。
 *
 * ══════════════════════════════════════════════════════════
 * 【★★★ 三張表而不是一張，理由在「一張切圖 ＝ N 則貼文」】
 *
 *   social_accounts  一列 ＝ 一個模擬頁（ESTIA、安幸上工⋯）
 *   social_posts     一列 ＝ **一格**，也就是實際要貼出去的一則
 *   social_splits    一列 ＝ 一張原圖，被切成 N 格
 *
 * 切圖不是「一則貼文佔三格」—— 那樣的話文案只有一份，
 * 而實際上要貼三次、三則各自有自己的文案與日期。
 * 所以切圖是**母體**，三則貼文各自掛上去（split_id ＋ split_index）。
 *
 * ══════════════════════════════════════════════════════════
 * 【★★ RLS 建表時就寫，不要留到下一支】
 *
 * Supabase 的 rls_auto_enable() 會自動幫新表開 RLS，而沒有 policy
 * 等於全部擋掉 —— 查詢**回成功、0 列**，不報錯。
 * 症狀是一個很正常的空九宮格（README 坑 C，migration_206 踩過）。
 *
 * ══════════════════════════════════════════════════════════
 * 【★ 這支不動任何既有的表】
 *
 * 三張新表 ＋ 一個新 bucket，其餘一個字都沒碰。
 * 跑壞了最多就是這個功能不能用，不會影響收租、支出、押金。
 */

/*
 * ★★★ 暫存表建在 begin 之前（README 3.7）——
 *   建在裡面的話，自檢沒過而整支回滾時這張表也跟著消失，
 *   最後那段 select 會變成「relation does not exist」，
 *   而那句錯誤會蓋掉我真正想讓人看到的失敗原因。
 */
create temp table if not exists _m258_test (ord int, name text, detail text, verdict text);

begin;

/* ══════════════════════════════════════════════════════════
 * ① social_accounts：一列一個模擬頁
 * ══════════════════════════════════════════════════════════ */

create table if not exists public.social_accounts (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  handle      text not null,
  bio         text,
  sort        int  not null default 0,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  created_by  uuid default auth.uid()
);

/*
 * ★★ 個人檔案的頭也要改得動（2026-09-16 使用者:「這些都可以再編輯」）。
 *
 *   建立的時候填一次、之後改不了的話，打錯字就只能砍掉重建 ——
 *   而砍掉會連同底下所有的貼文一起 cascade 掉。
 *
 * ★ 追蹤者用 **text 不是數字**。這一頁沒有連 IG,那兩個數字純粹是
 *   「讓這面牆看起來像 IG」的裝飾 —— 而使用者想打的可能是「12.3萬」。
 *   存成整數的話，那種寫法存不進去,然後他得自己換算成 123000,
 *   而畫面上又會顯示成 123000 —— 兩邊都不是他要的。
 *
 * ★★ `add column if not exists` —— 這支整份是可以重跑的。
 *   已經跑過 258 的人再跑一次就會補上這三欄,不用另外開一支。
 */
alter table public.social_accounts add column if not exists avatar_path text;
alter table public.social_accounts add column if not exists followers   text;
alter table public.social_accounts add column if not exists following   text;

comment on table public.social_accounts is
  'IG 版面模擬的「模擬頁」（migration_258）。一列 ＝ 一個要模擬的 IG 帳號。'
  '★ 這裡**沒有任何真的 IG 授權** —— followers / following 是使用者自己打的裝飾，'
  '  不是從 IG 讀來的。所以是 text 不是數字（「12.3萬」也要存得進去）。';

create unique index if not exists social_accounts_handle_uidx
  on public.social_accounts (lower(handle));

alter table public.social_accounts enable row level security;


/* ══════════════════════════════════════════════════════════
 * ② social_splits：一張被切開的原圖
 * ══════════════════════════════════════════════════════════ */

create table if not exists public.social_splits (
  id          uuid primary key default gen_random_uuid(),
  account_id  uuid not null references public.social_accounts(id) on delete cascade,
  /* storage 裡那張**原圖**的路徑。切片是前端用 canvas 當場切的,不另外存 */
  source_path text,
  span        int not null,
  created_at  timestamptz not null default now(),
  created_by  uuid default auth.uid()
);

/*
 * ★★ span 只能是 3／6／9。
 *   用 check 鎖住而不是只在前端擋 —— 前端擋是為了不讓人按，
 *   資料庫擋是因為前端總有一天會被繞過（README 坑 A:
 *   同一條規則寫在兩個地方，只改了一邊）。
 *
 * ★ 為什麼是 3 的倍數:九宮格一排三格，切圖必須佔滿整排。
 *   跨 2 格或 4 格的話，它一定會在某一排斷掉。
 */
alter table public.social_splits drop constraint if exists social_splits_span_chk;
alter table public.social_splits add constraint social_splits_span_chk
  check (span in (3, 6, 9));

comment on table public.social_splits is
  '切圖:一張原圖切成 N 格貼出去（migration_258）。'
  '★ 切片本身不存 —— 前端用 canvas 從原圖當場切，'
  '  存一份切片等於同一張圖存兩次，改了原圖切片會留在舊的。';

alter table public.social_splits enable row level security;


/* ══════════════════════════════════════════════════════════
 * ③ social_posts：一列 ＝ 一格 ＝ 實際要貼的一則
 * ══════════════════════════════════════════════════════════ */

create table if not exists public.social_posts (
  id           uuid primary key default gen_random_uuid(),
  account_id   uuid not null references public.social_accounts(id) on delete cascade,
  /*
   * 版面順序。★ **小的在前面（左上角）＝ 最新的那一則**。
   *   不用日期排 —— 草稿還沒有日期，而沒有日期的東西排不出順序。
   */
  sort         int  not null default 0,
  caption      text not null default '',
  /* storage 路徑。切圖的那幾則是 null —— 圖在 social_splits.source_path */
  image_path   text,
  planned_on   date,
  published_on date,
  status       text not null default 'draft',
  /*
   * 釘選。0 ＝ 沒釘，1〜3 ＝ 第幾個。
   * ★ IG 上限是 3 **格**（不是 3 筆）—— 一張跨 3 格的切圖會用掉整個額度。
   *   格數的加總擋在前端（lib/social-grid.ts 的 canPin），
   *   這裡只擋「單一筆的 pin 值合不合法」:資料庫看不到「格」這個概念。
   */
  pin          int  not null default 0,
  split_id     uuid references public.social_splits(id) on delete cascade,
  split_index  int,
  created_at   timestamptz not null default now(),
  created_by   uuid default auth.uid(),
  deleted_at   timestamptz
);

alter table public.social_posts drop constraint if exists social_posts_status_chk;
alter table public.social_posts add constraint social_posts_status_chk
  check (status in ('draft', 'scheduled', 'published'));

alter table public.social_posts drop constraint if exists social_posts_pin_chk;
alter table public.social_posts add constraint social_posts_pin_chk
  check (pin between 0 and 3);

/*
 * ★★★ 切圖的兩個欄位**要嘛都有、要嘛都沒有**。
 *
 *   只有 split_id 沒有 split_index → 不知道這是第幾張，接縫拼不起來
 *   只有 split_index 沒有 split_id → 一個指向不存在的母體的索引
 *
 *   兩種都不會報錯，只會讓某一格畫出一張錯位的圖 ——
 *   而錯位的圖在九宮格上看起來就只是「這張照片怪怪的」。
 */
alter table public.social_posts drop constraint if exists social_posts_split_pair_chk;
alter table public.social_posts add constraint social_posts_split_pair_chk
  check ((split_id is null and split_index is null)
      or (split_id is not null and split_index is not null and split_index >= 0));

/* 同一張切圖的同一格不可以有兩則 —— 有的話那一格會畫兩次而少畫一格 */
create unique index if not exists social_posts_split_uidx
  on public.social_posts (split_id, split_index)
  where split_id is not null and deleted_at is null;

create index if not exists social_posts_acc_idx
  on public.social_posts (account_id, sort)
  where deleted_at is null;

comment on table public.social_posts is
  'IG 版面模擬的一格（migration_258）。一列 ＝ 一則實際要貼出去的貼文。'
  '★ 跨 N 格的切圖是 **N 列**,不是一列 —— 各自有文案與日期。'
  '★★ sort 小的在左上角（最新）。釘選只改版面位置,不改 sort,'
  '  所以「第幾則貼的」這件事不會因為釘選而變。';

alter table public.social_posts enable row level security;


/* ══════════════════════════════════════════════════════════
 * ④ RLS：誰看得到、誰改得動
 *
 * ★ 讀：管家以上都看得到（社群是大家一起想的）
 * ★ 寫：主管、總管理員（跟「房源評價」同一層 —— 它們同一群）
 * ★★ 用 current_role_of()，跟全站其他表同一支 —— 不要自己再查 profiles
 * ══════════════════════════════════════════════════════════ */

do $do$ begin
  create policy social_accounts_read on public.social_accounts
    for select using (
      current_role_of() = any (array['housekeeper','accountant','manager','super_admin'])
    );
exception when duplicate_object then null; end $do$;

do $do$ begin
  create policy social_accounts_write on public.social_accounts
    for all using (
      current_role_of() = any (array['manager','super_admin'])
    ) with check (
      current_role_of() = any (array['manager','super_admin'])
    );
exception when duplicate_object then null; end $do$;

do $do$ begin
  create policy social_splits_read on public.social_splits
    for select using (
      current_role_of() = any (array['housekeeper','accountant','manager','super_admin'])
    );
exception when duplicate_object then null; end $do$;

do $do$ begin
  create policy social_splits_write on public.social_splits
    for all using (
      current_role_of() = any (array['manager','super_admin'])
    ) with check (
      current_role_of() = any (array['manager','super_admin'])
    );
exception when duplicate_object then null; end $do$;

do $do$ begin
  create policy social_posts_read on public.social_posts
    for select using (
      current_role_of() = any (array['housekeeper','accountant','manager','super_admin'])
    );
exception when duplicate_object then null; end $do$;

do $do$ begin
  create policy social_posts_write on public.social_posts
    for all using (
      current_role_of() = any (array['manager','super_admin'])
    ) with check (
      current_role_of() = any (array['manager','super_admin'])
    );
exception when duplicate_object then null; end $do$;


/* ══════════════════════════════════════════════════════════
 * ⑤ storage：social bucket
 *
 * ★★ 私有 bucket，看圖用簽名網址 —— 跟請款單附件同一套機制
 *   （components/Receipts.tsx）。不自己再寫一份。
 * ★ 路徑約定 {account_id}/{時間}_{檔名}。
 *   ★★ 這裡的 policy **只看角色，不讀路徑** —— 跟請款單附件那套不一樣。
 *     那邊要分「哪一筆的附件誰看得到」，這邊整個 bucket 就是社群素材，
 *     看得到這一頁的人本來就看得到全部。路徑的第一段是給人整理用的，
 *     不是權限的一部分 —— 寫成「policy 靠它擋」的話，
 *     以後有人改路徑格式會以為自己打開了一個洞（其實沒有），
 *     或反過來以為改了路徑就擋得住（其實擋不住）。
 * ══════════════════════════════════════════════════════════ */

insert into storage.buckets (id, name, public, file_size_limit)
values ('social', 'social', false, 26214400)     -- 25 MB:跨 9 格的原圖會不小
on conflict (id) do nothing;

do $do$ begin
  create policy social_obj_read on storage.objects
    for select using (
      bucket_id = 'social'
      and current_role_of() = any (array['housekeeper','accountant','manager','super_admin'])
    );
exception when duplicate_object then null; end $do$;

do $do$ begin
  create policy social_obj_write on storage.objects
    for insert with check (
      bucket_id = 'social'
      and current_role_of() = any (array['manager','super_admin'])
    );
exception when duplicate_object then null; end $do$;

do $do$ begin
  create policy social_obj_del on storage.objects
    for delete using (
      bucket_id = 'social'
      and current_role_of() = any (array['manager','super_admin'])
    );
exception when duplicate_object then null; end $do$;


/* ══════════════════════════════════════════════════════════
 * ⑥ 自己驗自己：過不了就連 DDL 一起回滾
 *
 * ★★ 驗的是「約束擋不擋得住該擋的」，不是「這次跑做了什麼」
 *   （README 3 與坑，自檢跑第二次、第十次答案要一樣）。
 * ══════════════════════════════════════════════════════════ */

do $do$
declare
  v_acc   uuid;
  v_split uuid;
  v_n     int;
  v_blocked text := '';
  v_ok    boolean := false;
  v_err   text := '';
begin
  begin
    /* 子交易：整段測完就退掉，一列資料都不留 */
    insert into public.social_accounts (name, handle, bio)
    values ('_m258 測試頁', '_m258_probe', '自檢用，會被退掉')
    returning id into v_acc;

    insert into public.social_splits (account_id, span) values (v_acc, 3)
    returning id into v_split;

    insert into public.social_posts (account_id, sort, caption, split_id, split_index)
    select v_acc, g, '第 ' || g || ' 張', v_split, g from generate_series(0, 2) g;

    select count(*) into v_n from public.social_posts where account_id = v_acc;

    /* (a) span 只能是 3／6／9 */
    begin
      insert into public.social_splits (account_id, span) values (v_acc, 4);
      v_blocked := v_blocked || '❌ span=4 竟然存得進去　';
    exception when check_violation then
      v_blocked := v_blocked || '✅ span=4 擋住　';
    end;

    /* (b) status 只能是三個值 */
    begin
      insert into public.social_posts (account_id, status) values (v_acc, 'posted');
      v_blocked := v_blocked || '❌ status=posted 竟然存得進去　';
    exception when check_violation then
      v_blocked := v_blocked || '✅ 亂寫的 status 擋住　';
    end;

    /* (c) pin 只能 0〜3 */
    begin
      insert into public.social_posts (account_id, pin) values (v_acc, 4);
      v_blocked := v_blocked || '❌ pin=4 竟然存得進去　';
    exception when check_violation then
      v_blocked := v_blocked || '✅ pin=4 擋住　';
    end;

    /* (d) 切圖的兩個欄位不准只有一半 */
    begin
      insert into public.social_posts (account_id, split_id) values (v_acc, v_split);
      v_blocked := v_blocked || '❌ 只有 split_id 沒有 index 竟然存得進去　';
    exception when check_violation then
      v_blocked := v_blocked || '✅ 半套的切圖欄位擋住　';
    end;

    /* (e) 同一張切圖的同一格不准有兩則 */
    begin
      insert into public.social_posts (account_id, split_id, split_index)
      values (v_acc, v_split, 0);
      v_blocked := v_blocked || '❌ 同一格存了兩則　';
    exception when unique_violation then
      v_blocked := v_blocked || '✅ 同一格的第二則擋住';
    end;

    v_ok := (v_n = 3) and (position('❌' in v_blocked) = 0);

    /* 退掉整段測試 —— 連帶 cascade 掉 split 與 posts */
    raise exception 'M258_ROLLBACK';

  exception
    when others then
      if sqlerrm <> 'M258_ROLLBACK' then
        v_err := sqlerrm;
      end if;
  end;

  if v_err <> '' then
    raise exception '自檢沒過:建測試資料時出錯 —— %　（整支已回滾，schema 沒有改動）', v_err;
  end if;
  if not v_ok then
    raise exception '自檢沒過:切圖建了 % 列（該是 3）／約束檢查 %。整支已回滾。', v_n, v_blocked;
  end if;

  insert into _m258_test values
    (5, '⑤ 活體測試：建帳號 ＋ 跨 3 格切圖 ＋ 3 則（已退掉）',
     v_blocked, '✅ 該擋的都擋住了');
end $do$;

commit;


/* ── 自檢表 ─────────────────────────────────────────────── */

select v.ord, v."檢查", v."結果", v."判定" from (

  select 1, '① 三張表都建起來了',
         coalesce((select string_agg(table_name, '、' order by table_name)
                     from information_schema.tables
                    where table_schema = 'public'
                      and table_name in ('social_accounts','social_splits','social_posts')),
                  '★ 一張都沒有'),
         case when (select count(*) from information_schema.tables
                     where table_schema = 'public'
                       and table_name in ('social_accounts','social_splits','social_posts')) = 3
              then '✅ 3/3' else '❌' end

  union all
  /*
   * ★★★ 這一條最重要。沒有 policy 的新表查詢**回成功、0 列**不報錯 ——
   *   畫面上會是一個很正常的空九宮格，而沒有任何地方會叫
   *   （README 坑 C，migration_206 踩過同一件事）。
   */
  select 2, '② RLS policy（三張表各兩條）',
         coalesce((select string_agg(tablename || '.' || policyname, '　' order by policyname)
                     from pg_policies
                    where schemaname = 'public'
                      and tablename in ('social_accounts','social_splits','social_posts')),
                  '★ 一條都沒有'),
         case when (select count(*) from pg_policies
                     where schemaname = 'public'
                       and tablename in ('social_accounts','social_splits','social_posts')) = 6
              then '✅ 6/6' else '❌ 少了幾條就是那張表全部讀不到' end

  union all
  /* ★ 個人檔案的頭要改得動 —— 這三欄是 2026-09-16 補的,重跑這支就會有 */
  select 2.5, '②-2 模擬頁的頭：頭像／追蹤者／追蹤中',
         coalesce((select string_agg(column_name || ' ' || data_type, '　' order by column_name)
                     from information_schema.columns
                    where table_schema = 'public' and table_name = 'social_accounts'
                      and column_name in ('avatar_path','followers','following')),
                  '★ 一欄都沒有'),
         case when (select count(*) from information_schema.columns
                     where table_schema = 'public' and table_name = 'social_accounts'
                       and column_name in ('avatar_path','followers','following')) = 3
              then '✅ 3/3' else '❌' end

  union all
  select 3, '③ 約束：span／status／pin／切圖成對',
         coalesce((select string_agg(conname, '　' order by conname) from pg_constraint
                    where conname in ('social_splits_span_chk','social_posts_status_chk',
                                      'social_posts_pin_chk','social_posts_split_pair_chk')),
                  '★ 一條都沒有'),
         case when (select count(*) from pg_constraint
                     where conname in ('social_splits_span_chk','social_posts_status_chk',
                                       'social_posts_pin_chk','social_posts_split_pair_chk')) = 4
              then '✅ 4/4' else '❌' end

  union all
  select 4, '④ storage bucket（私有）',
         coalesce((select 'social　public=' || public::text || '　上限 '
                          || coalesce((file_size_limit/1048576)::text || ' MB', '未設')
                     from storage.buckets where id = 'social'), '★ 沒有這個 bucket'),
         case when exists (select 1 from storage.buckets where id = 'social' and public = false)
              then '✅ 有,而且是私有的'
              when exists (select 1 from storage.buckets where id = 'social')
              then '❌ 建起來了但**是公開的** —— 照片會裸奔'
              else '❌ 沒建起來' end

  union all
  select t.ord, t.name, t.detail, t.verdict from _m258_test t

  union all
  /*
   * ⑥ 既有資料一列都不該多出來。這支只建空表 ——
   *   有資料的話代表這不是第一次跑，那是正常的，數字給人看就好。
   */
  select 6, '⑥ 目前有幾個模擬頁 / 幾格',
         (select coalesce((select count(*)::text from public.social_accounts), '0')
                 || ' 個模擬頁　'
                 || coalesce((select count(*)::text from public.social_posts
                               where deleted_at is null), '0') || ' 格'),
         case when (select count(*) from public.social_accounts) = 0
              then '✅ 空的（第一次跑）'
              else '✅ 已經有資料（這不是第一次跑，正常）' end

) as v(ord, "檢查", "結果", "判定")
order by v.ord;
