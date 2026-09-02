/*
 * migration_185 —— 現金流水的收據照片
 * ============================================================
 * 2026-08-31 使用者：「現金 存進去 可以幫我設計 上傳圖片功能嗎？」
 *                     「已存的可以再上傳嗎」→ 可以，點列上的 📎 展開
 *
 * 【為什麼現金特別需要照片】
 *
 * 銀行流水有對帳單當靠山 —— 金額對不上時可以回去翻 PDF。
 * **現金沒有。** 它的唯一來源是那個 key 的人，
 * 而三個月後沒有人記得「8/18 收陳小胖 8000」是怎麼回事。
 *
 * 收據照片是這筆錢**唯一的第三方證據**。
 *
 * ★★ 支出也給，不只存入（使用者說的是「存進去」，但支出更需要）——
 *   現金付出去連對方的入帳紀錄都沒有，收據是唯一的東西。
 *   收入至少還有房客那邊對得上。
 *
 * ============================================================
 * 【第九種母體，沿用既有的 attachments】
 *
 *   pr  請款單        pri 請款項目      exp 支出
 *   dep 押金          dp  押金收款      op  短租收款
 *   of  訂單加費      td  標案          cash 現金流水 ← 這一支加的
 *
 * ★ 不另開一張表。附件的權限、簽名網址、軟刪除、縮圖壓縮
 *   都在既有那一套裡，另開一張等於把那些全部重寫一次 ——
 *   而重寫的那份會慢慢跟本來那份長得不一樣。
 *
 * ============================================================
 * 【★★★ 這支動到三個「全站共用」的東西】
 *
 *   1. `attachments` 的 att_one_parent 約束（八種附件共用）
 *   2. `can_see_receipt()`（看得到哪些附件）
 *   3. `can_edit_receipt()`（改得動哪些附件）
 *
 * 三個都是**改壞了不會報錯、只會讓某些人看不到或看得到不該看的**。
 * 所以三個都採同一個策略:**讀線上的定義來改，不照 baseline 重寫**
 * （README 9.5:schema-baseline.sql 不可信）。
 *
 * 對不上就整支中止 —— 用一份猜的定義覆蓋線上的，
 * 它照樣建得起來，只是擋錯東西，而那不會有任何錯誤訊息。
 */

create temp table _chk185 (ord int, item text, result text, note text) on commit drop;

-- ============================================================
-- ① attachments 加 bank_transaction_id
-- ============================================================
alter table public.attachments
  add column if not exists bank_transaction_id uuid;

do $$
begin
  alter table public.attachments
    drop constraint if exists attachments_bank_transaction_id_fkey;
  alter table public.attachments
    add constraint attachments_bank_transaction_id_fkey
    foreign key (bank_transaction_id) references public.bank_transactions(id) on delete cascade;
end $$;

/*
 * ★ `on delete cascade`:流水被刪掉時附件紀錄跟著刪。
 *
 * ★★ 但 **storage 裡的檔案本體不會跟著刪** —— 那是另一個系統。
 *   結果是 bucket 裡留下沒有人指得到的孤兒檔案。
 *   既有八種母體全部都是這個行為,這裡跟著一致 ——
 *   要清的話是另一件事（掃 storage 對 attachments 的差集），不在這一支。
 */

comment on column public.attachments.bank_transaction_id is
  '現金流水的收據照片（migration_185）。路徑前綴 cash/。'
  '只有 kind=cash 的帳戶會用到 —— 銀行流水是對帳單的鏡像，不接受附件。';

create index if not exists att_bank_txn_idx on public.attachments (bank_transaction_id)
  where bank_transaction_id is not null;

-- ============================================================
-- ② att_one_parent 整條重建
-- ============================================================
/*
 * ★★ 欄位清單**去問線上**，不寫死（照 migration_179 的做法，那支踩過兩次）。
 *
 *   第一版寫死欄位名     → column "order_id" does not exist
 *   第二版只認 num_nonnulls → 線上其實是「IS NOT NULL 相加」的形狀
 *
 * 所以兩種寫法都認，撈到之後一律重建成 `num_nonnulls(...) = 1`。
 */
