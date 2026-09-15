/*
 * 修-雪雪收尾-刪掉那兩張契約.sql　2026-09-15
 * 上一支的 ④ 是紅的：契約沒有進回收桶
 *
 * 【怎麼跑】整份貼進 SQL Editor，看最後那張自檢表。
 *          ★ 只有這兩張契約會被碰到。訂金那兩筆已經搬完了，這支不動它們。
 *
 * ══════════════════════════════════════════════════════════
 * 【★★★ 上一支為什麼沒刪掉 —— 我寫錯的那一行】
 *
 * 上一支第 ④ 步寫的是
 *
 *     perform public.soft_delete(…)
 *
 * `perform` **把回傳值丟掉**。而 soft_delete 失敗的時候
 * 不是丟例外，是回傳 `{ok: false, message: …}` ——
 * 前端那支 softDelete() 的程式碼就是在讀那個 ok。
 *
 * 於是它安靜地沒刪，而我的腳本一路跑完、前面三條還全綠。
 * ★ 這正是 README 坑 C 的形狀:**失敗回傳「成功加沒做事」**，
 *   而我用了一個會把答案丟掉的寫法去接它。
 *
 * ★★ 最可能的原因是 SQL Editor 裡 `auth.uid()` 是 null ——
 *    soft_delete 認不出是誰在刪。所以這支會**把訊息印出來**，
 *    不再假設它成功。
 *
 * ══════════════════════════════════════════════════════════
 * 【★★ 為什麼不能就這樣放著】
 *
 * 那兩張契約現在是「earnest_amount 還有 220,000／210,000，
 * 但底下的訂金已經搬走了」的狀態。
 *
 * `trg_sync_contract_earnest` 會在有人動到那張契約的
 * earnest_amount / estate_id / room / tenant_name 時跑，
 * 而它看到 earnest_amount > 0、卻找不到對應的那一列，
 * 就會**新生一筆 220,000 的訂金**。
 *
 * ★ 憑空多出來的那筆錢不會報錯，只會出現在暫收款總計裡。
 *   所以這支在刪不掉的時候會退而求其次:把 earnest_amount 歸零，
 *   先把那顆地雷拆掉，契約留給你在畫面上刪。
 * ══════════════════════════════════════════════════════════
 */

create temp table if not exists _xue_fin (ord int, name text, detail text, verdict text);

do $do$
declare
  r      record;
  v_txt  text;
  v_left int;
  v_msg  text := '';
  v_zero text := '';
begin
  for r in
    select c.id, c.room, c.earnest_amount
      from public.contracts c
     where c.room in ('14B1', '14B3')
       and coalesce(c.display_name, c.tenant_name) like '%雪雪%'
  loop
    /*
     * ★ 這次**接住回傳值**。成功與否都印出來 ——
     *   看不到訊息的失敗，跟沒失敗長得一模一樣。
     */
    begin
      v_txt := public.soft_delete('contracts', r.id, '轉為訂金階段的私下訂單')::text;
    exception when others then
      v_txt := '（丟例外）' || sqlerrm;
    end;
    v_msg := concat_ws('　／　', nullif(v_msg, ''), r.room || '：' || coalesce(v_txt, 'null'));
  end loop;

  insert into _xue_fin values
    (1, '① soft_delete 回了什麼', coalesce(nullif(v_msg, ''), '（找不到那兩張契約 —— 可能已經刪掉了）'),
     '—');

  /*
   * 還在的話，先把地雷拆掉:earnest_amount 歸零。
   * 這一步會觸發 sync_contract_earnest 的 else 分支，
   * 而它只碰 contract_id = 這張契約的 deposits —— 現在一筆都沒有，
   * 所以搬走的那兩筆訂金不會被動到（⑤ 會再確認一次）。
   */
  select count(*) into v_left
    from public.contracts c
   where c.room in ('14B1', '14B3')
     and coalesce(c.display_name, c.tenant_name) like '%雪雪%';

  if v_left > 0 then
    update public.contracts
       set earnest_amount = 0,
           note = concat_ws('・', nullif(note, ''),
                    '訂金已轉到私下訂單 ' || to_char(current_date, 'YYYY-MM-DD') || '，此契約待刪')
     where room in ('14B1', '14B3')
       and coalesce(display_name, tenant_name) like '%雪雪%';
    v_zero := v_left || ' 張已把 earnest_amount 歸零（避免觸發器憑空生出一筆訂金）';
  else
    v_zero := '（契約已經不在了，不用處理）';
  end if;

  insert into _xue_fin values
    (2, '② 拆地雷：契約上的訂金金額', v_zero,
     case when v_left = 0 then '✅ 契約已刪，不需要' else '⚠ 契約還在，已先歸零' end);
end $do$;


select v.ord, v."檢查", v."結果", v."判定" from (

  select t.ord, t.name, t.detail, t.verdict from _xue_fin t

  union all
  select 3, '③ 契約還在不在',
         (select coalesce(string_agg(c.room || '（earnest_amount=' || c.earnest_amount || '）',
                                     '　／　' order by c.room), '一張都不在了')
            from public.contracts c
           where c.room in ('14B1', '14B3')
             and coalesce(c.display_name, c.tenant_name) like '%雪雪%'),
         case when (select count(*) from public.contracts c
                     where c.room in ('14B1', '14B3')
                       and coalesce(c.display_name, c.tenant_name) like '%雪雪%') = 0
              then '✅ 都進回收桶了'
              else '⚠ 還在 —— 請到契約頁按「刪除」（見下面說明）' end

  union all
  /*
   * ★★★ 這一條是「這支有沒有傷到已經搬好的錢」。
   *   ②那個歸零動作會觸發 sync_contract_earnest ——
   *   它只掃 contract_id = 那張契約的 deposits，而訂金已經改掛到訂單了。
   *   這裡要還是兩筆、金額與收款日不變。
   */
  select 4, '④ 訂金沒有被這支動到',
         coalesce((select string_agg(coalesce(d.room, '?') || '　$' || d.amount
                                     || '　已收 $' || coalesce(d.received_amount, 0)
                                     || '　' || coalesce(d.received_on::text, '—')
                                     || case when d.orphaned then '　★孤兒' else '' end,
                                     '　／　' order by d.room)
                     from public.deposits d
                     join public.orders o on o.id = d.order_id
                    where d.kind = 'earnest' and coalesce(o.guest_name, '') like '%雪雪%'),
                  '★ 一筆都沒有'),
         case when (select count(*) from public.deposits d
                     join public.orders o on o.id = d.order_id
                    where d.kind = 'earnest' and coalesce(o.guest_name, '') like '%雪雪%'
                      and not d.orphaned) = 2
              then '✅ 兩筆都在，沒變孤兒' else '❌' end

  union all
  select 5, '⑤ 沒有憑空生出第三筆訂金',
         (select count(*)::text || ' 筆訂金掛在雪雪的名下（訂單＋契約一起數）'
            from public.deposits d
           where d.kind = 'earnest' and coalesce(d.guest_name, '') like '%雪雪%'),
         case when (select count(*) from public.deposits d
                     where d.kind = 'earnest' and coalesce(d.guest_name, '') like '%雪雪%') = 2
              then '✅ 就是原本那兩筆' else '❌ 數量不對' end

  union all
  select 6, '⑥ 收尾', '自檢用 temp table，關掉分頁自己消失，不用清', '✅ 不留東西'

) as v(ord, "檢查", "結果", "判定")
order by v.ord;
