/*
 * 刪-房源14B4-v3.sql　2026-09-16
 *
 * 【v2 為什麼炸掉】
 *
 *     ERROR: P0001: 客戶的姓名、房源、住宿起訖是從訂單與契約帶過來的，不能在這裡改。
 *     CONTEXT: customers_guard() line 13
 *     SQL statement "UPDATE ONLY customers SET property_id = NULL WHERE ..."
 *
 * ══════════════════════════════════════════════════════════
 * ★★★ 這是一個**我沒想到的互動**，而且它很值得記下來：
 *
 *   `ON DELETE SET NULL` 不是資料庫默默改一個欄位 ——
 *   它會發出一個**真正的 UPDATE**，而那個 UPDATE 一樣會踩到
 *   `customers` 上面的 BEFORE UPDATE 觸發器。
 *   那支守衛的本意是「不准人在客戶管理頁改房源」，
 *   結果它連資料庫自己的連動更新一起擋了。
 *
 *   ★ 所以「這條外鍵是 SET NULL，很安全」這個判斷**只對了一半**:
 *     它不會刪掉別人的資料沒錯，但它也**不見得跑得完**。
 *
 * ★★ 解法不是把守衛關掉。守衛是對的 —— 那三個欄位本來就該由
 *   `sync_customers()` 一個人維護。要動的是**那一列客戶本身**。
 * ══════════════════════════════════════════════════════════
 *
 * 【這支怎麼做】
 *   ① 先看那一列客戶的**人工欄位**（電話／Email／備註）。
 *      那三欄是人手動填的，同步永遠不動 —— 它們才是會弄丟的東西。
 *      ★ 有東西就**什麼都不做**，把內容印出來讓你決定。
 *        系統負責看見，人負責決定。
 *   ② 三欄都空 → 刪掉那一列客戶（它對不到任何訂單或契約，
 *      `sync_customers()` 不會把它變回來）→ 再刪房源。
 *   ③ 任何一步被擋 → 停在那裡，把錯誤原文印出來，
 *      並附上「改成停用」那一行可以直接跑的 SQL。
 *
 * 【可以重複跑】第二次會回「找不到 14B4」，不會出錯。
 */

drop table if exists _del14b4;
create temp table _del14b4 (
  ord int,
  k   text,
  v   text,
  ok  boolean
);

do $fn$
declare
  v_id     uuid;
  c        record;
  r        record;
  n        bigint;
  blocked  int := 0;
  humans   int := 0;
  killed   int := 0;
  rule     text;
