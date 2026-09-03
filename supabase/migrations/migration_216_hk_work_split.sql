/*
 * migration_216 —— hk_work_split：一份工的支出拆成多間
 * ============================================================
 * 2026-09-03 使用者：「我想要在表單上呈現一項 然後支出拆成多間」
 *
 * 庭玉 08-14 在正隆掃了 4B3、13A5、14B1 三間，工作量算一半。
 * 排班表上是一格：代碼「正隆多間」、間數 0.5。
 * 但那筆錢要記到三個房源頭上，各 1,500。
 *
 *   工單（排班表看到的）   一筆    正隆多間・0.5 間
 *   支出（帳上看到的）     三筆    4B3 $1,500、13A5 $1,500、14B1 $1,500
 *
 * ★★★ **拆的是錢，不是工作量。**
 *   打掃量、報酬點數、床單全部走原本那一筆（0.5 間、床單手填）。
 *   這張表一列都不參與那些計算。
 *
 * ============================================================
 * 【★★★ 為什麼綁「工的身分」而不是 hk_work_item.id】
 *
 * 兩個人合掃是**兩列** `hk_work_item`，而那是同一份工。
 * 綁到其中一列的話，那列被重新匯入／改人時拆帳就跟著不見，
 * 而另一列還在 —— 畫面上看起來只是「錢突然少了」，沒有錯誤。
 *
 * 所以綁的是（work_date, job_code, work_type），
 * 跟 `estateLog()` 合併同一份工的依據**一模一樣**。
 * 兩邊不一致的話拆帳會對不到那份工而安靜地不生效
 * （`src/lib/work-split.test.ts` 有一條專門釘這件事）。
 *
 * ★ 代價：這不是外鍵。工單被刪掉時拆帳列會留下來變孤兒，
 *   而**這是刻意的** —— 已經產生的支出不該因為工單被改而消失
 *   （錢付了就是付了）。孤兒要靠畫面列出來讓人決定。
 *
 * ============================================================
 * 【★★ 支出的冪等鍵是 `split:<id>`】
 *
 * 一般工單的鍵是「日期│房源id│工作類型」。拆帳**不能照抄**：
 * 同一天同一間如果另外還有一份正常工單就會組出同一個鍵，
 * 而 `expenses.hk_job_key` 有唯一索引 —— 第二筆被**安靜地跳過**。
 * 症狀是帳少一筆，而畫面上一切正常。
 *
 * ★ 所以用這張表的 uuid 加前綴。id 不會變，改金額時認得回是同一筆。
 *
 * ============================================================
 * 【★★★ 建表一定要跟著寫 RLS policy】
 *
 * Supabase 的 `rls_auto_enable()` 會自動幫新表開 RLS，
 * 而沒有 policy 等於全部擋掉 —— 查詢**回成功、0 列**。
 * migration_206 就是這樣讓六筆人事費一筆都讀不到（208 才修）。
 *
 * 給誰：跟房務其他表一致 —— accountant／manager／super_admin。
 *
 * ============================================================
 * 【怎麼跑】整份貼進 Supabase SQL Editor，看最後那張表。
 *
 * ★ 這一支**只建結構，一列資料都不寫**。
 *   08-14 正隆那三筆要拆多少，等看過現況再說（先跑
 *   `supabase/audits/查-0814正隆多間的現況.sql`）——
 *   我沒有看過那幾列，猜不得（CLAUDE.md：「對不上的不猜」）。
 */

begin;

create table if not exists public.hk_work_split (
  id           uuid primary key default gen_random_uuid(),

  -- ── 這一列屬於哪一份工（＝ estateLog 的合併依據）──────────
  period       text not null,
  work_date    date not null,
  -- ★ 工單上的房務代碼字樣（`hk_work_item.property_code`），例如「正隆多間」。
  --   用字樣不是 property_id：會需要拆帳的那些工正是**沒有** property_id 的。
  job_code     text not null,
  work_type    text not null,

  -- ── 這一列記到哪、記多少 ──────────────────────────────────
  -- ★ property_id 必填。拆帳的整個重點就是「這筆錢算哪一間的」
  property_id  uuid not null references public.properties(id),
  -- ★★ 0 是合法的（這一間這次不用錢），跟「沒填」不同 —— 所以 not null
  amount       numeric(14,2) not null check (amount >= 0),
  seq          int not null default 0,
  note         text,
  created_at   timestamptz not null default now(),

  -- ★★ 同一份工不能拆到同一間兩次。
  --   前端 `splitError()` 會先講人話，這裡是最後一道
  constraint hk_work_split_uniq unique (work_date, job_code, work_type, property_id)
);

comment on table public.hk_work_split is
  '一份工的清潔費拆給多個房源（migration_216）。'
  '★ 拆的是錢不是工作量 —— 打掃量／點數／床單一律走 hk_work_item 那一筆。'
  '★★ 支出的 hk_job_key 是 ''split:'' || id，不會跟一般工單的鍵撞。';

