/*
 * 修-雪雪契約轉私下訂單.sql　2026-09-15（第二版）
 * 14B1／14B3 兩張訂金階段的契約 → 兩張訂金階段的私下訂單
 *
 * 【怎麼跑】整份貼進 SQL Editor，看最後那張自檢表。
 *   ★★ migration_256 與 257 都要先跑完。
 *   ★  **不用填任何東西了** —— 257 之後訂單可以沒有日期。
 *
 * ══════════════════════════════════════════════════════════
 * 【第一版為什麼要重寫】
 *
 * 第一版逼你填四個日期，因為當時 orders.checkin / checkout 是 NOT NULL。
 * 那不是保守，是**把資料庫的限制轉嫁給使用者** ——
 * 而你手上根本沒有那四個日期（雪雪還沒定住哪幾天）。
 *
 * migration_257 之後「訂金階段的訂單可以沒有日期」是合法狀態，
 * 所以這一版直接照現況搬:沒有日期、金額 0、earnest_only = true。
 * 日期定了之後回訂單頁補就好。
 *
 * ══════════════════════════════════════════════════════════
 * 【現況（2026-09-15 查過）】
 *
 *   契約 14B1　雪雪　沒有起訖日　每期 $0　earnest_only=true
 *   契約 14B3　雪雪　沒有起訖日　每期 $0　earnest_only=true
 *   訂金 14B1　應收 220,000　已收 220,000　收款日 2026-09-01
 *   訂金 14B3　應收 210,000　已收 210,000　收款日 2026-09-01
 *
 *   兩張契約底下:沒有月租單、沒有收款紀錄、沒有營收認列、
 *   沒有固定加費、沒有發票。所以這是一次乾淨的搬家 ——
 *   沒有任何一段帳會掉。
 *
 * ══════════════════════════════════════════════════════════
 * 【動作順序，以及為什麼是這個順序】
 *
 *   ① 建訂單，earnest_amount 先填 0
 *   ② 把那筆訂金從契約改掛到訂單
 *   ③ 再把訂單的 earnest_amount 改成實際金額
 *   ④ 契約送進回收桶
 *
 * ★★★ ①③ 為什麼要分兩步:
 *   建單時就填 earnest_amount 的話，trg_sync_order_earnest 會
 *   **新生一列訂金**，而原本那一列（有收款日、有收款紀錄）還在契約上 ——
 *   變成兩筆。分兩步的話，第③步碰到的是已經掛過來的那一列，
 *   走 on conflict do update，收款日、已收金額、收款紀錄全部原封不動。
 *
 * ★★ ④ 放最後:契約上還掛著訂金的時候刪它，
 *   mark_deposits_orphaned 會把那筆訂金標成孤兒。
 *   先搬走就沒事 —— 那時契約底下已經什麼都沒有。
 * ══════════════════════════════════════════════════════════
 */

create temp table if not exists _fix_xue (ord int, name text, detail text, verdict text);

begin;

do $do$
declare
  r        record;
  v_oid    uuid;
  v_did    uuid;
  v_ear    numeric;
  v_pid    uuid;
  v_moved  int := 0;
  v_note   text := '';
begin
  for r in
    select c.*, coalesce(c.display_name, c.tenant_name) as who
      from public.contracts c
     where c.room in ('14B1', '14B3')
       and coalesce(c.display_name, c.tenant_name) like '%雪雪%'
       and c.earnest_only
     order by c.room
  loop
    select p.id into v_pid from public.properties p
     where p.name = r.room and p.active limit 1;

    /*
     * ① 建訂單。
     *   沒有日期、0 晚、金額 0、earnest_only = true ——
     *   這四個要一起，`orders_earnest_dates_chk` 才過得了。
     *   earnest_amount 先 0，理由見檔頭。
     */
    insert into public.orders (
      order_key, source, estate_id, property_id, property_raw, guest_name,
      checkin, checkout, nights, amount, deposit, earnest_amount, earnest_only,
      contract_id, imported_via, note)
    values (
      'PV_' || r.room || '_' || coalesce(r.who, '')
        || '_' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISSMS'),
      'private', r.estate_id, v_pid, r.room, r.who,
      null, null, 0, 0, 0, 0, true,
      null, 'manual',
      '由訂金階段的契約轉入（' || to_char(current_date, 'YYYY-MM-DD') || '）・日期未定')
    returning id into v_oid;

    /* ② 訂金改掛到這張訂單 */
    select d.id, d.amount into v_did, v_ear
      from public.deposits d
     where d.contract_id = r.id and d.kind = 'earnest'
     order by d.created_at limit 1;

    if v_did is null then
      raise exception '% 找不到掛在那張契約上的訂金 —— 停下來，不要繼續。', r.room;
    end if;

    update public.deposits
       set contract_id = null,
           order_id    = v_oid,
           note = concat_ws('・', nullif(note, ''),
                    '由契約轉掛訂單 ' || to_char(current_date, 'YYYY-MM-DD'))
     where id = v_did;

    /*
     * ③ 訂單的訂金金額。
     *   這一步會觸發 sync_order_earnest，而它走 on conflict do update ——
     *   碰到的是②剛掛過來的那一列，收款日與收款紀錄不會動。
     */
    update public.orders set earnest_amount = v_ear where id = v_oid;

    /* ④ 契約進回收桶。此時它底下已經什麼都沒有 */
    perform public.soft_delete('contracts', r.id, '轉為訂金階段的私下訂單');

    v_moved := v_moved + 1;
    v_note := concat_ws('　／　', nullif(v_note, ''),
      r.room || '：訂金 $' || v_ear || '（日期未定）');
  end loop;

  insert into _fix_xue values
    (1, '① 搬了幾張', v_moved || ' 張　' || coalesce(nullif(v_note, ''), '（一張都沒找到）'),
     case when v_moved = 2 then '✅ 兩張都搬了' else '❌ 應該是 2 張' end);
