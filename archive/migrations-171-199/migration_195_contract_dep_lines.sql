/*
 * migration_195 —— 契約的押金／訂金也要維護 lines
 * ============================================================
 * 2026-09-01。migration_194 的自檢 ⑤ 照出 7 筆「amount 與 lines 對不起來」。
 * 攤開之後:6 筆是我的檢查誤報（lines 空的，`depLines()` 本來就會退回用
 * amount），**1 筆是真的** ——
 *
 *     8b24080a  契約押金  amount = 34,000
 *                        lines  = [{"amt":9000,"cur":"TWD"}]
 *
 *   而畫面上讀的是 lines。**押金管理頁顯示 9,000，少了 25,000。**
 *
 * ============================================================
 * 【★★★ 根本原因:兩支契約同步函式從來不寫 lines】
 *
 *   sync_contract_deposits()   migration_174:126  只 set amount
 *   sync_contract_earnest()    migration_176:53   只 set amount
 *
 * 訂單那支（sync_order_deposits）一直有寫 lines，契約這兩支沒有。
 * 所以只要某個契約押金**曾經**從別的路徑拿到 lines 值，
 * 之後契約金額一改，amount 更新了而 lines 留在原地 ——
 *
 *   · 不會報錯
 *   · 總額看起來很正常
 *   · 只有畫面上那個數字是舊的
 *
 * ★★ 這是「一份資料兩個地方存」的典型下場。修法不是去對帳，
 *   是**讓寫的人只有一個** —— 兩支函式從今天起一起維護 lines，
 *   跟訂單那支的行為對齊。
 *
 * ============================================================
 * 【★ amount 還是 lines 才對？】
 *
 *   amount 是 trigger 每次存契約都從 `contracts.deposit` 寫進去的
 *   —— 它**定義上**跟契約一致。
 *   lines 沒有任何現行程式在寫（前端整份 grep 過，一處都沒有）。
 *
 *   所以 amount 是對的，lines 是孤兒值。★ 自檢第 3 列會把那一筆的
 *   前後值印出來，跑完請對一下那張契約上的押金金額。
 *
 * ============================================================
 * 【只重建「單純的台幣列」】
 *
 * 契約押金是 trigger 產生的，一律 TWD 一筆。但萬一有列帶了外幣明細
 * （來源不明），重建會把它抹掉 —— 那是拿一個看得見的問題換一個看不見的。
 * 所以只動「沒有明細」或「只有台幣明細」的列，其餘跳過並在自檢裡點名。
 */

-- ══════════════════════════════════════════════════════════
-- ① 押金：加上 lines
-- ══════════════════════════════════════════════════════════
create or replace function public.sync_contract_deposits() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(new.deposit, 0) > 0 then
    insert into deposits (contract_id, currency, amount, lines,
                          estate_id, room, guest_name, kind)
    values (new.id, 'TWD', new.deposit,
            /*
             * ★ 跟 sync_order_deposits() 同一個形狀:`item` 明寫「一般押金」。
             *   契約沒有寵物押金（那是短租的事），但形狀一致才不用
             *   在顯示端分兩種情況處理。
             */
            jsonb_build_array(jsonb_build_object(
              'cur', 'TWD', 'amt', new.deposit, 'item', '一般押金')),
            new.estate_id, new.room, new.tenant_name, 'deposit')
    on conflict (contract_id, currency, kind) where contract_id is not null
    do update set amount = excluded.amount,
                  -- ★★ 這一行是這支的重點。少了它，amount 更新而 lines 留在原地。
                  lines = excluded.lines,
                  estate_id = excluded.estate_id,
                  room = excluded.room, guest_name = excluded.guest_name, orphaned = false;
  else
    delete from deposits
     where contract_id = new.id and kind = 'deposit' and received_on is null;
    update deposits set orphaned = true
     where contract_id = new.id and kind = 'deposit' and received_on is not null;
  end if;
  return new;
end $$;


