-- migration_175：清掉 174 漏網的舊唯一索引
--
-- ============================================================
-- 【症狀】（2026-08-24，174 的第一項自檢）
--
--     ❌ duplicate key value violates unique constraint "dep_contract_once_idx"
--
-- 同一張契約存訂金 ＋ 押金兩列時撞上去。
--
--
-- ============================================================
-- 【原因：174 的清理條件寫太窄】
--
-- 174 是這樣找舊索引的:
--
--     where indexdef like '%contract_id%currency%'
--       and indexdef not like '%kind%'
--
-- 它假設舊索引一定含 `currency`。而 `dep_contract_once_idx`
-- **不含 currency** —— 它是 `(contract_id)` 單欄的唯一索引
-- （名字就寫著 once:一張契約只能有一列）。
--
-- 所以 174 建了新索引、刪了另外幾顆，卻把真正擋路的那顆留著。
--
--
-- ============================================================
-- 【★★ 更糟的是那個自檢是假的綠燈】
--
-- 174 的第 6 項「舊索引已經清掉」回了 ✅，而實際上沒有。
-- 因為它的檢查條件**跟清理條件一模一樣**:
--
--     清理：indexdef like '%contract_id%currency%' and not like '%kind%'
--     檢查：indexdef like '%contract_id%currency%' and not like '%kind%'
--
-- 用同一個條件去檢查自己做過的事，**永遠會通過** ——
-- 漏網的那顆兩邊都看不到。
--
-- 這跟 167 那次（「以目前連線的角色實測」恆為假）是同一種錯:
-- **自檢必須從另一個角度問**，不能複製一份被檢查的邏輯。
--
-- 所以這一支的檢查改成問「deposits 上還有幾顆**唯一**索引提到
-- contract_id 卻沒提到 kind」—— 那是結果，不是過程。
-- ============================================================

create temp table _chk175 (ord int, item text, result text, note text) on commit drop;

-- 先記下動手前的狀態，之後才對得出來改了什麼
insert into _chk175
select 0, '動手前的舊唯一索引',
       coalesce(string_agg(i.relname, '、'), '(沒有)'),
       '這些就是擋住訂金的東西'
  from pg_index x
  join pg_class i on i.oid = x.indexrelid
  join pg_class t on t.oid = x.indrelid
  join pg_namespace n on n.oid = t.relnamespace
 where n.nspname = 'public' and t.relname = 'deposits'
   and x.indisunique and not x.indisprimary
   and pg_get_indexdef(x.indexrelid) like '%contract_id%'
   and pg_get_indexdef(x.indexrelid) not like '%kind%';


-- ============================================================
-- 清掉所有「提到 contract_id 但沒提到 kind」的唯一索引
-- ============================================================
/*
 * ★ 用 pg_index 而不是 pg_indexes，因為要判斷 `indisunique`。
 *
 *   不分唯一與否的話會連一般查詢索引（例如 dep_contract_idx）
 *   一起刪掉 —— 那不會壞掉，但押金頁會突然變慢，
 *   而且沒有人會聯想到是這支 migration。
 *
 * ★ `not indisprimary` —— 主鍵不能刪。
 */
do $$
declare idx_name text;
begin
  for idx_name in
    select i.relname
      from pg_index x
      join pg_class i on i.oid = x.indexrelid
      join pg_class t on t.oid = x.indrelid
      join pg_namespace n on n.oid = t.relnamespace
     where n.nspname = 'public' and t.relname = 'deposits'
       and x.indisunique and not x.indisprimary
       and pg_get_indexdef(x.indexrelid) like '%contract_id%'
       and pg_get_indexdef(x.indexrelid) not like '%kind%'
  loop
    execute format('drop index if exists public.%I', idx_name);
    raise notice '已刪除舊唯一索引: %', idx_name;
  end loop;
end $$;

-- 174 建的那顆確認還在（if not exists，重跑安全）
create unique index if not exists deposits_contract_kind_uidx
  on public.deposits (contract_id, currency, kind)
  where contract_id is not null;


-- ============================================================
-- 順帶檢查 order_id 那邊有沒有同樣的問題
-- ============================================================
/*
 * `deposits` 也可以掛在訂單上（order_id）。訂單那邊**不需要** kind ——
 * 訂單只有押金，沒有訂金（訂金是契約階段的東西）。
 *
 * 所以 order_id 的唯一索引維持原狀，這裡只是列出來讓人看一眼，
 * 確認沒有被上面那段誤刪。
 */
