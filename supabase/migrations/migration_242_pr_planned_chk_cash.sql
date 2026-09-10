begin;

/*
 * migration_242  付款方式可以有「安幸付款帳號」的清單，補上現金與臨櫃
 * ------------------------------------------------------------
 * 2026-09-10 使用者：確認出款時把付款方式改成「現金」、選了(安幸)現金
 *   → `new row for relation "purchase_requests" violates check
 *      constraint "pr_planned_chk"`
 *
 * ★★★ 這條約束的原文（schema-baseline）:
 *
 *     check (payout_account is null
 *            or payment_method in ('transfer','credit_card'))
 *
 * 也就是「只有匯款與信用卡可以有我方付款帳號」。那在當時是對的。
 *
 * ============================================================
 * 【★★★ 為什麼會踩到 —— 規則寫在兩個地方，只改了一邊】
 *
 * 這條規則同時活在:
 *
 *   前端  `src/lib/purchase-pay.ts` 的 `needsPayout()`
 *   資料庫 `pr_planned_chk`
 *
 * 而它被放寬過**兩次**，兩次都只改了前端:
 *
 *   2026-08-25  加「臨櫃」「自動繳款」→ needsPayout 加了這兩種
 *   2026-09-09  migration_231 建了 (安幸)現金 / (正隆)現金
 *               → needsPayout 加了 'cash'、accountMethodsFor 給了臨櫃兩類
 *
 * ★★ 兩次都沒有人去看資料庫那一半。症狀是「畫面讓你選，存檔說違反約束」——
 *   而錯誤訊息是一句 SQL 例外，看的人完全不知道發生什麼事。
 *
 * ★★★ 這是 `CLAUDE.md` 那條「同一條規則在多個地方各寫一次」的又一次。
 *   放寬一條規則時要問:**這條規則資料庫也有一份嗎？**
 *
 * ============================================================
 * 【為什麼不乾脆刪掉這條約束】
 *
 * 放寬之後五種付款方式全都可以有帳號，這條看起來就沒在擋什麼了。
 * 但**留著**:它是「哪些方式可以有我方帳號」這件事在資料庫這一側的
 * 唯一紀錄。刪掉的話，日後加第六種付款方式時，
 * 沒有任何東西會提醒你這裡本來有一條規則。
 *
 * ★ 而且它還是擋得住一件事:`payment_method` 是空的卻填了帳號。
 *
 * ============================================================
 * 【★ 用「找出來再刪」而不是直接 drop 那個名字】
 *
 * `schema-baseline.sql` 不等於線上（CLAUDE.md 有這一條）。
 * 所以底下**掃 purchase_requests 上所有提到 payout_account 的 check**，
 * 一律換掉 —— 而不是假設它就叫 `pr_planned_chk`、也不是假設只有一條。
 * ------------------------------------------------------------
 */

do $do$
declare c record; n int := 0;
begin
  for c in
    select conname, pg_get_constraintdef(oid) as def
      from pg_constraint
     where conrelid = 'public.purchase_requests'::regclass
       and contype  = 'c'
       and pg_get_constraintdef(oid) ~ '\mpayout_account\M'
  loop
    execute format(
      'alter table public.purchase_requests drop constraint %I', c.conname);
    raise notice '換掉舊約束 % → %', c.conname, c.def;
    n := n + 1;
  end loop;

  -- ★ 一條都沒找到就停下來。默默 add 一條新的話，
  --   舊那條可能還在別的名字底下擋著，而你以為修好了
  if n = 0 then
    raise notice '（沒有找到提到 payout_account 的 check —— 直接建新的）';
  end if;
end $do$;

/*
 * ★★ 清單跟 `lib/purchase-pay.ts` 的 `needsPayout()` **必須一致**。
 *   那邊多一種、這邊沒加，症狀就是這次踩到的樣子:
 *   畫面讓你選、存檔丟一句 SQL 例外。
 */
