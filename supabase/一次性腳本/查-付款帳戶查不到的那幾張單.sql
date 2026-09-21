/*
 * 查-付款帳戶查不到的那幾張單.sql　2026-09-21
 * 只讀不寫。回一張表。
 *
 * ══════════════════════════════════════════════════════════
 * 【為什麼要查】
 *
 * migration_285 的閘門擋下來了:
 *     PR-202609-006（現在=null 新算=帳戶查不到）
 *     PR-202609-007（現在=null 新算=帳戶查不到）
 *
 * 「帳戶查不到」有兩種完全不同的原因，而處理方式相反:
 *
 *   ① `payout_account` 是**空的** —— 那張單沒記錄錢從哪個戶頭出去
 *   ② 有值，但那個代號**不在收付款帳號主檔裡** —— 帳號被刪掉或改過代號
 *
 * ★★★ 這件事會決定 285 的觸發器要不要放寬:
 *   現在它遇到查不到的帳戶就 `raise exception`。
 *   如果「沒填付款帳戶」是**日常會發生**的事（例如臨櫃、自動繳款），
 *   那一行會把**每一張這樣的新單**擋在門外 ——
 *   而那不是我要的，我要擋的是「不知道錢從哪本帳出去，所以判不出是不是代墊」。
 *
 * ★ 所以先看清楚再改。對不上的不猜（CLAUDE.md）。
 *
 * ══════════════════════════════════════════════════════════
 * 【★ 那兩張已經出款了，不會再跑觸發器】
 *
 * `gen_expenses_from_pr()` 的第一道門是 `if old.purchased_on is null`
 * —— 已出款的單再也不會重跑。所以它們**不是**「新舊規則對同一批資料
 * 給出不同答案」，只是「新規則算不出來」。
 * 閘門把這兩種混成一種，那是閘門要修的地方。
 * ══════════════════════════════════════════════════════════
 */

select * from (

  /* ── ① 被擋下來的那兩張，關鍵欄位 ─────────────────────
     ★ 用 to_jsonb(p.*)->>'欄位' 取值:欄位名不對只會空一格，
       不會 42703 整支炸掉（README 二-6）。 */
  select 1 as ord, '★★★ ① 被擋下來的那幾張' as "段",
         coalesce(j ->> 'req_no', '(沒有單號)')                        as "單號",
         case when (j ->> 'payout_account') is null then '(是 null)'
              when btrim(j ->> 'payout_account') = '' then '(是空字串)'
              else '「' || (j ->> 'payout_account') || '」' end        as "付款帳戶",
         coalesce(j ->> 'payment_method', '(沒填)')                    as "支出方式",
         coalesce(j ->> 'book', '(空的)')                              as "帳本",
         coalesce(j ->> 'purchased_on', '(還沒出款)')                  as "出款日"
    from (select to_jsonb(p.*) as j from public.purchase_requests p
           where coalesce(to_jsonb(p.*) ->> 'req_no', '')
                 in ('PR-202609-006', 'PR-202609-007')) s

  union all
  select 2, '', '', '', '', '', ''

  union all
  /* ── ② 全部請款單裡，付款帳戶對不到主檔的有幾張 ────────
     ★ 分成四種:空的/有值查不到 × 已出款/還沒出款。
       四種的處理方式不一樣，混成一個數字就分不出來了。 */
  select 3, '★★★ ② 付款帳戶對不到主檔的單（全部）',
         g.kind, g.n::text || ' 張', '', '', left(g.sample, 60)
    from (
      select case
               when p.payout_account is null or btrim(p.payout_account) = ''
                 then '沒填付款帳戶'
               else '有值但主檔查不到' end
             || '・' ||
             case when p.purchased_on is null then '還沒出款' else '已出款' end as kind,
             count(*) as n,
             string_agg(distinct coalesce(nullif(btrim(p.payout_account), ''), '(空的)'), '、') as sample
        from public.purchase_requests p
       where not exists (select 1 from public.payment_accounts a
                          where a.code = p.payout_account)
       group by 1
    ) g

  union all
  /* ★★★ 一張都沒有要說出來 —— 空結果跟「沒查到」長得一樣 */
  select 3, '★★★ ② 付款帳戶對不到主檔的單（全部）', '（一張都沒有）',
         '✅ 每一張單的付款帳戶都對得到主檔', '', '', ''
   where not exists (
     select 1 from public.purchase_requests p
      where not exists (select 1 from public.payment_accounts a
                         where a.code = p.payout_account))

  union all
  select 4, '', '', '', '', '', ''

  union all
  /* ── ③ 那些「有值但查不到」的代號到底是什麼 ─────────────
     ★ 可能是停用後被刪掉的帳號，也可能是打錯的字。 */
  /* ★ jsonb 要先在子查詢裡取成欄位再 group —— 直接在 group by 的
     select 裡寫 to_jsonb(p.*) 會是「p.* 必須出現在 GROUP BY」 */
  select 5, '★★ ③ 查不到的代號長什麼樣',
         '「' || x.acct || '」',
         count(*)::text || ' 張', '', '',
         left(string_agg(distinct x.req, '、'), 60)
    from (select p.payout_account as acct,
                 coalesce(to_jsonb(p.*) ->> 'req_no', '?') as req
            from public.purchase_requests p
           where p.payout_account is not null and btrim(p.payout_account) <> ''
             and not exists (select 1 from public.payment_accounts a
                              where a.code = p.payout_account)) x
   group by x.acct

  union all
  select 5, '★★ ③ 查不到的代號長什麼樣', '（沒有）',
         'ℹ 查不到的那幾張都是「沒填」，不是「打錯代號」', '', '', ''
   where not exists (
     select 1 from public.purchase_requests p
      where p.payout_account is not null and btrim(p.payout_account) <> ''
        and not exists (select 1 from public.payment_accounts a
                         where a.code = p.payout_account))

  union all
  select 6, '', '', '', '', '', ''

  union all
  /* ── ④ 沒填付款帳戶的單，支出方式都是什麼 ───────────────
     ★★ 這一段回答「沒填是不是正常的」:
       如果全部都是臨櫃／自動繳款，那就是一種正常流程，觸發器要放寬。 */
  select 7, '★★★ ④ 沒填付款帳戶的單，支出方式是什麼',
         y.pm, count(*)::text || ' 張', '', '',
         left(string_agg(distinct y.req, '、'), 60)
    from (select coalesce(to_jsonb(p.*) ->> 'payment_method', '(沒填方式)') as pm,
                 coalesce(to_jsonb(p.*) ->> 'req_no', '?') as req
            from public.purchase_requests p
           where p.payout_account is null or btrim(p.payout_account) = '') y
   group by y.pm

  union all
  select 7, '★★★ ④ 沒填付款帳戶的單，支出方式是什麼', '（沒有）',
         '✅ 每一張單都有填付款帳戶', '', '', ''
   where not exists (select 1 from public.purchase_requests p
                      where p.payout_account is null or btrim(p.payout_account) = '')

) v(ord, "段", "單號", "付款帳戶", "支出方式", "帳本", "出款日")
order by v.ord, v."單號";
