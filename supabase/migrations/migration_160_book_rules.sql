-- migration_160：帳本的三條規則
--
-- ============================================================
-- 【接續 migration_159】
--
-- 159 加了欄位與科目，但**沒有任何規則** ——
-- 這一支補上三條，全部寫在資料庫:
--
--   ① 認列觸發器跳過非安幸
--   ② 愛皮洪鯊的請款免主管票
--   ③ 一張請款單只能有一本帳
--
-- ★ 為什麼一定要寫在觸發器而不是前端
--   前端算的話，改前端就能繞過審核、就能把愛皮的錢記進安幸帳。
--   這條原則整個專案都一致（見 README 二、2.3）。
--
-- ★ 159 沒跑就別跑這支 —— 自檢第 0 項會擋。
--
--
-- ============================================================
-- 【跑完之後畫面還是不會變】
--
-- 目前沒有任何一筆資料的 book 不是 anxing，所以這三條規則
-- **暫時都不會生效**。它們是為了「開新入口的那一天」先備好。
--
-- 順序是刻意的:規則先於入口。反過來的話，
-- 中間那段時間愛皮的錢已經進資料庫而規則還沒上，
-- 那幾筆會被認列機制拆成月認列、也會要求主管投票。
-- ============================================================


-- ── ① 認列跳過非安幸 ───────────────────────────────
/*
 * 安幸的營收表**不是把訂單金額加起來**的。一筆長租收 12 萬、租期跨 6 個月，
 * 那 12 萬要拆成每個月 2 萬 —— `revenue_recognitions` 這張表做這件事。
 *
 * **投資公司的股利、旅行社的團費沒有「跨月」這回事**
 * （使用者確認:「愛皮洪鯊沒有跨月認列問題，目前都是一次性直接收入」）。
 * 硬套認列只是多一層轉換，而多一層就多一種對不起來的方式。
 *
 * ★ 所以認列觸發器第一件事就是看 book，不是安幸就直接 return。
 *
 * ★ 為什麼包一層而不是改函式本體:
 *   `sync_revenue_recognitions()` 是這個系統裡最複雜的一支
 *   （長租、短租、折讓、移房各有算法）。整支重抄一次
 *   等於把每一種算法都重新賭一次有沒有抄漏。
 *   在觸發器層擋掉是一行的事，而且看得懂。
 */
do $$
declare fn text;
begin
  -- 觸發器名稱可能不只一個，逐一改成帶條件的版本
  for fn in
    select t.tgname
      from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_proc  p on p.oid = t.tgfoid
     where c.relname = 'orders'
       and not t.tgisinternal
       and p.proname like '%recognition%'
  loop
    /*
     * WHEN 條件寫在觸發器上，不是函式裡 ——
     * 函式完全不用動，也就不可能抄漏任何一種算法。
     */
    raise notice '認列觸發器: % —— 需要人工確認是否加上 book 條件', fn;
  end loop;
end $$;

/*
 * ★★ 用 WHEN 條件擋，函式一個字都不用改。
 *
 * 找不到觸發器時不報錯 —— 名稱可能跟預期不同，
 * 自檢第 1 項會告訴你有沒有成功。
 */
do $$
declare tg record;
begin
  for tg in
    select t.tgname, p.proname
      from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_proc  p on p.oid = t.tgfoid
     where c.relname = 'orders' and not t.tgisinternal
       and p.proname ~ 'recogn'
  loop
    execute format('drop trigger if exists %I on public.orders', tg.tgname);
    execute format(
      'create trigger %I after insert or update on public.orders '
      'for each row when (new.book = ''anxing'') execute function public.%I()',
      tg.tgname, tg.proname);
    raise notice '已加上 book 條件: % → %', tg.tgname, tg.proname;
  end loop;
end $$;


-- ── ② 愛皮洪鯊免主管票 ─────────────────────────────
/*
 * 使用者指定:愛皮洪鯊的請款**只要總經理核可**（主管那一票直接免掉）。
 *
 * ★ 函式本體是從 migration_149 抄下來的，
 *   除了下面標記的那一段以外**一個字都沒動** —— 包括:
 *     · 駁回清票
 *     · 退回草稿清票（那段註解解釋了為什麼由資料庫清而不是前端清）
 *     · NT$3,000 免核門檻
 *
 * ★ 為什麼不用 baseline 那份:repo 的 schema-baseline.sql 沒有
 *   「退回草稿清票」那一段（那是 149 才加的）。照抄等於把它刪掉，
 *   而症狀是「核可後改內容，舊的票還在」—— 兩票白審，沒有人會發現。
 */
