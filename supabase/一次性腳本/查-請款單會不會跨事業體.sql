/*
 * 查-請款單會不會跨事業體.sql　2026-09-21
 * 只讀不寫。回一張表。
 *
 * ══════════════════════════════════════════════════════════
 * 【為什麼要查】
 *
 * 2026-09-21 使用者：「一張請款單裡，項目可以分屬不同事業體嗎？」→**不可以**。
 *
 * 那就要加一條守衛。但**加守衛之前要先知道現有資料違不違反它** ——
 * 資料早就有跨事業體的單的話，守衛一加上去那幾張單就再也存不了，
 * 而症狀是「以前好好的單現在按儲存沒反應」。
 *
 * ══════════════════════════════════════════════════════════
 * 【★★★ 事業體存在項目的哪一欄，我不知道】
 *
 * 請款單的表單上每一項有「— 其他事業體 — → 愛皮」兩個下拉，
 * 但那對到 `purchase_request_items` 的哪一欄，我手上這份工作區看不到。
 *
 * 所以這一支**不猜欄位名**:
 *   ① 把那張表的文字欄位全部列出來
 *   ② 哪一欄的值裡出現過 aipi／hongsha —— 那就是它
 *   ③ 每一個文字欄位都算一次「同一張單裡有幾種值」——
 *      答案 > 1 的那幾欄就是「會跨」的欄位
 *
 * ★ 憑印象寫 `i.book` 的話，欄位不存在就是 42703 整支炸掉；
 *   而更糟的是**剛好有一個同名但意思不同的欄位** ——
 *   那會回一個看起來很正常的答案（README 坑 G）。
 * ══════════════════════════════════════════════════════════
 */

drop table if exists _col;
drop table if exists _mix;
create temp table _col (col text, kind text, vals text);
create temp table _mix (col text, reqs bigint, worst text);

do $do$
declare
  r     record;
  v_n   bigint;
  v_s   text;
  v_key text;
begin
  if to_regclass('public.purchase_request_items') is null then
    raise exception 'purchase_request_items 不在 —— 表名可能不一樣，把這句貼回對話。';
  end if;

  /* 這張表用哪一欄接回請款單:request_id 還是 pr_id，先找出來 */
  select column_name into v_key
    from information_schema.columns
   where table_schema = 'public' and table_name = 'purchase_request_items'
     and column_name in ('request_id', 'pr_id', 'purchase_request_id')
   order by column_name
   limit 1;
  if v_key is null then
    raise exception '找不到接回請款單的欄位（request_id / pr_id / purchase_request_id）—— 把這句貼回對話。';
  end if;

  for r in
    select c.column_name, c.data_type
      from information_schema.columns c
     where c.table_schema = 'public' and c.table_name = 'purchase_request_items'
       and c.data_type in ('text', 'character varying', 'character')
     order by c.column_name
  loop
    /* ① 這一欄有幾種值（最多列 8 種，不然科目那種欄位會印出一整頁） */
    execute format(
      'select coalesce(string_agg(v, '' / '' order by v), ''（全部都是空的）'') '
      '  from (select distinct %I as v from public.purchase_request_items '
      '         where %I is not null limit 8) s',
      r.column_name, r.column_name) into v_s;
    insert into _col values (r.column_name, r.data_type, v_s);

    /*
     * ② 同一張單裡這一欄有幾種值 —— > 1 就是「會跨」。
     * ★ 用 count(distinct) 而不是「看起來像不像」:
     *   判定要用實際筆數算，不要用我讀欄位名推出來的意思（README 坑）。
     */
    execute format(
      'select count(*), coalesce(max(vv), '''') from ('
      '  select %I as k, count(distinct %I) as c, string_agg(distinct %I, ''/'') as vv'
      '    from public.purchase_request_items where %I is not null'
      '   group by 1 having count(distinct %I) > 1) g',
      v_key, r.column_name, r.column_name, v_key, r.column_name)
      into v_n, v_s;
    if v_n > 0 then
      insert into _mix values (r.column_name, v_n, v_s);
    end if;
  end loop;
end $do$;


-- ══════════════════════════════════════════════════════════
-- 結果（★ SQL Editor 只看得到最後一句，所以併成一張表）
-- ══════════════════════════════════════════════════════════
select * from (

  /* ── ① 哪一欄裝著事業體 ─────────────────────────────── */
  select 1 as ord, '★★★ ① 這一欄的值裡有 aipi／hongsha' as "段",
         c.col as "欄位", c.vals as "有哪些值", '' as "幾張單"
    from _col c
   where c.vals like '%aipi%' or c.vals like '%hongsha%'

  union all
  select 1, '★★★ ① 這一欄的值裡有 aipi／hongsha', '（一欄都沒有）',
         '⚠ 事業體不是存在 purchase_request_items 的文字欄位裡 —— 看下面②的完整清單', ''
   where not exists (select 1 from _col c
                      where c.vals like '%aipi%' or c.vals like '%hongsha%')

  union all
  select 2, '', '', '', ''

  union all
  /* ── ② 全部文字欄位（找不到時靠這一段人工認） ─────────── */
  select 3, '② 這張表有哪些文字欄位', c.col, left(c.vals, 120), ''
    from _col c

  union all
  select 4, '', '', '', ''

  union all
  /* ── ③ 哪幾欄「同一張單裡會有兩種值」 ─────────────────── */
  select 5, '★★★ ③ 同一張單裡有兩種值的欄位', m.col,
         '例如：' || left(m.worst, 80), m.reqs::text || ' 張單'
    from _mix m

  union all
  /* ★★★ 一欄都沒有要說出來 —— 空的結果跟「沒查到」長得一樣 */
  select 5, '★★★ ③ 同一張單裡有兩種值的欄位', '（一欄都沒有）',
         '✅ 每一張單的每一個文字欄位，項目之間都一致 —— 守衛可以直接加', '0'
   where not exists (select 1 from _mix)

) v(ord, "段", "欄位", "有哪些值", "幾張單")
order by v.ord, v."欄位";