end $do$;

commit;


/* ── 自檢 ───────────────────────────────────────────────── */

select v.ord, v."檢查", v."結果", v."判定" from (

  select t.ord, t.name, t.detail, t.verdict from _fix_xue t

  union all
  select 2, '② 新的私下訂單（訂金階段）',
         coalesce((select string_agg(o.property_raw
                                     || '　日期 ' || coalesce(o.checkin::text, '未定')
                                     || '　訂金 $' || o.earnest_amount
                                     || '　earnest_only=' || o.earnest_only,
                                     '　／　' order by o.property_raw)
                     from public.orders o
                    where o.source = 'private' and coalesce(o.guest_name, '') like '%雪雪%'
                      and o.property_raw in ('14B1', '14B3')), '★ 一張都沒有'),
         case when (select count(*) from public.orders o
                     where o.source = 'private' and coalesce(o.guest_name, '') like '%雪雪%'
                       and o.property_raw in ('14B1', '14B3') and o.earnest_only) = 2
              then '✅ 兩張，都是訂金階段' else '❌' end

  union all
  /*
   * ★★★ 這一條最重要:錢還是原本那兩筆，不是新生出來的。
   *   收款日與已收金額對得上，就證明 on conflict do update 走對了 ——
   *   走成 insert 的話這裡會看到四筆，而多出來的兩筆是空的。
   */
  select 3, '③ 訂金跟著過去，而且沒有變成新的一筆',
         coalesce((select string_agg(coalesce(d.room, '?') || '　應收 $' || d.amount
                                     || '　已收 $' || coalesce(d.received_amount, 0)
                                     || '　收款日 ' || coalesce(d.received_on::text, '—'),
                                     '　／　' order by d.room)
                     from public.deposits d
                     join public.orders o on o.id = d.order_id
                    where d.kind = 'earnest' and coalesce(o.guest_name, '') like '%雪雪%'),
                  '★ 一筆都沒有'),
         case when (select count(*) from public.deposits d
                     join public.orders o on o.id = d.order_id
                    where d.kind = 'earnest' and coalesce(o.guest_name, '') like '%雪雪%') = 2
              then '✅ 兩筆，金額與收款日照舊' else '❌' end

  union all
  select 4, '④ 契約已經進回收桶',
         (select count(*)::text || ' 張還在'
            from public.contracts c
           where c.room in ('14B1', '14B3')
             and coalesce(c.display_name, c.tenant_name) like '%雪雪%'),
         case when (select count(*) from public.contracts c
                     where c.room in ('14B1', '14B3')
                       and coalesce(c.display_name, c.tenant_name) like '%雪雪%') = 0
              then '✅ 都不在了（回收桶救得回來）' else '❌ 還有留著' end

  union all
  /*
   * ★★ 沒有變成孤兒。契約刪掉時如果訂金還掛在上面，
   *   mark_deposits_orphaned 會把它標成孤兒 —— 那表示順序做錯了。
   */
  select 5, '⑤ 沒有訂金變成孤兒',
         (select count(*)::text || ' 筆孤兒'
            from public.deposits d
           where d.kind = 'earnest' and d.orphaned
             and coalesce(d.guest_name, '') like '%雪雪%'),
         case when (select count(*) from public.deposits d
                     where d.kind = 'earnest' and d.orphaned
                       and coalesce(d.guest_name, '') like '%雪雪%') = 0
              then '✅ 0 筆' else '❌ 順序做錯了' end

  union all
  /*
   * ⑥ 沒有生出營收。訂金不是收入 —— 它是暫收款。
   *   生出來的話報表會多兩筆憑空出現的錢。
   */
  select 6, '⑥ 沒有生出營收認列',
         (select count(*)::text || ' 列'
            from public.revenue_recognitions r
            join public.orders o on o.id = r.order_id
           where coalesce(o.guest_name, '') like '%雪雪%'),
         case when (select count(*) from public.revenue_recognitions r
                     join public.orders o on o.id = r.order_id
                    where coalesce(o.guest_name, '') like '%雪雪%') = 0
              then '✅ 0 列（訂金不是收入）' else '❌ 憑空多出營收' end

  union all
  select 7, '⑦ 收尾', '自檢用 temp table，關掉分頁自己消失，不用清', '✅ 不留東西'

) as v(ord, "檢查", "結果", "判定")
order by v.ord;
