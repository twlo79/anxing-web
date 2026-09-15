/*
 * 修-雪雪契約轉私下訂單.sql　2026-09-15
 * 14B1／14B3 兩張訂金階段的契約 → 兩張私下訂單，訂金跟著搬過去
 *
 * 【怎麼跑】
 *   ★★★ 先把下面「要填的」那四個日期填好，**再**整份貼進 SQL Editor。
 *   ★★  migration_256 要先跑完（這支會寫 orders.earnest_amount）。
 *   ★   沒填日期的話它會直接拒絕，什麼都不會動。
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
 *   沒有固定加費、沒有發票。關帳的是 202608，訂金落在 202609。
 *
 * ★ 所以這是一次**乾淨的搬家** —— 沒有任何一段帳會掉。
 *
 * ══════════════════════════════════════════════════════════
 * 【★★★ 為什麼日期要你填，我不猜】
 *
 * 那兩張契約**沒有起訖日**（查出來是 ? ~ ?）。
 * 而 orders.checkin / checkout 是 NOT NULL —— 一定要有值。
 *
 * 隨便填的後果不是報錯，是**房源狀態那張日曆上多出兩段假的住宿**，
 * 而有人會照著它排房。
 *
 * ★ 如果你現在還不知道住哪幾天，那就先不要轉成訂單 ——
 *   把訂金留在契約上，等日期確定再搬。訂金本來就是「還沒定案」的狀態。
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

begin;

create temp table _fix_xue (ord int, name text, detail text, verdict text);

do $do$
declare
  /* ────────── ★★★ 要填的：四個日期 ────────── */
  v_14b1_in   date := null;   -- 14B1 入住日　例 date '2026-10-01'
  v_14b1_out  date := null;   -- 14B1 退房日
  v_14b3_in   date := null;   -- 14B3 入住日
  v_14b3_out  date := null;   -- 14B3 退房日

  /* 訂單總額（房租）。還沒談定就留 0 —— 訂金是另外一筆，不寫在這裡 */
  v_14b1_amt  numeric := 0;
  v_14b3_amt  numeric := 0;
  /* ──────────────────────────────────────────── */

  r        record;
  v_in     date;
  v_out    date;
  v_amt    numeric;
  v_oid    uuid;
  v_did    uuid;
  v_ear    numeric;
  v_pid    uuid;
  v_moved  int := 0;
  v_note   text := '';
begin
  if v_14b1_in is null or v_14b1_out is null
     or v_14b3_in is null or v_14b3_out is null then
    raise exception
      '請先把腳本裡那四個日期填好（v_14b1_in / v_14b1_out / v_14b3_in / v_14b3_out）。'
      '那兩張契約沒有起訖日，而訂單的日期是必填 —— 我不替你猜，'
      '猜出來的日期會在房源狀態日曆上變成兩段假的住宿。';
  end if;

  if v_14b1_out <= v_14b1_in or v_14b3_out <= v_14b3_in then
    raise exception '退房日要比入住日晚（同一天是 0 晚，那不是住宿）。';
  end if;

  for r in
    select c.*, coalesce(c.display_name, c.tenant_name) as who
      from public.contracts c
     where c.room in ('14B1', '14B3')
       and coalesce(c.display_name, c.tenant_name) like '%雪雪%'
       and c.earnest_only
     order by c.room
  loop
    if r.room = '14B1' then
      v_in := v_14b1_in; v_out := v_14b1_out; v_amt := v_14b1_amt;
    else
      v_in := v_14b3_in; v_out := v_14b3_out; v_amt := v_14b3_amt;
    end if;

    /*
     * ★ 關帳擋不擋。私下訂單算哪個月看退房日（migration_251）——
     *   填到已關帳的月份的話，插入會被守衛擋掉而整支失敗。
     *   與其讓人看到一句講訂單守衛的錯誤，不如在這裡先講清楚。
     */
    if public.is_period_locked(to_char(v_out, 'YYYYMM')) then
      raise exception '% 的退房日 % 落在已關帳的 % —— 請改日期，或請會計先開帳。',
        r.room, v_out, to_char(v_out, 'YYYY-MM');
    end if;

    select p.id into v_pid from public.properties p
     where p.name = r.room and p.active limit 1;

    /* ① 建訂單。earnest_amount 先 0 —— 理由見檔頭 */
    insert into public.orders (
      order_key, source, estate_id, property_id, property_raw, guest_name,
      checkin, checkout, nights, amount, deposit, earnest_amount,
      contract_id, imported_via, note)
    values (
      'PV_' || to_char(v_in, 'YYYY-MM-DD') || '_' || r.room || '_'
        || coalesce(r.who, '') || '_' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISSMS'),
      'private', r.estate_id, v_pid, r.room, r.who,
      v_in, v_out, (v_out - v_in), coalesce(v_amt, 0), 0, 0,
      null, 'manual',
      '由訂金階段的契約轉入（' || to_char(current_date, 'YYYY-MM-DD') || '）')
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
    perform public.soft_delete('contracts', r.id, '轉為私下訂單');

    v_moved := v_moved + 1;
    v_note := concat_ws('　／　', nullif(v_note, ''),
      r.room || '：' || to_char(v_in, 'MM/DD') || '~' || to_char(v_out, 'MM/DD')
        || '　訂金 $' || v_ear);
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
  select 2, '② 新的私下訂單',
         coalesce((select string_agg(o.property_raw || '　' || o.checkin || '~' || o.checkout
                                     || '　訂金 $' || o.earnest_amount, '　／　' order by o.property_raw)
                     from public.orders o
                    where o.source = 'private' and coalesce(o.guest_name, '') like '%雪雪%'
                      and o.property_raw in ('14B1', '14B3')), '★ 一張都沒有'),
         case when (select count(*) from public.orders o
                     where o.source = 'private' and coalesce(o.guest_name, '') like '%雪雪%'
                       and o.property_raw in ('14B1', '14B3')) = 2
              then '✅ 兩張' else '❌' end

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
  select 6, '⑥ 收尾', '自檢用 temp table，關掉分頁自己消失，不用清', '✅ 不留東西'

) as v(ord, "檢查", "結果", "判定")
order by v.ord;
