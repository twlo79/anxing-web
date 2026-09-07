/*
 * 查-試插一筆房務支出看擋在哪（會回滾，不留資料）
 * ============================================================
 * 2026-09-07
 *
 * 上一支確定了主因:**兩個唯一索引都是 partial**
 * （`where hk_job_key is not null`），而 PostgREST 送出的
 * `ON CONFLICT (hk_job_key)` 對不到 partial index ——
 * Postgres 直接丟 `there is no unique or exclusion constraint
 * matching the ON CONFLICT specification`。
 *
 * 所以這條路**從第一天起就不可能成功**，跟這個月無關。
 *
 * ============================================================
 * 【但修之前要先知道還有幾顆地雷】
 *
 * `expenses` 上還有兩支 BEFORE INSERT 觸發器，以及一個外鍵:
 *
 *   · `trg_expense_account_kind` → `check_account_kind_expense`
 *   · `trg_expenses_book_code`   → `expenses_book_code_guard`
 *   · `account_code` → `account_codes(code)` 外鍵，
 *     而 `hk_cleaning` 目前**一筆都沒有人在用**
 *
 * 修好 ON CONFLICT 之後如果立刻撞外鍵，等於白改一次。
 *
 * ★★★ 與其一個一個猜，**直接照 `mk()` 的欄位試插一筆**，
 *   讓資料庫自己講話。插完一律回滾，不會留下任何資料。
 *
 * 【怎麼跑】整份貼進 SQL Editor。**這一支不會留下資料**
 *          （每次嘗試都在自己的區塊裡，成功也照樣丟例外回滾）。
 */

create temp table if not exists _probe (ord int, 項目 text, 結果 text) on commit drop;
delete from _probe;

do $probe$
declare
  v_est   uuid;
  v_prop  uuid;
  v_code  text;
begin
  select id into v_est from public.estates limit 1;
  select id into v_prop from public.properties where estate_id = v_est limit 1;

  -- ── ① 科目主檔裡有沒有 hk_cleaning ──────────────────────
  select code into v_code from public.account_codes where code = 'hk_cleaning';
  insert into _probe values (
    1, '★★ ① account_codes 裡有沒有 hk_cleaning',
    case when v_code is null
         then '❌ 沒有 —— 外鍵會擋，`mk()` 寫死的這個科目根本不存在'
         else '✅ 有' end);

  -- 順便列出長得像房務的科目，改的時候要選一個
  insert into _probe values (
    2, '① 主檔裡跟房務／清潔有關的科目',
    coalesce((select string_agg(code || '＝' || name, '、')
                from public.account_codes
               where code ilike '%hk%' or code ilike '%clean%'
                  or name like '%清潔%' or name like '%房務%' or name like '%人事%'),
             '（一個都沒有）'));

  -- ── ② 照 mk() 的欄位真的插一筆 ────────────────────────
  begin
    insert into public.expenses (
      spent_on, item_name, amount, account_code, purpose_type,
      property_id, estate_id, payment_method, tags, no_voucher, hk_labor_key
    ) values (
      date '2026-09-30', '【試插・會回滾】人事費', 1, 'hk_cleaning', 'estate',
      v_prop, v_est, null, array['非實支'], true, '__probe__'
    );
    -- 走到這裡代表插得進去 —— 丟例外把它回滾掉
    raise exception 'PROBE_OK';
  exception
    when others then
      insert into _probe values (
        3, '★★★ ② 照 mk() 的欄位插一筆（hk_cleaning）',
        case when sqlerrm = 'PROBE_OK'
             then '✅ 插得進去（已回滾）—— 那唯一的問題就是 ON CONFLICT 對不到 partial index'
             else '❌ ' || sqlerrm end);
  end;

  -- ── ③ 換一個一定存在的科目再試一次 ──────────────────────
  --    分辨「是科目的問題」還是「別的欄位的問題」
  select code into v_code from public.account_codes
   where code <> 'hk_cleaning' order by code limit 1;
  begin
    insert into public.expenses (
      spent_on, item_name, amount, account_code, purpose_type,
      property_id, estate_id, payment_method, tags, no_voucher, hk_labor_key
    ) values (
      date '2026-09-30', '【試插・會回滾】人事費', 1, v_code, 'estate',
      v_prop, v_est, null, array['非實支'], true, '__probe2__'
    );
    raise exception 'PROBE_OK';
  exception
    when others then
      insert into _probe values (
        4, '★ ③ 換成主檔裡的科目「' || coalesce(v_code, '（找不到）') || '」再試',
        case when sqlerrm = 'PROBE_OK'
             then '✅ 插得進去 —— 所以 ② 失敗的話就是 hk_cleaning 這個科目的問題'
             else '❌ ' || sqlerrm end);
  end;

  -- ── ④ 兩支 BEFORE INSERT 觸發器在做什麼 ────────────────
  insert into _probe values (
    5, '④ check_account_kind_expense 的定義',
    coalesce((select pg_get_functiondef(p.oid) from pg_proc p
                join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = 'public' and p.prokind in ('f','p')
                 and p.proname::text = 'check_account_kind_expense'), '（找不到）'));

  insert into _probe values (
    6, '④ expenses_book_code_guard 的定義',
    coalesce((select pg_get_functiondef(p.oid) from pg_proc p
                join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = 'public' and p.prokind in ('f','p')
                 and p.proname::text = 'expenses_book_code_guard'), '（找不到）'));
end $probe$;

-- ★ 確認沒留下東西（上面每一次插入都被例外回滾了）
insert into _probe
select 7, '★★ 確認沒留下試插的資料',
       case when count(*) = 0 then '✅ 0 筆，乾淨'
            else '❌ 留下 ' || count(*)::text || ' 筆,請手動刪掉 hk_labor_key like ''__probe%''' end
  from public.expenses where hk_labor_key like '\_\_probe%';

select ord, 項目, 結果 from _probe order by ord;