begin
  select id into v_id from public.properties where name = '14B4';

  if v_id is null then
    insert into _del14b4 values (0, '結論',
      '找不到叫 14B4 的房源 —— 前一次已經刪掉了，這次什麼都沒做。', true);
    return;
  end if;

  /* ══ ① 擋不擋得住的那幾條外鍵（CASCADE／RESTRICT 有列就停）══ */
  for r in
    select t.relname::text as tbl,
           a.attname::text as col,
           /* ★ confdeltype 是 "char" 不是 text（2026-09-01 踩過） */
           c2.confdeltype::text as del
    from pg_constraint c2
    join pg_class t      on t.oid = c2.conrelid
    join pg_namespace ns on ns.oid = t.relnamespace
    join pg_attribute a  on a.attrelid = c2.conrelid and a.attnum = c2.conkey[1]
    where c2.contype = 'f'
      and c2.confrelid = 'public.properties'::regclass
      and ns.nspname = 'public'
    order by t.relname
  loop
    execute format('select count(*) from public.%I where %I = $1', r.tbl, r.col)
      into n using v_id;
    if n = 0 then continue; end if;

    rule := case r.del when 'c' then 'ON DELETE CASCADE'
                       when 'n' then 'ON DELETE SET NULL'
                       when 'd' then 'ON DELETE SET DEFAULT'
                       when 'r' then 'RESTRICT' else 'NO ACTION' end;

    if r.tbl = 'customers' then
      insert into _del14b4 values (20, '客戶 customers.' || r.col,
        n || ' 列・' || rule || ' → 底下單獨處理', true);
    else
      insert into _del14b4 values (10, '外鍵 ' || r.tbl || '.' || r.col,
        n || ' 列指著 14B4・' || rule, false);
      blocked := blocked + 1;
    end if;
  end loop;

  /* ══ ② 房號**字串**（訂單／契約）══ */
  select count(*) into n from public.orders where property_raw = '14B4';
  if n > 0 then
    insert into _del14b4 values (11, '訂單 orders.property_raw',
      n || ' 筆房號寫著 14B4', false);
    blocked := blocked + 1;
  end if;
  select count(*) into n from public.contracts where room = '14B4';
  if n > 0 then
    insert into _del14b4 values (12, '契約 contracts.room',
      n || ' 張房號寫著 14B4', false);
    blocked := blocked + 1;
  end if;

  if blocked > 0 then
    insert into _del14b4 values (0, '結論',
      '沒有刪 —— 上面標 ⚠ 的那幾列擋住了。改成停用：'
      || 'update public.properties set active = false, show_in_room_calendar = false where id = '''
      || v_id || '''', false);
    return;
  end if;

  /* ══ ③ 那幾列客戶的人工欄位 —— 有東西就停下來 ══ */
  for c in
    select id, name,
           coalesce(phone, '') as phone,
           coalesce(email, '') as email,
           coalesce(note,  '') as note,
           stale
    from public.customers
    where property_id = v_id
  loop
    if c.phone <> '' or c.email <> '' or c.note <> '' then
      humans := humans + 1;
      insert into _del14b4 values (15,
        '客戶「' || c.name || '」有人工填過的資料',
        '電話 ' || coalesce(nullif(c.phone, ''), '—')
        || '・Email ' || coalesce(nullif(c.email, ''), '—')
        || '・備註 ' || coalesce(nullif(c.note, ''), '—'), false);
    else
      insert into _del14b4 values (21,
        '客戶「' || c.name || '」',
        '電話／Email／備註都是空的'
        || case when c.stale then '・來源已不存在' else '' end
        || ' → 會刪掉這一列', true);
    end if;
  end loop;

  if humans > 0 then
    insert into _del14b4 values (0, '結論',
      '沒有刪 —— 有 ' || humans || ' 位客戶身上有人手動填過的東西（上面印出來了）。'
      || '那些是同步永遠不會還原的資料，我不替你決定。'
      || '　想保留就先把內容抄走、或改成停用：'
      || 'update public.properties set active = false, show_in_room_calendar = false where id = '''
      || v_id || '''', false);
    return;
  end if;

  /* ══ ④ 先刪客戶，再刪房源。任何一步被擋就停在那裡 ══ */
  begin
    delete from public.customers where property_id = v_id;
    get diagnostics killed = row_count;
  exception when others then
    insert into _del14b4 values (0, '結論',
      '刪不掉那一列客戶，整支停在這裡（什麼都沒改）。資料庫說：' || sqlerrm
      || '　→ 改成停用：update public.properties set active = false, '
      || 'show_in_room_calendar = false where id = ''' || v_id || '''', false);
    return;
  end;

  begin
    delete from public.properties where id = v_id;
  exception when others then
    insert into _del14b4 values (0, '結論',
      '客戶刪掉了，但房源刪不掉。資料庫說：' || sqlerrm
      || '　→ 改成停用：update public.properties set active = false, '
      || 'show_in_room_calendar = false where id = ''' || v_id || '''', false);
    return;
  end;

  insert into _del14b4 values (0, '結論',
    '已刪除 14B4（id ' || v_id || '），連同 ' || killed || ' 列對不到來源的客戶。', true);
end
$fn$;

/*
 * ★★★ 自檢。
 *
 * ★★ 看不到這張表 ＝ **整支回滾了**，不是「跑成功但沒輸出」。
 *   自檢在刪除後面，成功就一定看得到。
 *
 * ★ 前三列是**驗證結果**不是參考值:重新去表裡問一次，
 *   不相信上面那段自己說的話（2026-09-03 踩過那條）。
 */
select
  t.k as "檢查",
  t.v as "內容",
  case when t.ok then '✅' else '⚠' end as "判定"
from (
  select -10 as ord, k, v, ok from _del14b4 where ord = 0

  union all
  select -9, '房源刪掉了沒（重新問 properties）',
         case when exists (select 1 from public.properties where name = '14B4')
              then '14B4 還在表裡' else '表裡已經沒有 14B4' end,
         not exists (select 1 from public.properties where name = '14B4')

  union all
  select -8, '同一棟剩下哪幾間',
         coalesce((select string_agg(name, '、' order by name)
                     from public.properties where name like '14B%'), '（一間都沒有）'),
         (select count(*) from public.properties where name like '14B%') = 4

  union all
  /* ★ 客戶總數印出來 —— 刪掉的應該只有指著 14B4 的那幾列 */
  select -7, '客戶總數（刪掉的應該只有對不到來源的那幾列）',
         (select count(*)::text from public.customers) || ' 位',
         true

  union all
  select ord, k, v, ok from _del14b4 where ord > 0
) t
order by t.ord, t.k;