insert into _chk175
select 1, '★ order_id 的索引沒被誤刪',
       coalesce(string_agg(i.relname, '、'), '⚠ 一顆都沒有'),
       '訂單只有押金沒有訂金,那邊不需要 kind'
  from pg_index x
  join pg_class i on i.oid = x.indexrelid
  join pg_class t on t.oid = x.indrelid
  join pg_namespace n on n.oid = t.relnamespace
 where n.nspname = 'public' and t.relname = 'deposits'
   and x.indisunique
   and pg_get_indexdef(x.indexrelid) like '%order_id%';


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('175_fix_earnest_index');
  end if;
end $$;


-- ============================================================
-- 驗證
-- ============================================================
/*
 * ★★ 一模一樣的實測:同一張契約存訂金 ＋ 押金。
 *   174 的這一題是 ❌，這裡要變成 ✅ 才算修好。
 */
do $$
declare v_ct uuid; v_msg text;
begin
  select id into v_ct from public.contracts limit 1;
  if v_ct is null then
    insert into _chk175 values (2, '★★ 同一張契約存兩種暫收', '⚠ 測不出來', '一張契約都沒有');
    return;
  end if;

  begin
    insert into public.deposits (contract_id, currency, amount, kind)
    values (v_ct, 'TWD', 30000, 'deposit')
    on conflict (contract_id, currency, kind) where contract_id is not null
    do update set amount = excluded.amount;

    insert into public.deposits (contract_id, currency, amount, kind)
    values (v_ct, 'TWD', 10000, 'earnest')
    on conflict (contract_id, currency, kind) where contract_id is not null
    do update set amount = excluded.amount;

    v_msg := '✅ 兩列都存進去了';
    raise exception using errcode = 'restrict_violation', message = '__rollback__';
  exception when others then
    if sqlerrm <> '__rollback__' then v_msg := '❌ ' || sqlerrm; end if;
  end;

  insert into _chk175 values (2, '★★ 同一張契約存兩種暫收', coalesce(v_msg, '⚠ 沒跑到'),
    '174 這一題是 ❌,這裡要 ✅');
end $$;


select "檢查項目", "結果", "說明" from (

  select c.ord, c.item as "檢查項目", c.result as "結果", c.note as "說明"
    from _chk175 c

  union all
  /*
   * ★★ 這一項就是 174 寫錯的那個。
   *
   *   174 用「清理時的同一個條件」去檢查，所以永遠通過。
   *   這裡改成問**結果**:還有幾顆唯一索引提到 contract_id 卻沒提到 kind。
   *   不管它叫什麼名字、含不含 currency，都逃不掉。
   */
  select 3, '★★ 還有幾顆舊唯一索引',
         count(*)::text || ' 顆'
         || case when count(*) > 0
                 then '　（' || string_agg(i.relname, '、') || '）' else '' end,
         case when count(*) = 0 then '✅ 清乾淨了' else '❌ 訂金還是會撞上去' end
    from pg_index x
    join pg_class i on i.oid = x.indexrelid
    join pg_class t on t.oid = x.indrelid
    join pg_namespace n on n.oid = t.relnamespace
   where n.nspname = 'public' and t.relname = 'deposits'
     and x.indisunique and not x.indisprimary
     and pg_get_indexdef(x.indexrelid) like '%contract_id%'
     and pg_get_indexdef(x.indexrelid) not like '%kind%'

  union all
  select 4, '★ 新索引還在',
         coalesce((select indexdef from pg_indexes
                    where schemaname = 'public'
                      and indexname = 'deposits_contract_kind_uidx'),
                  '❌ 不見了'),
         '要有 kind,而且要保留 WHERE contract_id IS NOT NULL'

  union all
  select 5, '★ deposits 上所有的唯一索引',
         string_agg(i.relname || '：' || pg_get_indexdef(x.indexrelid), '　｜　'),
         '看一眼有沒有誤刪'
    from pg_index x
    join pg_class i on i.oid = x.indexrelid
    join pg_class t on t.oid = x.indrelid
    join pg_namespace n on n.oid = t.relnamespace
   where n.nspname = 'public' and t.relname = 'deposits'
     and x.indisunique and not x.indisprimary

  union all
  select 6, '★ 既有押金沒有被動到',
         count(*) filter (where kind = 'deposit')::text || ' 筆押金 ／ '
         || count(*) filter (where kind = 'earnest')::text || ' 筆訂金',
         '應為 101 / 0'
    from public.deposits

) v order by ord;
