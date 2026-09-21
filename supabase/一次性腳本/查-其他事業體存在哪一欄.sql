/*
 * 查-其他事業體存在哪一欄.sql　2026-09-21
 * 只讀不寫。回一張表。
 *
 * ══════════════════════════════════════════════════════════
 * 【上一支查到哪裡】
 *
 * `purchase_request_items.purpose_type` 的值是 **estate / office / other_biz**
 * —— `other_biz` 就是表單上那個「— 其他事業體 —」。
 *
 * 但**是哪一個事業體**（愛皮／洪鯊）不在那張表的任何文字欄位裡:
 * 上一支掃過 account_code／item_name／note／purpose_type／voucher_no，
 * 一欄都沒有 aipi 或 hongsha。
 *
 * ★★★ 所以它存在**不是文字的欄位**裡 —— 最可能是一支 uuid
 *   （指向某張表的某一列），或者它根本不在項目這一層。
 *
 * ══════════════════════════════════════════════════════════
 * 【這一支怎麼找】
 *
 *   ① 把那張表**全部**的欄位列出來（含型別）—— 上一支只掃文字欄位
 *   ② 把 `purpose_type = 'other_biz'` 的那幾列**整列印出來**
 *      （`to_jsonb`，不挑欄位）—— 愛皮在哪一格，一眼就看到
 *   ③ 那幾列所屬的請款單，header 上的 book 是什麼
 *
 * ★ 不挑欄位是刻意的。挑了就等於先猜一遍，而猜錯的代價是
 *   「回一個看起來很正常的空答案」（README 坑 G）。
 *
 * ══════════════════════════════════════════════════════════
 * 【★★ 順便確認一件上一支看到的事】
 *
 * 上一支第 ③ 段:**已經有 5 張單的項目用途不一致**（estate 跟 office 混在一起）。
 * 所以「一張單的項目可以各填各的」這件事**現在就是成立的**。
 * 那「不可以跨事業體」的守衛要擋的是哪一種混法，得看 ② 印出來的形狀再決定。
 * ══════════════════════════════════════════════════════════
 */

/*
 * ★★★ ②b 把那支 uuid **翻譯成名字**。
 *   印出一串 uuid 等於沒回答問題 —— 看的人還是不知道那是不是愛皮。
 *   這一段拿那個 id 去 public 底下**每一張有 uuid 主鍵的表**問一次，
 *   問到的那一張就是它指向的表，順便把 name／code 印出來。
 * ★ 不挑表名，一樣是為了不先猜一遍。
 */
drop table if exists _res;
create temp table _res (col text, val text, tbl text, label text);

do $do$
declare
  c    record;
  t    record;
  v    text;
  v_lbl text;
  v_txt text;
begin
  if to_regclass('public.purchase_request_items') is null then
    raise exception 'purchase_request_items 不在 —— 表名可能不一樣，把這句貼回對話。';
  end if;

  for c in
    select column_name from information_schema.columns
     where table_schema = 'public' and table_name = 'purchase_request_items'
       and data_type = 'uuid' and column_name not in ('id', 'request_id')
  loop
    /* 這一欄在 other_biz 的列上有沒有值 */
    execute format(
      'select %I::text from public.purchase_request_items '
      ' where purpose_type = ''other_biz'' and %I is not null limit 1',
      c.column_name, c.column_name) into v;
    if v is null then continue; end if;

    for t in
      select cl.table_name,
             /* 這張表拿哪一欄當顯示名 —— 找得到就印，找不到就印「（這張表沒有名字欄）」 */
             (select min(x.column_name) from information_schema.columns x
               where x.table_schema = 'public' and x.table_name = cl.table_name
                 and x.column_name in ('name', 'code', 'title', 'label')) as lbl
        from information_schema.columns cl
        join information_schema.tables tb
          on tb.table_schema = cl.table_schema and tb.table_name = cl.table_name
       where cl.table_schema = 'public' and cl.column_name = 'id'
         and cl.data_type = 'uuid' and tb.table_type = 'BASE TABLE'
    loop
      v_lbl := coalesce(t.lbl, '');
      begin
        if v_lbl = '' then
          execute format('select ''（這張表沒有名字欄）'' from public.%I where id = $1', t.table_name)
            into v_txt using v::uuid;
        else
          execute format('select %I::text from public.%I where id = $1', v_lbl, t.table_name)
            into v_txt using v::uuid;
        end if;
      exception when others then
        v_txt := null;          -- ★ 某張表查不動就跳過，不要把整支拖下水
      end;
      if v_txt is not null then
        insert into _res values (c.column_name, v, t.table_name, v_txt);
      end if;
    end loop;
  end loop;