comment on column public.hk_work_split.job_code is
  '工單上的房務代碼字樣。★ 不是外鍵 —— 綁的是「工的身分」'
  '（日期＋代碼＋工作類型），跟 estateLog() 合併同一份工的依據一致。'
  '合掃是兩列 hk_work_item 但同一份工，綁到單一列會在重新匯入時掉。';

-- ★ 查詢一律是「這個月有哪些拆帳」，period 打頭
create index if not exists hk_work_split_period_idx
  on public.hk_work_split (period, work_date);

-- ★★ 孤兒偵測與「這一間被拆進來幾次」都要從房源那頭查
create index if not exists hk_work_split_property_idx
  on public.hk_work_split (property_id);


-- ══════════════════════════════════════════════════════════
-- ★★★ RLS —— 建表之後一定要接這兩段（migration_206 漏過一次）
-- ══════════════════════════════════════════════════════════
alter table public.hk_work_split enable row level security;

do $do$ begin
  begin
    create policy hk_work_split_all on public.hk_work_split
      for all
      using (current_role_of() = any (array['accountant','manager','super_admin']))
      with check (current_role_of() = any (array['accountant','manager','super_admin']));
  exception when duplicate_object then null; end;
end $do$;


-- ── 記錄執行 ───────────────────────────────────────
do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('216_hk_work_split');
  end if;
end $do$;

commit;


-- ══════════════════════════════════════════════════════════
-- 自檢
-- ★ 這一支不寫資料，所以沒有「母體」可以判定 ——
--   成敗就是「表在不在、policy 在不在、約束擋不擋得住」。
-- ══════════════════════════════════════════════════════════
select v.ord, v."檢查", v."結果", v."判定" from (

  select 1, '① 表建好了',
         coalesce((select count(*)::text || ' 個欄位'
                     from information_schema.columns
                    where table_schema = 'public' and table_name = 'hk_work_split'),
                  '（不存在）'),
         case when exists (select 1 from information_schema.tables
                            where table_schema = 'public' and table_name = 'hk_work_split')
              then '✅ 應該是 10 欄'
              else '❌ 沒建成功，下面全部不算數' end

  union all
  -- ★★★ 這一列最重要。沒有 policy 的症狀是「查詢成功、回 0 列」——
  --   畫面上是一個很正常的「拆帳 0 筆」，沒有任何錯誤
  select 2, '★★★ ② RLS policy 建好了',
         coalesce((select string_agg(p.polname, '、')
                     from pg_policy p
                     join pg_class c on c.oid = p.polrelid
                     join pg_namespace n on n.oid = c.relnamespace
                    where n.nspname = 'public' and c.relname = 'hk_work_split'),
                  '（一條都沒有）'),
         case when exists (select 1 from pg_policy p
                            join pg_class c on c.oid = p.polrelid
                            join pg_namespace n on n.oid = c.relnamespace
                           where n.nspname = 'public' and c.relname = 'hk_work_split')
              then '✅ 讀寫都通得了'
              else '❌❌❌ 沒有 policy = 全部擋掉，而畫面上會是「0 筆」不會報錯' end

  union all
  select 3, '③ 唯一約束（同一份工不能拆同一間兩次）',
         coalesce((select conname from pg_constraint
                    where conrelid = 'public.hk_work_split'::regclass
                      and conname = 'hk_work_split_uniq'), '（沒有）'),
         case when exists (select 1 from pg_constraint
                            where conrelid = 'public.hk_work_split'::regclass
                              and conname = 'hk_work_split_uniq')
              then '✅' else '❌ 拆重複時會安靜地多算一筆' end

  union all
  -- ★ 金額 0 要進得來（「這一間這次不用錢」），負數要擋
  select 4, '④ 金額約束',
         coalesce((select pg_get_constraintdef(oid) from pg_constraint
                    where conrelid = 'public.hk_work_split'::regclass
                      and contype = 'c'
                      and pg_get_constraintdef(oid) like '%amount%'
                   limit 1), '（沒有）'),
         '★ 要看到 amount >= 0 —— 0 是合法的，負數不是'

  union all
  -- ★★ 掃全部，不要只查我這次建的那一張（208 的教訓）
  select 5, '★★ ⑤ 還有沒有別的表開了 RLS 卻沒有 policy',
         (select case when count(*) = 0 then '✅ 沒有'
                      else '⚠⚠⚠ ' || string_agg(c.relname, '、') end
            from pg_class c
            join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
             and not exists (select 1 from pg_policy p where p.polrelid = c.oid)),
         '★★★ 這種表的症狀是查詢成功、回 0 列、沒有錯誤訊息'

  union all
  select 6, '⑥ 這一支有沒有被記錄',
         coalesce((select max(name) from public.schema_migrations
                    where name = '216_hk_work_split'), '（沒記到）'),
         case when exists (select 1 from public.schema_migrations
                            where name = '216_hk_work_split')
              then '✅' else '❌ record_migration 沒寫進去' end

) v(ord, "檢查", "結果", "判定") order by v.ord;