-- ══════════════════════════════════════════════════════════
-- ② 訂金：同樣的洞，同樣的補法
-- ══════════════════════════════════════════════════════════
create or replace function public.sync_contract_earnest() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(new.earnest_amount, 0) > 0 then
    insert into deposits (contract_id, currency, amount, lines,
                          estate_id, room, guest_name, kind)
    values (new.id, 'TWD', new.earnest_amount,
            jsonb_build_array(jsonb_build_object(
              'cur', 'TWD', 'amt', new.earnest_amount, 'item', '一般押金')),
            new.estate_id, new.room, new.tenant_name, 'earnest')
    on conflict (contract_id, currency, kind) where contract_id is not null
    do update set amount = excluded.amount,
                  lines = excluded.lines,
                  estate_id = excluded.estate_id,
                  room = excluded.room, guest_name = excluded.guest_name, orphaned = false;
  else
    /*
     * ★ `kind = 'earnest'` 那三個字不能少 —— 少了會把押金也清掉（migration_176）。
     */
    delete from deposits
     where contract_id = new.id and kind = 'earnest' and received_on is null;
    update deposits set orphaned = true
     where contract_id = new.id and kind = 'earnest' and received_on is not null;
  end if;
  return new;
end $$;


-- ══════════════════════════════════════════════════════════
-- ③ 修既有的列
-- ══════════════════════════════════════════════════════════
/*
 * ★ 只動契約來的列（`contract_id is not null`），而且只動
 *   「沒有明細」或「只有台幣明細」的 —— 帶外幣的跳過，自檢第 4 列會點名。
 *
 * ★★ 這一步同時做兩件事:
 *     · 把 8b24080a 的 lines 從 9,000 校正成 amount（34,000）
 *     · 把其餘空的 lines 補起來，讓所有列的形狀一致
 *
 *   第二件事**不改變任何畫面上的數字**（空 lines 本來就退回用 amount），
 *   但它消掉了「有些列有 lines、有些沒有」這個狀態 ——
 *   而那個狀態正是這次找了半天才看懂的原因。
 */
update public.deposits d
   set lines = jsonb_build_array(jsonb_build_object(
                 'cur', 'TWD', 'amt', d.amount, 'item', '一般押金'))
 where d.contract_id is not null
   and coalesce(d.amount, 0) > 0
   and not exists (
         select 1 from jsonb_array_elements(
                        case when jsonb_typeof(d.lines) = 'array' then d.lines else '[]'::jsonb end) l
          where upper(l->>'cur') <> 'TWD')
   and round(coalesce(d.amount, 0), 2) <> round((
         select coalesce(sum((l->>'amt')::numeric), 0)
           from jsonb_array_elements(
                  case when jsonb_typeof(d.lines) = 'array' then d.lines else '[]'::jsonb end) l
          where upper(l->>'cur') = 'TWD'), 2);


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('195_contract_dep_lines');
  end if;
end $$;