do $$
declare def text; cols text; n int;
begin
  select pg_get_constraintdef(oid) into def
    from pg_constraint
   where conrelid = 'public.attachments'::regclass and conname = 'att_one_parent';

  if def is null then
    raise exception 'attachments 上找不到 att_one_parent —— 這支 migration 的前提不成立';
  end if;

  if position('bank_transaction_id' in def) > 0 then
    insert into _chk185 values (2, '② att_one_parent', '↷ 已含 bank_transaction_id，跳過',
      '這支 migration 重跑是安全的');
  else
    -- ① num_nonnulls(...) 的寫法
    cols := btrim(substring(def from 'num_nonnulls\(([^)]*)\)'));

    -- ② 一堆 IS NOT NULL 相加的寫法
    if cols is null or cols = '' then
      select string_agg(m[1], ', ' order by m[1]) into cols
        from regexp_matches(def, '([a-z_][a-z0-9_]*)\s+IS\s+NOT\s+NULL', 'gi') as m;
    end if;

    if cols is null or cols = '' then
      raise exception 'att_one_parent 認不出欄位清單，請人工處理：%', def;
    end if;

    n := length(cols) - length(replace(cols, ',', '')) + 1;
    -- ★ 少於 3 欄一定是解析錯了 —— 這張表最少也有請款、支出、押金三個 parent
    if n < 3 then
      raise exception 'att_one_parent 只解析出 % 欄（%），不合理，請人工確認：%', n, cols, def;
    end if;

    execute 'alter table public.attachments drop constraint att_one_parent';
    execute format(
      'alter table public.attachments add constraint att_one_parent check (num_nonnulls(%s, bank_transaction_id) = 1)',
      cols);

    insert into _chk185 values (2, '② att_one_parent',
      '✅ 原有 ' || n || ' 欄 ＋ bank_transaction_id',
      '線上原本是：' || cols);
  end if;
end $$;

-- ============================================================
-- ③ 附件的可見性與可編輯性：cash/ 前綴
-- ============================================================
/*
 * ★★ 讀線上定義 ＋ 錨點注入，**對不上就整支中止**。
 *
 *   `can_see_receipt` / `can_edit_receipt` 不在這一支的掌控範圍內
 *   （migration_171、179 都改過）。照 baseline 重寫等於用一份可能過期的
 *   定義覆蓋線上的，**而且不會有任何錯誤訊息**。
 *
 * ★★★ 現金收據跟**支出**同一級:accountant / manager / super_admin。
 *
 *   那三個角色在既有的第一條分支裡已經是 `then true` —— 所以
 *   **其實不用加任何分支它們就看得到了**。
 *
 *   這一段真正要做的是相反的事:確認**沒有人被意外放行**。
 *   `else` 那條分支是「自己送的請款單底下的附件」，
 *   它 join 的是 purchase_requests，現金附件的 request_id 是 null，
 *   所以管家與一般員工會拿到 false —— 正是要的。
 *
 * ★ 因此這一段**只做檢查，不改函式**。
 *   沒事找事改一個全站共用的函式，是拿「現在是對的」去換「應該也還是對的」。
 */
do $$
declare see_def text; edit_def text;
begin
  select pg_get_functiondef(oid) into see_def
    from pg_proc where proname = 'can_see_receipt'
     and pronamespace = 'public'::regnamespace limit 1;
  select pg_get_functiondef(oid) into edit_def
    from pg_proc where proname = 'can_edit_receipt'
     and pronamespace = 'public'::regnamespace limit 1;

  if see_def is null then
    raise exception 'can_see_receipt 不存在 —— 附件的權限沒有人在管，這支 migration 的前提不成立';
  end if;

  insert into _chk185 values (3, '③ 會計以上看得到',
    case when see_def ~* 'accountant.*then true' then '✅ 既有分支已涵蓋，不用改'
         else '⚠ 找不到 accountant 那條分支，請人工確認' end,
    '現金收據跟支出同一級 —— 那三個角色本來就一律 true');

  /*
   * ★ 管家有 `op/`、`of/`、`pr/` 三個前綴的例外。
   *   確認 `cash/` **不在**裡面 —— 在的話管家會看到現金的收據，
   *   而他沒有帳戶明細這一頁可以進去，那就是純粹的資料外洩。
   */
  insert into _chk185 values (4, '③ 管家看不到現金收據',
    case when see_def like '%cash/%' then '⚠ 有 cash/ 的例外分支，請人工確認'
         else '✅ 沒有 cash/ 的例外，管家拿到 false' end,
    '管家沒有帳戶明細這一頁 —— 放行等於純粹外洩');

  insert into _chk185 values (5, '③ can_edit_receipt',
    coalesce(case when edit_def is null then '⚠ 這個函式不存在' else '✅ 存在，未改動' end, '—'),
    '刪照片走的是它。現金不需要特例 —— 會計以上本來就能改');