end $do$;


select * from (

  /* ── ① 全部欄位（含型別）───────────────────────────── */
  select 1 as ord, '① purchase_request_items 的全部欄位' as "段",
         c.column_name::text as "欄位／內容",
         c.data_type::text   as "型別／值",
         '' as "補充"
    from information_schema.columns c
   where c.table_schema = 'public' and c.table_name = 'purchase_request_items'

  union all
  select 2, '', '', '', ''

  union all
  /* ── ② other_biz 那幾列，整列印出來 ────────────────────
     ★ 只取前 6 列 —— 找欄位用不到更多，而一次印幾百列會蓋掉重點。 */
  select 3, '★★★ ② purpose_type = other_biz 的列（整列）',
         coalesce(j ->> 'item_name', '（沒有品名）'),
         left(j::text, 420),
         ''
    from (select to_jsonb(i.*) as j
            from public.purchase_request_items i
           where i.purpose_type = 'other_biz'
           limit 6) s

  union all
  /* ★★★ 一列都沒有要說出來 —— 空結果跟「沒查到」長得一樣 */
  select 3, '★★★ ② purpose_type = other_biz 的列（整列）', '（一列都沒有）',
         '⚠ 沒有任何項目是 other_biz —— 那「其他事業體」是存在別的地方，看 ③', ''
   where not exists (select 1 from public.purchase_request_items i
                      where i.purpose_type = 'other_biz')

  union all
  select 4, '', '', '', ''

  union all
  /* ── ②b 那支 uuid 指到哪一張表的哪一列 ─────────────── */
  select 4, '★★★ ②b 那支 uuid 是誰', r.col, r.tbl || ' → ' || r.label, r.val
    from _res r

  union all
  select 4, '★★★ ②b 那支 uuid 是誰', '（沒有 uuid 欄位有值）',
         'ℹ other_biz 的列上沒有任何 uuid 欄位有值 —— 事業體不在項目這一層', ''
   where not exists (select 1 from _res)

  union all
  select 4, '', '', '', ''

  union all
  /* ── ③ 那幾張單的 header 是什麼帳本 ───────────────────
     ★ 如果事業體只存在 header 的 book，那「逐項判」就不存在 ——
       整張單只有一個事業體，守衛自然成立，不用另外加。 */
  select 5, '★★ ③ 有 other_biz 項目的那幾張單，header 的帳本',
         coalesce(h.book, '（空的）'),
         h.n::text || ' 張單',
         coalesce(h.reqs, '')
    from (
      select coalesce(to_jsonb(p.*) ->> 'book', '(空的)') as book,
             count(*) as n,
             left(string_agg(coalesce(to_jsonb(p.*) ->> 'req_no', '?'), '、'), 120) as reqs
        from public.purchase_requests p
       where exists (select 1 from public.purchase_request_items i
                      where i.request_id = p.id and i.purpose_type = 'other_biz')
       group by 1
    ) h

  union all
  select 5, '★★ ③ 有 other_biz 項目的那幾張單，header 的帳本', '（一張都沒有）',
         'ℹ 沒有請款單含 other_biz 項目', ''
   where not exists (
     select 1 from public.purchase_requests p
      where exists (select 1 from public.purchase_request_items i
                     where i.request_id = p.id and i.purpose_type = 'other_biz'))

  union all
  select 6, '', '', '', ''

  union all
  /* ── ④ 同一張單裡「用途」會混到什麼程度 ────────────────
     ★ 上一支說 5 張單 estate/office 混用。這裡把那 5 張印出來，
       看它是「一張單裡有公司費用也有物業費用」還是別的意思。 */
  select 7, '★★ ④ 同一張單裡用途不一致的那幾張',
         coalesce(to_jsonb(p.*) ->> 'req_no', '(沒有單號)'),
         g.kinds,
         coalesce(to_jsonb(p.*) ->> 'book', '(空的)')
    from (
      select i.request_id as rid, string_agg(distinct i.purpose_type, ' + ') as kinds
        from public.purchase_request_items i
       where i.purpose_type is not null
       group by 1
      having count(distinct i.purpose_type) > 1
    ) g
    join public.purchase_requests p on p.id = g.rid

  union all
  select 7, '★★ ④ 同一張單裡用途不一致的那幾張', '（一張都沒有）',
         '✅ 每一張單的項目用途都一致', ''
   where not exists (
     select 1 from (
       select i.request_id from public.purchase_request_items i
        where i.purpose_type is not null
        group by 1 having count(distinct i.purpose_type) > 1) x)

) v(ord, "段", "欄位／內容", "型別／值", "補充")
order by v.ord, v."欄位／內容";
