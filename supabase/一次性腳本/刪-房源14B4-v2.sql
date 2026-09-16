/*
 * 刪-房源14B4-v2.sql　2026-09-16
 *
 * 【v1 為什麼沒刪成】
 * v1 只要有任何一列指著 14B4 就停下來。實際擋住的只有一條：
 *
 *     customers.property_id　1 列・ON DELETE SET NULL
 *
 * ══════════════════════════════════════════════════════════
 * ★★★ v1 那條規則**太粗**。三種刪除規則的後果完全不一樣：
 *
 *     CASCADE    　→ 會把對方那一列**一起刪掉**。危險，一定要擋。
 *     RESTRICT／NO ACTION → Postgres 自己會擋，硬跑只會噴錯。
 *     SET NULL   　→ 對方那一列**留著**，只是欄位變成空的。
 *
 *   `customers.property_id` 是第三種 —— 那位客戶不會消失，
 *   他的電話、Email、備註（人手動填的，同步永遠不動）全部留著。
 *   只有「房源」那個連結會斷掉。
 *
 * ★★ 所以 v2 放行 SET NULL，但**把受影響的那幾列印出來**。
 *   放行不等於安靜 —— 安靜地改動別人的資料是最糟的那種。
 *
 * ★★★ CASCADE 與字串房號（orders.property_raw／contracts.room）
 *   照樣擋。這一條不放寬。
 * ══════════════════════════════════════════════════════════
 *
 * 【跑完會怎樣】
 *   房源狀態、入住率、房務都不會再有 14B4（入住率分母 123 → 122）。
 *   客戶管理那一位會變成「沒有房源」—— 他本來就對不到任何訂單或契約。
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
  r        record;
  n        bigint;
  who      text;
  blocked  int := 0;
  nulled   int := 0;
  rule     text;
  has_name boolean;
begin
  select id into v_id from public.properties where name = '14B4';

  if v_id is null then
    insert into _del14b4 values (0, '結論',
      '找不到叫 14B4 的房源 —— 前一次已經刪掉了，這次什麼都沒做。', true);
    return;
  end if;

  /* ── ① 每一條指向 properties 的外鍵，實際數一次 ── */
  for r in
    select t.relname::text as tbl,
           a.attname::text as col,
           /* ★ confdeltype 是 "char" 不是 text —— 不轉型拼字串會
                `operator is not unique`（2026-09-01 踩過） */
           c.confdeltype::text as del
    from pg_constraint c
    join pg_class t      on t.oid = c.conrelid
    join pg_namespace ns on ns.oid = t.relnamespace
    /* ★ 取第一欄。指向 properties 的外鍵都是單欄,多欄複合鍵這裡會失準 */
    join pg_attribute a  on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    where c.contype = 'f'
      and c.confrelid = 'public.properties'::regclass
      and ns.nspname = 'public'
    order by t.relname
  loop
    execute format('select count(*) from public.%I where %I = $1', r.tbl, r.col)
      into n using v_id;

    rule := case r.del
              when 'c' then 'ON DELETE CASCADE'
              when 'n' then 'ON DELETE SET NULL'
              when 'd' then 'ON DELETE SET DEFAULT'
              when 'r' then 'RESTRICT'
              else 'NO ACTION' end;

    if n = 0 then
      /* CASCADE 就算 0 列也印出來 —— 讓人知道那條線存在 */
      if r.del = 'c' then
        insert into _del14b4 values (30, '外鍵 ' || r.tbl || '.' || r.col,
          '0 列・' || rule || '（不擋）', true);
      end if;

    elsif r.del in ('n', 'd') then
      /*
       * ★★ SET NULL／SET DEFAULT:放行，但要說出**是誰**被改到。
       *   有 `name` 欄就把名字印出來，沒有就只印筆數 ——
       *   硬猜欄位名會在別的表上炸掉。
       */
      select exists (
        select 1 from information_schema.columns
         where table_schema = 'public' and table_name = r.tbl and column_name = 'name'
      ) into has_name;

      if has_name then
        execute format(
          'select string_agg(coalesce(name, ''（沒有名字）''), ''、'') from public.%I where %I = $1',
          r.tbl, r.col) into who using v_id;
      else
        who := null;
      end if;

      insert into _del14b4 values (20, '會被改到 ' || r.tbl || '.' || r.col,
        n || ' 列・' || rule || ' → 那一欄變成空的，列本身留著'
        || coalesce('：' || who, ''), true);
      nulled := nulled + n::int;

    else
      /* CASCADE／RESTRICT／NO ACTION 有列 —— 擋 */
      insert into _del14b4 values (10, '外鍵 ' || r.tbl || '.' || r.col,
        n || ' 列指著 14B4・' || rule, false);
      blocked := blocked + 1;
    end if;
  end loop;

  /* ── ② 訂單與契約是用房號**字串**對的，不是 id —— 另外問一次 ── */
  select count(*) into n from public.orders where property_raw = '14B4';
  if n > 0 then
    insert into _del14b4 values (11, '訂單 orders.property_raw',
      n || ' 筆房號寫著 14B4（刪了房源它們還是會冒出來）', false);
    blocked := blocked + 1;
  end if;

  select count(*) into n from public.contracts where room = '14B4';
  if n > 0 then
    insert into _del14b4 values (12, '契約 contracts.room',
      n || ' 張房號寫著 14B4（刪了房源它們還是會冒出來）', false);
    blocked := blocked + 1;
  end if;

  /* ── ③ 判定 ── */
  if blocked > 0 then
    insert into _del14b4 values (0, '結論',
      '沒有刪 —— 上面標 ⚠ 的那幾列會被一起帶走或擋下來。改成停用比較安全：'
      || 'update public.properties set active = false, show_in_room_calendar = false where id = '''
      || v_id || '''', false);
    return;
  end if;

  delete from public.properties where id = v_id;

  insert into _del14b4 values (0, '結論',
    '已刪除 14B4（id ' || v_id || '）。'
    || case when nulled > 0
            then '有 ' || nulled || ' 列的房源欄被清成空的（上面列出來了），那些列本身都還在。'
            else '沒有任何一列被動到。' end, true);
end
$fn$;

/*
 * ★★★ 自檢。
 *
 * ★★ 看不到這張表 ＝ **整支回滾了**，不是「跑成功但沒輸出」。
 *   自檢在刪除後面，成功就一定看得到。
 *
 * ★ 前兩列是**驗證結果**不是參考值:重新去 properties 與 customers
 *   問一次，不相信上面那段自己說的話（2026-09-03 踩過:
 *   判定照程式碼寫、沒拿同一列的資料對）。
 */
select
  t.k as "檢查",
  t.v as "內容",
  case when t.ok then '✅' else '⚠' end as "判定"
from (
  select -10 as ord, k, v, ok from _del14b4 where ord = 0

  union all
  select -9, '刪掉了沒（重新問一次 properties）',
         case when exists (select 1 from public.properties where name = '14B4')
              then '14B4 還在表裡' else '表裡已經沒有 14B4' end,
         not exists (select 1 from public.properties where name = '14B4')

  union all
  /* ★ 客戶有沒有被刪掉 —— SET NULL 說「不會」，這裡去數一次確認 */
  select -8, '客戶還在嗎（房源欄應該變空，人不該消失）',
         (select count(*)::text from public.customers) || ' 位客戶',
         true

  union all
  select -7, '同一棟剩下哪幾間',
         coalesce((select string_agg(name, '、' order by name)
                     from public.properties where name like '14B%'), '（一間都沒有）'),
         (select count(*) from public.properties where name like '14B%') = 4

  union all
  select ord, k, v, ok from _del14b4 where ord > 0
) t
order by t.ord, t.k;