end $$;

-- ============================================================
-- ④ storage 的 RLS：cash/ 前綴
-- ============================================================
/*
 * receipts bucket 的 policy 是直接讀路徑判斷的（migration_51）。
 *
 * ★★ 既有的 policy 若是「呼叫 can_see_receipt(name)」的形式，
 *   那 cash/ 自動就被涵蓋了，不用動。
 *   若是寫死前綴清單（like 'pr/%' or like 'exp/%' …）就要補一條。
 *
 * ★ 所以這裡**先查再說**，把實際情況印出來 ——
 *   猜錯的症狀是「傳得上去、看不到自己剛傳的照片」（migration_171 踩過）。
 */
do $$
declare pol text;
begin
  select string_agg(policyname || ' → ' || coalesce(qual, using_expr), E'\n')
    into pol
    from (
      select policyname, qual, coalesce(with_check, '') as using_expr
        from pg_policies
       where schemaname = 'storage' and tablename = 'objects'
    ) p;

  insert into _chk185 values (6, '④ storage policy 怎麼判斷',
    case
      when pol is null then '⚠ 查不到 storage.objects 的 policy'
      when pol like '%can_see_receipt%' then '✅ 走 can_see_receipt()，cash/ 自動涵蓋'
      else '⚠ 沒有走 can_see_receipt —— 見「說明」欄，可能要補前綴'
    end,
    left(coalesce(pol, '（無）'), 300));
end $$;


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('185_cash_receipt');
  end if;
end $$;


-- ══════════════════════════════════════════════════════════
-- 自檢。★ `raise notice` 在 SQL Editor 看不到，所以回一張表。
-- ★ 排序欄位留在子查詢裡（`v.ord`）—— `order by 1` 會照文字排（migration_181 踩過）。
-- ══════════════════════════════════════════════════════════
select v."檢查項目", v."結果", v."說明" from (

  select 1, '★★★ 欄位建好了',
         coalesce((select data_type || '（' ||
                          case when is_nullable = 'YES' then '可為空，正確' else '⚠ NOT NULL' end || '）'
                     from information_schema.columns
                    where table_schema = 'public' and table_name = 'attachments'
                      and column_name = 'bank_transaction_id'), '⚠ 沒有這個欄位'),
         'uuid（可為空）—— 一個附件只掛一個母體，其餘八欄是 null'

  union all
  select ord, item, result, note from _chk185 where ord = 2

  union all
  select 7, '★★ att_one_parent 現在長這樣',
         (select pg_get_constraintdef(oid) from pg_constraint
           where conrelid = 'public.attachments'::regclass and conname = 'att_one_parent'),
         '要看到九個欄位，而且 bank_transaction_id 在裡面'

  union all
  select ord, item, result, note from _chk185 where ord in (3, 4, 5, 6)

  union all
  /*
   * ★★★ 這支動到全站共用的約束，**既有八種附件一個都不該受影響**。
   *   數字變了就是哪裡寫錯了 —— 而那種錯不會報，
   *   只會讓某一種附件從此傳不上去。
   */
  select 8, '★★★ 既有附件一個都沒動',
         (select count(*)::text || ' 個附件（'
                 || count(*) filter (where request_id is not null)::text || ' 請款單／'
                 || count(*) filter (where expense_id is not null)::text || ' 支出／'
                 || count(*) filter (where deposit_id is not null)::text || ' 押金／'
                 || count(*) filter (where bank_transaction_id is not null)::text || ' 現金）'
            from public.attachments),
         '總數跟跑之前要一模一樣，現金那一格現在應該是 0'

) v(ord, "檢查項目", "結果", "說明") order by v.ord;