alter table public.purchase_requests
  add constraint pr_planned_chk
  check (payout_account is null
         or payment_method in ('transfer', 'credit_card', 'counter', 'autopay', 'cash'));

comment on constraint pr_planned_chk on public.purchase_requests is
  '哪些付款方式可以有「安幸付款帳號」（migration_242）。'
  '★★★ 這份清單跟前端 lib/purchase-pay.ts 的 needsPayout() 是同一條規則的兩半 —— '
  '那邊放寬了這裡沒跟著放寬，症狀是「畫面讓你選、存檔丟 SQL 例外」，'
  '而使用者完全看不懂（2026-08-25 加臨櫃、2026-09-09 加現金，兩次都漏了這裡）。';

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('242_pr_planned_chk_cash');
  end if;
end $do$;

commit;


-- ══════════════════════════════════════════════════════════
-- 自檢
--
-- ★★★ 看不到這張表 = 上面爆了、整支回滾。
-- ══════════════════════════════════════════════════════════
select v.ord, v."檢查", v."結果", v."判定" from (

  select 1, '① 新約束的內容',
         coalesce((select pg_get_constraintdef(oid) from pg_constraint
                    where conrelid = 'public.purchase_requests'::regclass
                      and conname = 'pr_planned_chk'), '（沒有這條約束）'),
         case when (select pg_get_constraintdef(oid) from pg_constraint
                     where conrelid = 'public.purchase_requests'::regclass
                       and conname = 'pr_planned_chk') ilike '%cash%'
              then '✅ 現金在裡面' else '❌' end

  union all
  select 2, '② 五種方式都在',
         (select string_agg(m, '、' order by m) from unnest(
            array['transfer','credit_card','counter','autopay','cash']) m
           where (select pg_get_constraintdef(oid) from pg_constraint
                   where conrelid = 'public.purchase_requests'::regclass
                     and conname = 'pr_planned_chk') like '%' || m || '%'),
         case when (select count(*) from unnest(
                      array['transfer','credit_card','counter','autopay','cash']) m
                     where (select pg_get_constraintdef(oid) from pg_constraint
                             where conrelid = 'public.purchase_requests'::regclass
                               and conname = 'pr_planned_chk') like '%' || m || '%') = 5
              then '✅' else '❌ 少了幾種 —— 對一下 needsPayout()' end

  union all
  select 3, '③ 沒有殘留的舊約束',
         (select count(*)::text from pg_constraint
           where conrelid = 'public.purchase_requests'::regclass
             and contype  = 'c'
             and pg_get_constraintdef(oid) ~ '\mpayout_account\M') || ' 條',
         /*
          * ★★ 應該剛好 1 條。2 條的話表示舊的沒被刪掉 ——
          *   而那條會繼續擋，你卻以為修好了。
          */
         case when (select count(*) from pg_constraint
                     where conrelid = 'public.purchase_requests'::regclass
                       and contype  = 'c'
                       and pg_get_constraintdef(oid) ~ '\mpayout_account\M') = 1
              then '✅ 剛好一條' else '❌ 不是一條 —— 有殘留或沒建起來' end

  union all
  select 4, '④ 現在有幾張單是現金／臨櫃＋有帳號',
         (select count(*)::text from public.purchase_requests
           where payout_account is not null
             and payment_method in ('cash','counter','autopay')) || ' 張',
         'ℹ 這次改之前存不進去，所以 0 是正常的'

  union all
  select 5, '⑤ 現金付款帳號存在嗎（migration_231 建的）',
         coalesce((select string_agg(name, '、' order by sort) from public.payment_accounts
                    where method = 'cash' and for_payment and active), '（一個都沒有）'),
         case when (select count(*) from public.payment_accounts
                     where method = 'cash' and for_payment and active) >= 2
              then '✅' else '❌ 231 沒跑或被改掉了' end

) v(ord, "檢查", "結果", "判定") order by v.ord;