create or replace function public.pr_apply_status()
returns trigger language plpgsql security definer set search_path to 'public' as $function$
declare
  threshold numeric := 3000;
  -- 愛皮洪鯊只要總經理一票（migration_160）
  skip_mgr boolean := coalesce(new.book, 'anxing') <> 'anxing';
begin
  -- 駁回:清掉既有票數,退回申請人
  if new.status = 'rejected' and old.status is distinct from 'rejected' then
    new.manager_approved_by := null; new.manager_approved_at := null;
    new.admin_approved_by   := null; new.admin_approved_at   := null;
    new.rejected_at := coalesce(new.rejected_at, now());
    return new;
  end if;

  /*
   * ★ 退回草稿也要清票（migration_149）。
   *
   * 內容改了就等於重來一次，既有的票不算數 ——
   * 不清的話「核可後改收款帳號」就能把錢導到別的地方，兩票白審。
   *
   * 由這裡清而不是前端清:前端清的話，會計會被 pr_guard_votes 擋下來
   * （對它來說清票也是「動到核可欄位」），而錯誤訊息是
   * 「會計不得核可請款單」—— 跟使用者正在做的事完全對不起來。
   */
  if new.status = 'draft' and old.status in ('pending', 'approved') then
    new.manager_approved_by := null; new.manager_approved_at := null;
    new.admin_approved_by   := null; new.admin_approved_at   := null;
    new.submitted_at := null;
    return new;
  end if;

  -- 送出(draft/rejected → pending)
  if new.status = 'pending' and old.status in ('draft','rejected') then
    new.submitted_at  := now();
    new.rejected_by   := null; new.rejected_at := null; new.reject_reason := null;
    if new.total_amount < threshold then
      new.status := 'approved';           -- 免核,直接放行
      return new;
    end if;
  end if;

  /*
   * ★★ 票到齊 → 核可完成（migration_160 改）。
   *
   *   安幸       主管 ＋ 總經理
   *   愛皮洪鯊   只要總經理
   *
   * 用 `skip_mgr or 主管票不為 null` 而不是分成兩段 if ——
   * 分兩段的話之後改門檻要記得改兩個地方，而漏改一邊不會報錯。
   */
  if new.status = 'pending'
     and (skip_mgr or new.manager_approved_at is not null)
     and new.admin_approved_at is not null then
    new.status := 'approved';
  end if;
  return new;
end $function$;


-- ── ③ 一張請款單只能有一本帳 ───────────────────────
/*
 * 用途是**每個項目各自選的**，所以一張單理論上可以一項正隆、一項愛皮。
 * 那樣支出產生時會拆進兩本帳，而總額對不起來時
 * 沒有人知道該去哪一本查。
 *
 * ★ 這裡擋的是「項目的用途與母單的帳本對不起來」。
 *   前端也會限制下拉選項，但前端擋不住重新整理後的舊畫面。
 */
create or replace function public.pri_book_guard()
returns trigger language plpgsql security definer set search_path to 'public'
as $function$
declare v_book text;
begin
  select coalesce(book, 'anxing') into v_book
    from public.purchase_requests where id = new.request_id;

  -- 母單是安幸，項目卻選了「其他事業體」
  if v_book = 'anxing' and new.purpose_type = 'other_biz' then
    raise exception
      '這張請款單是安幸的帳，項目不能選「其他事業體」。'
      '愛皮／洪鯊的支出請另外開一張單。'
      using errcode = 'check_violation';
  end if;

  -- 母單是愛皮洪鯊，項目卻選了物業或辦公室
  if v_book <> 'anxing' and new.purpose_type <> 'other_biz' then
    raise exception
      '這張請款單是%的帳，項目的用途只能選「其他事業體」。',
      case v_book when 'aipi' then '愛皮' else '洪鯊' end
      using errcode = 'check_violation';
  end if;

  return new;
end $function$;

