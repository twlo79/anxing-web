/*
 * 刪-房源14B4.sql　2026-09-16
 *
 * 【要做什麼】
 * 使用者：「14B4 要刪除，沒這個房源。」
 * 前一支唯讀檢查（查-14B4這個房源能不能刪.sql）回報：
 *   支出 0・訂單 0・評價 0・房號字串 0・契約 0 —— 乾淨。
 *
 * ══════════════════════════════════════════════════════════
 * ★★★ 這支**自己再檢查一次**，不相信上一支的結果。
 *
 *   上一支是**另一次連線、另一個時間點**跑的。中間有人開了一張
 *   14B4 的訂單的話，照著舊答案刪下去就會把那張單的房源打掉 ——
 *   而 `orders.property_id` 如果是 ON DELETE SET NULL，
 *   那張訂單會**安靜地失去房源**，沒有任何錯誤。
 *
 * ★★★ 而且這支**不只查那五張表**。它去問 `pg_constraint`：
 *   「到底有幾條外鍵指著 properties」，然後**每一條都實際數一次**
 *   有幾列指著 14B4。我手上沒有全部的表名，而憑印象列表正是
 *   2026-09-03 踩過的那種錯（`record_migration` 的簽章）。
 *
 * ★★ 任何一條 `ON DELETE CASCADE` 的外鍵只要有列指著它，
 *   這支就**不刪**並把表名印出來 —— cascade 會安靜地帶走別人的資料，
 *   而那種損失要幾個月後才會被發現。
 * ══════════════════════════════════════════════════════════
 *
 * 【怎麼看】
 *   最後那張表的第 0 列就是結論。
 *   「已刪除」→ 完成，回房源狀態重整一次，14B4 不會再出現。
 *   「沒有刪」→ 它會寫出擋住的是哪一張表、幾列，不要自己硬刪。
 *
 * 【可以重複跑】第二次跑會回「找不到 14B4（前一次已經刪掉）」，不會出錯。
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
  v_id    uuid;
  r       record;
  n       bigint;
  refs    bigint := 0;
  blocked int    := 0;
  rule    text;
begin
  select id into v_id from public.properties where name = '14B4';

  if v_id is null then
    insert into _del14b4 values (0, '結論', '找不到叫 14B4 的房源 —— 前一次已經刪掉了，這次什麼都沒做。', true);
    return;
  end if;

  /* ── ① 每一條指向 properties 的外鍵，實際數一次 ── */
  for r in
    select t.relname::text as tbl,
           a.attname::text as col,
           /* ★ confdeltype 是 "char" 不是 text —— 不轉型的話拼字串會
                `operator is not unique`（2026-09-01 踩過） */
           c.confdeltype::text as del
    from pg_constraint c
    join pg_class t      on t.oid = c.conrelid
    join pg_namespace ns on ns.oid = t.relnamespace
    /* ★ 取第一欄。指向 properties 的外鍵都是單欄（property_id），
         多欄複合鍵的話這裡會只數到第一欄 —— 現況沒有，有的話下面
         「0 列」那一格會說謊，所以寫在這裡提醒。 */
    join pg_attribute a  on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    where c.contype = 'f'
      and c.confrelid = 'public.properties'::regclass
      and ns.nspname = 'public'
    order by t.relname
  loop
    execute format('select count(*) from public.%I where %I = $1', r.tbl, r.col)
      into n using v_id;
    refs := refs + n;

    rule := case r.del
              when 'c' then 'ON DELETE CASCADE'
              when 'n' then 'ON DELETE SET NULL'
              when 'd' then 'ON DELETE SET DEFAULT'
              when 'r' then 'RESTRICT'
              else 'NO ACTION' end;

    /* 有列指著就是擋住的理由；CASCADE 就算 0 列也印出來讓人知道它存在 */
    if n > 0 then
      insert into _del14b4 values (
        10, '外鍵 ' || r.tbl || '.' || r.col,
        n || ' 列指著 14B4・' || rule, false);
      blocked := blocked + 1;
    elsif r.del = 'c' then
      insert into _del14b4 values (
        20, '外鍵 ' || r.tbl || '.' || r.col,
        '0 列・' || rule || '（有 cascade 但沒有東西，不擋）', true);
    end if;
  end loop;

  /* ── ② 訂單與契約是用**房號字串**對的，不是 id —— 另外問一次 ── */
  select count(*) into n from public.orders where property_raw = '14B4';
  if n > 0 then
    insert into _del14b4 values (11, '訂單 orders.property_raw', n || ' 筆房號寫著 14B4', false);
    blocked := blocked + 1;
    refs := refs + n;
  end if;

  select count(*) into n from public.contracts where room = '14B4';
  if n > 0 then
    insert into _del14b4 values (12, '契約 contracts.room', n || ' 張房號寫著 14B4', false);
    blocked := blocked + 1;
    refs := refs + n;
  end if;

  /* ── ③ 判定 ── */
  if blocked > 0 then
    insert into _del14b4 values (
      0, '結論',
      '沒有刪 —— 上面那幾列有東西指著 14B4。改成停用比較安全：'
      || 'update public.properties set active = false, show_in_room_calendar = false where id = '''
      || v_id || '''', false);
    return;
  end if;

  delete from public.properties where id = v_id;

  insert into _del14b4 values (
    0, '結論',
    '已刪除 14B4（id ' || v_id || '）。掃過 '
    || (select count(*) from pg_constraint
         where contype = 'f' and confrelid = 'public.properties'::regclass)
    || ' 條指向 properties 的外鍵，加上訂單與契約的房號字串，共 ' || refs || ' 列。', true);
end
$fn$;

/*
 * ★★★ 自檢。
 *
 * ★★ 看不到這張表 ＝ **整支回滾了**，不是「跑成功但沒輸出」。
 *   自檢在刪除後面，成功就一定看得到。
 *
 * ★ 第 1 列是**驗證結果**不是參考值:重新去 properties 問一次
 *   「現在還有沒有 14B4」，而不是相信上面那段自己說的話。
 */
select
  t.k    as "檢查",
  t.v    as "內容",
  case when t.ok then '✅' else '⚠' end as "判定"
from (
  /* ★ 結論排最上面 —— 要看的人第一眼就該看到答案 */
  select -10 as ord, k, v, ok from _del14b4 where ord = 0
  union all
  select -9, '刪掉了沒（重新問一次 properties）',
         case when exists (select 1 from public.properties where name = '14B4')
              then '14B4 還在表裡'
              else '表裡已經沒有 14B4' end,
         not exists (select 1 from public.properties where name = '14B4')
  union all
  select -8, '同一棟剩下哪幾間',
         coalesce((select string_agg(name, '、' order by name)
                     from public.properties where name like '14B%'), '（一間都沒有）'),
         true
  union all
  select ord, k, v, ok from _del14b4 where ord > 0
) t
order by t.ord, t.k;
