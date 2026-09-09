/*
 * migration_231 —— 付款帳號多兩本現金
 * ============================================================
 * 2026-09-09 使用者:「臨櫃 多現金 現金-正隆 現金-安幸 的選項」
 *
 * ============================================================
 * 【為什麼下拉裡看不到現金】
 *
 * 這裡有**兩張長得很像但沒有關聯的表**:
 *
 *   bank_accounts     對帳用。migration_225 在這裡建了
 *                     「正隆-現金」與「安幸-現金」
 *   payment_accounts  支出頁「安幸付款帳號」下拉讀的那一張
 *                     ← 225 完全沒動到它
 *
 * 所以兩本現金帳在對帳那邊存在、在付款那邊不存在 ——
 * 而畫面上只是下拉裡少兩個選項，不會有任何錯誤。
 *
 * ★★ 兩張表沒有外鍵可以連，只能靠名字對得起來。
 *   所以底下的 name 刻意跟 bank_accounts 那兩列指同一件事
 *   （寫法照 payment_accounts 既有的「(擁有者)帳戶」格式，
 *    2026-09-09 使用者選的）。
 *
 * ============================================================
 * 【★★★ 為什麼要先動 check 約束】
 *
 *     payment_accounts_method_check
 *       CHECK (method = ANY (ARRAY['transfer', 'credit_card']))
 *
 * 直接 insert 會被擋下來，而 SQL Editor 把整份腳本包在一個交易裡 ——
 * 整支回滾。**先放寬約束，再插入。**
 *
 * ★ 放寬成三個值而不是拿掉約束:拿掉的話 admin 頁面手滑打錯一個字
 *   就會產生一個永遠篩不到的帳號，而那個帳號在下拉裡看不見、
 *   在明細裡卻印得出來。
 *
 * ============================================================
 * 【為什麼 for_income = false】
 *
 * 短租與契約的**收款**下拉讀的是同一張表，而且**只篩 for_income，
 * 不篩 method** —— 設成 true 的話這兩列會立刻出現在收款畫面上。
 *
 * 那可能是對的（收現金也該記進哪一本），但**那是另一個決定**，
 * 使用者這次要的是支出側。要開的時候在 admin 頁面打勾就好，
 * 不用再寫一支 migration。
 *
 * 【怎麼跑】整份貼進 Supabase SQL Editor，看最後那張自檢表。
 */

begin;

-- ① 放寬 method 的約束
alter table public.payment_accounts
  drop constraint if exists payment_accounts_method_check;
alter table public.payment_accounts
  add constraint payment_accounts_method_check
  check (method = any (array['transfer'::text, 'credit_card'::text, 'cash'::text]));

/*
 * ② 兩本現金。
 *
 * ★ 用 `where not exists` 而不是 `on conflict` —— 重跑一次要安靜地什麼都不做，
 *   而不是靠 code 的唯一索引去撞（撞了在 SQL Editor 裡是整支回滾）。
 *
 * ★★ code 用中文而不是英文縮寫:支出清單上印的是 **code**
 *   （`{r.pay_account}`，不是 name）。印出「CASH_ZL」的話
 *   看的人要回頭查那是什麼。
 *
 * ★ sort 5 → 排在所有銀行帳戶前面（既有的最小是 10）。
 */
insert into public.payment_accounts (method, code, name, for_income, for_payment, sort, active)
select v.method, v.code, v.name, false, true, 5, true
  from (values
    ('cash', '正隆現金', '(正隆)現金'),
    ('cash', '安幸現金', '(安幸)現金')
  ) as v(method, code, name)
 where not exists (
   select 1 from public.payment_accounts p where p.code = v.code
 );

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('231_cash_pay_accounts');
  end if;
end $do$;

commit;


-- ══════════════════════════════════════════════════════════
-- 自檢
-- ══════════════════════════════════════════════════════════
select v.ord, v."檢查", v."結果", v."判定" from (

  select 1, '① 約束現在允許 cash',
         (select pg_get_constraintdef(oid) from pg_constraint
           where conname = 'payment_accounts_method_check'),
         case when (select pg_get_constraintdef(oid) from pg_constraint
                     where conname = 'payment_accounts_method_check') like '%cash%'
              then '✅ 過' else '❌ 約束沒放寬，下面那兩列不會存在' end

  union all
  select 2, '② 兩本現金都在，而且是付款用',
         coalesce((select string_agg(code || '→' || name, '　' order by code)
                     from public.payment_accounts where method = 'cash'), '（沒有）'),
         case when (select count(*) from public.payment_accounts
                     where method = 'cash' and for_payment and active) = 2
              then '✅ 兩列' else '❌ 不是兩列' end

  union all
  /*
   * ★★ 這一條是刻意的決定，不是漏掉 —— 見檔頭。
   *   收款下拉只篩 for_income 不篩 method，設成 true 會立刻出現在收款畫面上。
   */
  select 3, '③ 收款那邊還看不到（刻意）',
         (select count(*)::text from public.payment_accounts
           where method = 'cash' and for_income),
         case when (select count(*) from public.payment_accounts
                     where method = 'cash' and for_income) = 0
              then '✅ 0 —— 要開的話在 admin 頁面打勾' else '⚠ 有人打開了' end

  union all
  /*
   * ★★★ 母體判定:既有帳戶一個都不能被動到。
   *   這支只 insert 不 update，但 drop constraint 那一步是整張表的操作 ——
   *   要有人確認過。
   */
  select 4, '④★★★ 既有的銀行帳戶與卡片一列都沒少',
         (select string_agg(method || '×' || n::text, '　' order by method)
            from (select method, count(*) n from public.payment_accounts
                   where method <> 'cash' group by method) g),
         case when (select count(*) from public.payment_accounts
                     where method = 'transfer' and active) >= 6
              then '✅ 銀行帳戶還在'
              else '❌ 少了 —— 對照畫面上那個下拉原本有 6 個' end

  union all
  select 5, '⑤ 下拉實際會長什麼樣（臨櫃：銀行 ＋ 現金）',
         (select string_agg(name, '　' order by sort, code)
            from public.payment_accounts
           where for_payment and active and method in ('transfer', 'cash')),
         '👀 只是給你看，不是判定'

  union all
  select 6, '⑥ 這一支有沒有被記錄',
         coalesce((select max(name) from public.schema_migrations
                    where name = '231_cash_pay_accounts'), '（沒記到）'),
         case when exists (select 1 from public.schema_migrations
                            where name = '231_cash_pay_accounts')
              then '✅' else '❌ record_migration 沒寫進去' end

) v(ord, "檢查", "結果", "判定") order by v.ord;
