/*
 * migration_274 —— 批次收回代墊（一個交易做完）
 * ============================================================
 * 2026-09-18 使用者：「愛皮 紅鯊 還款 → 安幸變已退 → 要怎麼實現自動勾稽」
 *
 * 答案是**不做勾稽**：愛皮那一側的「實支」不另外存，
 * 直接讀這一列暫付的 `refunded_amount`。同一個數字、同一個來源，
 * 沒有兩份就沒有東西要對。
 *
 * 所以「還款」這個動作只在**安幸的暫付頁**做一次，而它一次要改好幾列
 * （愛皮 9/09 那批是 8 列）—— 這支 RPC 就是那一次。
 *
 * ============================================================
 * 【★★★ 為什麼是 RPC，不是前端跑一個 for 迴圈】
 *
 * PostgREST **每一個請求各自一個交易**（migration_228 那次的教訓）。
 * 8 列跑 8 次 update 的話，斷網或權限不足會停在第 5 列 ——
 * 於是 3 列還躺在「待收回」，而愛皮那一頁的實支變成
 * 「還了 5 筆的金額」。**沒有任何地方會叫**，因為每一列自己都合法。
 *
 * 一次 update 多列 ＋ 一個交易 = 要嘛 8 列全好，要嘛一列都沒動。
 *
 * ============================================================
 * 【★★ 為什麼是 SECURITY INVOKER（不是 DEFINER）】
 *
 * 這支做的事跟使用者自己按「改」→ 填收回日 → 儲存**完全一樣**，
 * 只是一次做 8 列。用 DEFINER 的話 RLS 被繞過，權限就得在函式裡
 * 再寫一份 —— 而那份跟 policy 是兩個地方的同一條規則
 * （`CLAUDE.md`：同一條規則寫在三個地方）。
 *
 * INVOKER 之下 RLS 照常生效，擋掉的列**不會報錯、只是沒改到**
 * （`CLAUDE.md` 那條坑）—— 所以最後比對「選了幾列 vs 改到幾列」，
 * 對不上就整個 raise，交易回滾。
 *
 * ============================================================
 * 【★★ 為什麼只收「代墊」】
 *
 * 押金與保證金收回時常常**被扣**，而被扣的差額要選會計科目
 * （migration_196 / `validateRefund`）—— 批次那條路問不了這件事。
 * 代墊是全額收回或不收回（2026-09-18 使用者選「讓人挑哪幾筆」），
 * 所以差額恆為 0，沒有科目要選。
 *
 * ★ 押金要收回還是走原本那個抽屜，一列一列來。
 *
 * ============================================================
 * 【★ 為什麼限定同一個對象】
 *
 * 一次收回是**一筆錢進來**。愛皮跟洪鯊各還各的，混在同一次裡的話
 * 收回日與收款帳戶就同時代表兩筆匯款，而銀行對帳時對不回來。
 *
 * 【怎麼跑】整份貼進 Supabase SQL Editor，看最後那張自檢表。
 * ★★ 自檢在 commit 後面 —— **看不到那張表 = 整支回滾了**，
 *    不是「跑成功但沒輸出」。
 */

begin;

create or replace function public.recover_advances(
  p_ids     uuid[],
  p_on      date,
  p_account text default null
) returns integer
language plpgsql
as $fn$
declare
  v_ids   uuid[];
  v_asked integer;
  v_n     integer;
  v_bad   text;
  v_party text;
