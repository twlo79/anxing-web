/*
 * migration_252_lock_read_all.sql　2026-09-14
 * 「這個月關帳了沒」讓所有登入的人都讀得到
 *
 * 【怎麼跑】整份貼進 Supabase SQL Editor，看最後那張自檢表。
 *          ★ 看不到自檢的表格＝失敗了，把錯誤訊息整段貼回來。
 *
 * ══════════════════════════════════════════════════════════
 * 【為什麼】
 *
 * 249/250/251 之後，資料庫確實擋得住了 —— 但**畫面上一個鎖都沒出現**，
 * 管家、清潔看到的收租畫面跟關帳前一模一樣。
 *
 * 原因是 `period_lock_read` 只開給 accountant / manager / super_admin，
 * 而這個組織有 **5 個管家、2 個清潔**。他們查 `period_lock` 會
 * **回成功、0 列** —— 前端拿到空陣列，就當作「都沒關帳」。
 *
 * ★★★ 這是 CLAUDE.md 那條「RLS 擋下的查詢回成功且影響 0 列」。
 *   而前端那句容錯（「撈不到就當作沒關帳，不要因為查不到就把整頁鎖死」）
 *   在這裡**剛好是最糟的方向** —— 它把一個權限問題變成了靜默放行。
 *
 * ══════════════════════════════════════════════════════════
 * 【★★ 為什麼開放讀取是安全的】
 *
 * 這張表只有三件事:哪個月、關了沒、誰在什麼時候關的。
 *
 *   **「八月關帳了」不是機密** —— 它是一個工作狀態，
 *   而看得到的人才知道自己為什麼改不動。
 *
 *   能不能**改**才是權限，那條（`period_lock_write` = 會計與 super_admin）
 *   一個字都沒動。
 *
 * ★ 只開給**登入的人**（`auth.uid() is not null`），不是完全公開。
 *
 * ══════════════════════════════════════════════════════════
 * 【★ 順帶:為什麼不把前端的容錯改成「查不到就全鎖」】
 *
 * 那樣一次網路不順就會變成「整頁按鈕全部消失」，而使用者不知道為什麼。
 * 真正的修法是**讓該看到的人看得到**，不是把失敗模式換一種糟法。
 * 資料庫那層照樣擋 —— 前端只是讓人不要白按（lib/collect-perm.ts 同一個道理）。
 * ══════════════════════════════════════════════════════════
 */

begin;

drop table if exists public._m252_test;
create table public._m252_test (ord int, name text, detail text, verdict text);

-- 改動前先記下來，自檢才有得比
insert into public._m252_test
select 0, '（改動前）period_lock_read 的條件',
       coalesce(pg_get_expr(polqual, polrelid), '（沒有這條 policy）'), 'ℹ'
  from pg_policy
 where polrelid = 'public.period_lock'::regclass and polname = 'period_lock_read';

-- ══════════════════════════════════════════════════════════
-- ① 讀取開放給所有登入的人
-- ══════════════════════════════════════════════════════════
drop policy if exists period_lock_read on public.period_lock;
create policy period_lock_read on public.period_lock
  for select using (auth.uid() is not null);

/*
 * ★ 寫入**一個字都沒動** —— 還是只有會計與 super_admin（249 定的）。
 *   這裡只是把「看得到」跟「改得動」分開:
 *   看不到的人不知道自己為什麼改不動，只會以為系統壞了。
 */

-- ══════════════════════════════════════════════════════════
-- ② 待處理清單也一樣
--
-- ★ 「我改的東西被關帳擋下來了」這件事，被擋的人自己要看得到。
--   只有會計看得到的話，管家會一直重按同一顆按鈕。
-- ══════════════════════════════════════════════════════════
drop policy if exists olp_read on public.order_lock_pending;
create policy olp_read on public.order_lock_pending
  for select using (auth.uid() is not null);

-- ══════════════════════════════════════════════════════════
-- ③ 臨時解鎖：看得到「現在誰開著鎖」
--
-- ★ 開鎖權限不動（會計與 super_admin）。但畫面上要顯示
--   「這一期已開鎖」那條橫幅，讀不到的人會看到一個明明開著卻寫著鎖住的畫面。
-- ══════════════════════════════════════════════════════════
drop policy if exists period_unlock_read on public.period_unlock;
create policy period_unlock_read on public.period_unlock
  for select using (auth.uid() is not null);

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('252_lock_read_all');
  end if;
end $do$;

commit;


-- ══════════════════════════════════════════════════════════
-- 自　檢
-- ══════════════════════════════════════════════════════════
select v.ord, v."檢查", v."結果", v."判定" from (

  select t.ord, t.name, t.detail, t.verdict from public._m252_test t

  union all
  select 1, '① 三張表的讀取都開給登入者了',
         coalesce((select string_agg(
                     p.polrelid::regclass::text || '：' || pg_get_expr(p.polqual, p.polrelid),
                     '　' order by p.polrelid::regclass::text)
                     from pg_policy p
                    where p.polname in ('period_lock_read', 'olp_read', 'period_unlock_read')),
                  '（一條都沒有）'),
         case when (select count(*) from pg_policy p
                     where p.polname in ('period_lock_read', 'olp_read', 'period_unlock_read')
                       and pg_get_expr(p.polqual, p.polrelid) ~ 'auth\.uid\(\) IS NOT NULL') = 3
              then '✅ 三條都開了' else '❌ 有沒改到的' end

  union all
  /*
   * ★★★ 這一條才是重點:**寫入沒有被放寬**。
   *   讀取開放的前提就是「改不動」那條沒動 ——
   *   兩條一起放寬的話，這支就從「讓人看得到」變成「誰都能開帳」。
   */
  select 2, '② 寫入權限一個字都沒動（只有會計與 super_admin）',
         coalesce((select pg_get_expr(polqual, polrelid) from pg_policy
                    where polrelid = 'public.period_lock'::regclass
                      and polname = 'period_lock_write'), '（沒有這條 policy）'),
         case when (select pg_get_expr(polqual, polrelid) from pg_policy
                     where polrelid = 'public.period_lock'::regclass
                       and polname = 'period_lock_write') ~ 'accountant'
               and (select pg_get_expr(polqual, polrelid) from pg_policy
                     where polrelid = 'public.period_lock'::regclass
                       and polname = 'period_lock_write') !~ 'manager'
              then '✅ 還是只有會計與 super_admin' else '❌ 被動到了' end

  union all
  select 3, '③ 開鎖權限也沒動',
         coalesce((select pg_get_expr(polqual, polrelid) from pg_policy
                    where polrelid = 'public.period_unlock'::regclass
                      and polname = 'period_unlock_write'), '（沒有這條 policy）'),
         case when (select pg_get_expr(polqual, polrelid) from pg_policy
                     where polrelid = 'public.period_unlock'::regclass
                       and polname = 'period_unlock_write') ~ 'accountant'
              then '✅ 還是只有會計與 super_admin' else '❌' end

  union all
  select 4, '④ 現在哪幾個月是鎖著的（前端從此讀得到這幾列）',
         coalesce((select string_agg(p.ym || case when p.auto then '(自動)' else '(手動)' end,
                                     '　' order by p.ym)
                     from public.period_lock p where p.locked), '（一個月都沒關）'),
         case when exists (select 1 from public.period_lock where locked)
              then '✅ 有得鎖' else '⚠ 一個月都沒關 —— 畫面上當然不會有鎖' end

  union all
  select 5, '⑤ 收尾',
         '核對完請執行：drop table public._m252_test;',
         '⚠ 記得清掉這張暫存表'

) as v(ord, "檢查", "結果", "判定")
order by v.ord;