-- ══════════════════════════════════════════════════════════
-- 自檢。
-- ★★★ 這次的 ② 是**修好的版本**:194 那條把「lines 是空的」也算成
--   不一致，於是 6 筆正常資料被誤報，真正的那 1 筆埋在裡面差點被當成雜訊。
--   空 lines 是合法形狀（`depLines()` 會退回用 amount）—— 檢查要放它過。
-- ★ prokind 過濾不能省（2026-09-01 踩過 array_agg）。
-- ══════════════════════════════════════════════════════════
select v."檢查項目", v."結果", v."說明" from (

  select 1, '★★★ ① 兩支函式都會寫 lines 了',
         (select case when count(*) = 2 then '✅ 兩支都有 `lines = excluded.lines`'
                      else '⚠ 只有 ' || count(*) || ' 支 —— 另一支還是只寫 amount' end
            from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.prokind in ('f', 'p')
             and p.proname in ('sync_contract_deposits', 'sync_contract_earnest')
             and pg_get_functiondef(p.oid) ilike '%lines = excluded.lines%'),
         '★ 少一支的話那一種 kind 的 lines 還是會留在原地變成舊值'

  union all
  /*
   * ★★ 修好的一致性檢查:空 lines 放行。
   *   基準值是「對不起來的筆數」，正確答案永遠是 0，
   *   跟這支改了多少列無關（避開 migration_187／191 的坑）。
   */
  select 2, '★★ ② amount 與 lines 一致（空 lines 視為正常）',
         (select case when count(*) = 0
                      then '✅ 全部對得起來'
                      else '⚠ 還有 ' || count(*) || ' 筆不一致' end
            from public.deposits d
           where coalesce(jsonb_array_length(
                   case when jsonb_typeof(d.lines) = 'array' then d.lines else '[]'::jsonb end), 0) > 0
             and exists (select 1 from jsonb_array_elements(d.lines) l where upper(l->>'cur') = 'TWD')
             and round(coalesce(d.amount, 0), 2) <> round((
                   select coalesce(sum((l->>'amt')::numeric), 0)
                     from jsonb_array_elements(d.lines) l
                    where upper(l->>'cur') = 'TWD'), 2)),
         '★ 「lines 是空的」是合法形狀，depLines() 會退回用 amount —— 194 那條沒放它過，'
           || '結果 6 筆正常資料被誤報，真正壞掉的那 1 筆差點被當成雜訊'

  union all
  select 3, '★★★ ③ 8b24080a 那一筆現在是多少',
         coalesce((select 'amount=' || d.amount || '　lines 台幣合計='
                     || coalesce((select sum((l->>'amt')::numeric)
                                    from jsonb_array_elements(d.lines) l
                                   where upper(l->>'cur') = 'TWD'), 0)
                     || '　契約上的押金=' || coalesce(c.deposit::text, '（查不到契約）')
                     from public.deposits d
                     left join public.contracts c on c.id = d.contract_id
                    where d.id::text like '8b24080a%'),
                  '（找不到這一筆）'),
         '★★★ 三個數字要一樣。跑完請打開那張契約對一下 —— '
           || '原本畫面顯示 9,000，修成 amount（34,000）。'
           || '如果契約上真的是 9,000，那是 amount 錯了，跟我說，我補一支反過來修'

  union all
  select 4, '④ 有沒有帶外幣而被跳過的契約押金',
         (select case when count(*) = 0 then '✅ 沒有（契約押金本來就只有台幣）'
                      else '⚠ 有 ' || count(*) || ' 筆帶外幣明細，這支沒動它們：'
                           || string_agg(left(id::text, 8), '、') end
            from public.deposits d
           where d.contract_id is not null
             and exists (select 1 from jsonb_array_elements(
                                        case when jsonb_typeof(d.lines) = 'array' then d.lines else '[]'::jsonb end) l
                          where upper(l->>'cur') <> 'TWD')),
         '★ 重建會抹掉外幣明細 —— 拿一個看得見的問題換一個看不見的，不划算'

  union all
  select 5, '⑤ 契約押金的 lines 形狀一致了',
         (select count(*) filter (where has_lines)::text || ' / ' || count(*)::text
                 || ' 筆有明細'
            from (select coalesce(jsonb_array_length(
                           case when jsonb_typeof(d.lines) = 'array' then d.lines else '[]'::jsonb end), 0) > 0 has_lines
                    from public.deposits d
                   where d.contract_id is not null and coalesce(d.amount, 0) > 0) x),
         '★ 兩個數字要一樣。補空 lines **不改變畫面上任何數字**（空的本來就退回用 amount），'
           || '但它消掉「有些有、有些沒有」這個狀態 —— 那正是這次查了半天的原因'

  union all
  select 6, '⑥ 金額沒被動到',
         (select count(*)::text || ' 筆押金 ／ 台幣總額 '
                 || coalesce(sum(amount), 0)::text from public.deposits),
         '★ amount 一個字都沒改，這支只重建 lines。總額要跟 194 那次一樣（18,227,948）'

) v(ord, "檢查項目", "結果", "說明") order by v.ord;