begin
  /*
   * ★ 先去重。同一個 id 送兩次的話，`array_length` 是 2 而
   *   update 只會改 1 列 —— 最後那道「選了幾列 vs 改到幾列」
   *   會誤報成權限不足，而使用者什麼都沒做錯。
   */
  v_ids   := array(select distinct u from unnest(coalesce(p_ids, '{}'::uuid[])) u where u is not null);
  v_asked := coalesce(array_length(v_ids, 1), 0);

  if v_asked = 0 then
    raise exception '沒有選任何一列';
  end if;
  if p_on is null then
    raise exception '要填收回日';
  end if;

  -- ① 只收代墊
  select string_agg(coalesce(nullif(a.usage, ''), a.id::text) || '（' || coalesce(a.category, '沒填') || '）',
                    '、' order by a.paid_on, a.id)
    into v_bad
    from public.advance_payments a
   where a.id = any(v_ids) and coalesce(a.category, '') <> '代墊';
  if v_bad is not null then
    raise exception '批次收回只處理代墊，這幾列不是：%', v_bad;
  end if;

  -- ② 必須是「待收回」：已經出款，而且還沒收回過
  select string_agg(coalesce(nullif(a.usage, ''), a.id::text), '、' order by a.paid_on, a.id)
    into v_bad
    from public.advance_payments a
   where a.id = any(v_ids)
     and (a.paid_on is null or a.refunded_on is not null);
  if v_bad is not null then
    raise exception '這幾列不是待收回（還沒出款，或已經收回過）：%', v_bad;
  end if;

  -- ③ 一次收回是一筆錢進來 → 只能是同一個對象
  if (select count(distinct coalesce(a.counterparty, ''))
        from public.advance_payments a where a.id = any(v_ids)) > 1 then
    select string_agg(distinct coalesce(a.counterparty, '（沒填）'), '、')
      into v_party
      from public.advance_payments a where a.id = any(v_ids);
    raise exception '一次只能收回同一個對象，選到了：%', v_party;
  end if;

  -- ④ 收回日不能早於出款日（跟 validateRefund 同一條規則）
  select string_agg(coalesce(nullif(a.usage, ''), a.id::text) || '（出款 ' || a.paid_on::text || '）',
                    '、' order by a.paid_on, a.id)
    into v_bad
    from public.advance_payments a
   where a.id = any(v_ids) and p_on < a.paid_on;
  if v_bad is not null then
    raise exception '收回日 % 早於出款日：%', p_on::text, v_bad;
  end if;

  /*
   * ★★★ `refunded_amount = a.amount` —— 全額收回，不吃外面傳進來的數字。
   *   讓呼叫端傳金額的話，前端算錯一次就寫進資料庫，
   *   而「暫付金額」與「收回金額」在同一列上，沒有人會去相減。
   *
   * ★ 收款帳戶沒指定就回到**原出款帳戶**（2026-09-02 使用者指定）。
   */
  update public.advance_payments a
     set refunded_on     = p_on,
         refunded_amount = a.amount,
         refund_account  = coalesce(nullif(p_account, ''), a.paid_account)
   where a.id = any(v_ids)
     and a.paid_on is not null
     and a.refunded_on is null;
  get diagnostics v_n = row_count;

  /*
   * ★★★ RLS 擋下來的 UPDATE **回成功而且影響 0 列**（CLAUDE.md 的坑）。
   *   不比這個數字的話，沒有權限的人按下去會看到「已收回 8 列」
   *   而一列都沒變 —— 然後愛皮那一頁的實支還是 0。
   */
  if v_n <> v_asked then
    raise exception '選了 % 列，只改到 % 列 —— 可能是權限不足（暫付限會計以上），或那幾列剛剛被別人改過',
      v_asked, v_n;
  end if;

  return v_n;
end $fn$;

comment on function public.recover_advances(uuid[], date, text) is
  '批次收回代墊（migration_274）。一個交易改完所有選到的列，'
  '金額一律等於該列的 amount（全額收回）。'
  '★★ SECURITY INVOKER —— RLS 照常生效，被擋掉的列靠「選了幾列 vs 改到幾列」抓出來。'
  '★ 只收 category = ''代墊''：押金／保證金被扣時要選會計科目，批次這條路問不了。';

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('274_recover_advances');
  end if;
end $do$;

commit;