drop trigger if exists trg_pri_book_guard on public.purchase_request_items;
create trigger trg_pri_book_guard
  before insert or update of purpose_type on public.purchase_request_items
  for each row execute function public.pri_book_guard();


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('160_book_rules');
  end if;
end $$;


-- ============================================================
-- 驗證
-- ============================================================
/*
 * ★ 只能有一個 SELECT —— SQL Editor 只顯示最後一個的結果。
 */
select "檢查項目", "結果", "說明" from (

  select 0 as ord, '★★ migration_159 已經跑過' as "檢查項目",
         case when exists (select 1 from information_schema.columns
                            where table_schema = 'public' and table_name = 'orders'
                              and column_name = 'book')
              then '✅' else '❌ 先跑 159' end as "結果",
         'orders.book' as "說明"

  union all
  /*
   * ★★ 認列觸發器有沒有真的加上條件。
   *   加不上的症狀是:愛皮的一筆收入被拆成 12 個月認列，
   *   而總額還是對的 —— 只有月份分佈錯，不會報錯。
   */
  select 1, '★★ 認列觸發器已限定安幸',
         count(*)::text || ' 支',
         case when count(*) > 0
              then '✅ 非安幸的訂單不會產生認列'
              else '⚠ 找不到帶條件的認列觸發器 —— 貼下面那支查詢給我' end
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
   where c.relname = 'orders' and not t.tgisinternal
     and pg_get_triggerdef(t.oid) like '%book%anxing%'

  union all
  select 2, '★★ 免主管票的規則',
         case when pg_get_functiondef(p.oid) like '%skip_mgr%' then '✅' else '❌' end,
         '愛皮洪鯊送審後只等總經理'
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'pr_apply_status'

  union all
  /*
   * ★★ 既有行為一個都不能少。
   *   這支整個覆寫 pr_apply_status，漏抄一段的症狀是
   *   「某個情況下票沒有被清掉」—— 而那要等有人真的去改單才會發現。
   */
  select 3, '★★ 既有的清票邏輯都還在',
         case when pg_get_functiondef(p.oid) like '%migration_149%'
               and pg_get_functiondef(p.oid) like '%rejected%'
               and pg_get_functiondef(p.oid) like '%threshold%'
              then '✅ 3 / 3' else '❌ 有段落被抄漏了' end,
         '駁回清票、退回草稿清票、NT$3,000 免核門檻'
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'pr_apply_status'

  union all
  select 4, '★ 單一帳本的防線',
         case when exists (select 1 from pg_trigger
                            where tgrelid = 'public.purchase_request_items'::regclass
                              and tgname = 'trg_pri_book_guard')
              then '✅' else '❌ 觸發器沒建起來' end,
         '一張單不能一半愛皮一半安幸'

  union all
  /*
   * ★ 現在應該一筆非安幸的資料都沒有。
   *   這一項的用途是開了新入口之後回來對照。
   */
  select 5, '目前非安幸的資料',
         (select count(*) from public.orders where book <> 'anxing')::text || ' 筆訂單、'
         || (select count(*) from public.expenses where book <> 'anxing')::text || ' 筆支出',
         '現在應該都是 0 —— 入口還沒開'

  union all
  /*
   * ★★ 認列表裡不該有非安幸的列。
   *   開了入口之後這一項要一直是 0，不是 0 就表示條件沒生效。
   */
  select 6, '★★ 認列表裡的非安幸資料',
         count(*)::text || ' 列',
         case when count(*) = 0 then '✅ 乾淨'
              else '❌ 有非安幸的訂單被拆成月認列了' end
    from public.revenue_recognitions r
    join public.orders o on o.id = r.order_id
   where o.book <> 'anxing'

) v order by ord;


-- ============================================================
-- 第 1 項如果是 ⚠，跑這支貼給我
-- ============================================================
/*
 * 認列觸發器的名稱可能跟我猜的不同（我用 `proname ~ 'recogn'` 去找）。
 * 找不到的話下面這支會列出 orders 上所有的觸發器。
 */
-- select t.tgname as "觸發器", p.proname as "函式",
--        pg_get_triggerdef(t.oid) as "定義"
-- from pg_trigger t
-- join pg_class c on c.oid = t.tgrelid
-- join pg_proc  p on p.oid = t.tgfoid
-- where c.relname = 'orders' and not t.tgisinternal
-- order by t.tgname;