-- ══════════════════════════════════════════════════════════
-- 自檢
-- ★★ 這張表在 commit 後面 —— 看不到它 = 整支回滾了。
-- ══════════════════════════════════════════════════════════
select v.ord, v."檢查", v."結果", v."判定" from (

  select 1, '① 函式在不在，而且是 invoker',
         coalesce((select p.proname::text || '（'
                     || case when p.prosecdef then 'definer ❌' else 'invoker' end || '）'
                     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'public' and p.prokind in ('f','p')
                      and p.proname::text = 'recover_advances'), '（找不到）'),
         case when exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                            where n.nspname = 'public' and p.prokind in ('f','p')
                              and p.proname::text = 'recover_advances' and not p.prosecdef)
              then '✅ 在，而且 RLS 照常生效'
              when exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                            where n.nspname = 'public' and p.prokind in ('f','p')
                              and p.proname::text = 'recover_advances')
              then '❌ 變成 definer 了 —— 那樣任何登入者都能收回別人的暫付'
              else '❌ 找不到' end

  union all
  /*
   * ★★ 四道守衛都要在。少一道不會報錯，只會讓某一種錯誤的收回
   *   安靜地存進去 —— 而那正是這支存在的理由。
   */
  select 2, '★★ ② 四道守衛在不在',
         (select string_agg(g.nm, '、' order by g.ord)
            from (values
                    (1, '只收代墊',     '批次收回只處理代墊'),
                    (2, '必須待收回',   '不是待收回'),
                    (3, '同一個對象',   '一次只能收回同一個對象'),
                    (4, '日期不早於出款', '早於出款日')
                 ) g(ord, nm, needle)
           where coalesce((select pg_get_functiondef(p.oid)
                             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                            where n.nspname = 'public' and p.prokind in ('f','p')
                              and p.proname::text = 'recover_advances'), '')
                 like '%' || g.needle || '%'),
         case when (select count(*)
                      from (values ('批次收回只處理代墊'), ('不是待收回'),
                                   ('一次只能收回同一個對象'), ('早於出款日')) g(needle)
                     where coalesce((select pg_get_functiondef(p.oid)
                                       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                                      where n.nspname = 'public' and p.prokind in ('f','p')
                                        and p.proname::text = 'recover_advances'), '')
                           like '%' || g.needle || '%') = 4
              then '✅ 四道都在' else '❌ 少了其中一道' end

  union all
  -- ★★ 有沒有比「選了幾列 vs 改到幾列」—— 沒有的話 RLS 擋掉會靜靜地成功
  select 3, '★★ ③ 有沒有檢查影響列數',
         case when coalesce((select pg_get_functiondef(p.oid)
                               from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                              where n.nspname = 'public' and p.prokind in ('f','p')
                                and p.proname::text = 'recover_advances'), '')
                   like '%get diagnostics%' then '有' else '沒有 ❌' end,
         case when coalesce((select pg_get_functiondef(p.oid)
                               from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                              where n.nspname = 'public' and p.prokind in ('f','p')
                                and p.proname::text = 'recover_advances'), '')
                   like '%get diagnostics%'
              then '✅ RLS 擋掉會 raise，不會假成功'
              else '❌ 沒權限的人會看到「收回成功」而一列都沒變' end

  union all
  /*
   * ★★★ 母體要判定。是 0 的話上面三條驗的只是函式的形狀，
   *   底下那條資料檢查自動成立 —— 六個綠勾比一個紅字更危險。
   */
  select 4, '★★★ ④ 母體：現在有幾筆代墊',
         (select count(*)::text || ' 筆代墊，其中待收回 '
                 || count(*) filter (where paid_on is not null and refunded_on is null)::text
                 || ' 筆、已收回 '
                 || count(*) filter (where refunded_on is not null)::text || ' 筆'
            from public.advance_payments where coalesce(category,'') = '代墊'),
         case when (select count(*) from public.advance_payments
                     where coalesce(category,'') = '代墊') = 0
              then '⚠ 一筆代墊都沒有 —— 下面那條不算數'
              else '✅ 有東西可以檢查' end

  union all
  /*
   * ★ 收回日與收回金額必須成對（migration_196 的 ap_refund_pair_chk）。
   *   這一條問的是**結果對不對**，不是「這次跑做了什麼」——
   *   跑第二次、第十次答案都一樣。
   */
  select 5, '⑤ 已收回的代墊，日期與金額有沒有成對',
         (select coalesce(count(*) filter (
                    where (refunded_on is null) <> (refunded_amount is null))::text, '0')
                 || ' 筆不成對'
            from public.advance_payments where coalesce(category,'') = '代墊'),
         case when (select count(*) from public.advance_payments
                     where coalesce(category,'') = '代墊'
                       and (refunded_on is null) <> (refunded_amount is null)) = 0
              then '✅ 全部成對'
              else '❌ 有半套的列 —— 狀態會卡在待收回與已收回之間' end

  union all
  select 6, '⑥ 這一支有沒有被記錄',
         coalesce((select max(name) from public.schema_migrations
                    where name = '274_recover_advances'), '（沒記到）'),
         case when exists (select 1 from public.schema_migrations
                            where name = '274_recover_advances')
              then '✅' else '❌ record_migration 沒寫進去' end

) v(ord, "檢查", "結果", "判定") order by v.ord;
