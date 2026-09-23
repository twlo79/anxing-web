/* ══════════════════════════════════════════════════════════════════════
 * 清掉 2026-09-23 驗收 migration_295（短租移房 RPC）在 13A5 Roger 那張單上
 * 留下的移房痕跡。                                      一次性腳本
 *
 * 【★★★ 不刪訂單】那是 2027/6–8、$293,000 的真預訂。
 *   這支只清兩個欄位：
 *     · `move_chain`  ← 列表上那行「13A5>14B2>13A5」與「移房」標籤都是讀它
 *     · `note`        ← 移房會**追加**一行「移房 <鏈>」，只把那一行抽掉，
 *                        使用者自己打的字（「客人要求高樓層」）原封不動
 *   金額、日期、房號、收款狀態都不碰。
 *
 * 【★★ 守衛：不是剛好 1 筆就整支停下來】
 *   條件用四個欄位夾死（房號＋客人＋入住＋退房），再加上那條鏈本身。
 *   同房號同客人但別的日期那種單（真的有一張）不會被掃到。
 *
 * 【★ 分段】移房如果拆了段，兄弟段的 `move_group` 會指向這張單。
 *   這次是「移出去又移回來」的單段，理論上沒有兄弟段 ——
 *   自檢會把數字report 出來，不是 0 就停下來看，不要自己猜。
 *
 * 【★★★ 自檢問的是「這一次改了什麼」】
 *   寫成「現在還找不找得到那條鏈」的話，守衛擋下來（一列都沒改）時
 *   答案同樣是「找不到」→ 整張表回綠，看起來像做完了。
 *   現在自檢讀的是更新當下寫進暫存表的值：沒改成功的話那張表不存在，
 *   最後一段會直接報錯。**綠表格不可能憑空出現。**
 * ══════════════════════════════════════════════════════════ */

begin;

create temp table _undo_result (
  order_id uuid, chain_was text, note_was text, note_now text,
  n_upd int, n_sibling int);

do $$
declare
  v_chain constant text := '13A5>14B2>13A5';
  n      int;
  v_id   uuid;
  v_note text;
  v_new  text;
  n_sib  int;
  n_upd  int;
begin
  select count(*) into n
    from public.orders o
   where o.property_raw = '13A5'
     and o.guest_name   = 'Roger'
     and o.checkin      = date '2027-06-18'
     and o.checkout     = date '2027-08-09'
     and o.move_chain   = v_chain;

  if n <> 1 then
    raise exception '預期剛好 1 張單（13A5 / Roger / 2027-06-18~2027-08-09 / 鏈=%），實際 % 張 —— 整支停下來，一列都沒改', v_chain, n;
  end if;

  select o.id, o.note into v_id, v_note
    from public.orders o
   where o.property_raw = '13A5' and o.guest_name = 'Roger'
     and o.checkin = date '2027-06-18' and o.checkout = date '2027-08-09'
     and o.move_chain = v_chain;

  -- 兄弟分段（移房拆段時才會有）。這次預期 0，不是 0 就報出來讓人看。
  select count(*) into n_sib from public.orders where move_group = v_id;

  /*
   * 只抽掉「移房 <鏈>」那一行。
   * 逐行比對而不是 replace() —— replace 會把使用者自己寫的
   * 「移房 13A5>14B2>13A5（客人說太吵）」那種句子切一半。
   */
  select nullif(btrim(coalesce(string_agg(l, E'\n' order by i), '')), '')
    into v_new
    from unnest(string_to_array(coalesce(v_note, ''), E'\n')) with ordinality as t(l, i)
   where btrim(l) <> '移房 ' || v_chain;

  update public.orders
     set move_chain = null,
         note       = v_new
   where id = v_id;
  get diagnostics n_upd = row_count;

  if n_upd <> 1 then
    raise exception '更新影響 % 列（預期 1）—— 整支退回', n_upd;
  end if;

  insert into _undo_result values (v_id, v_chain, v_note, v_new, n_upd, n_sib);
end $$;

commit;

-- ═══ 自檢 ═══════════════════════════════════════════════════════════
-- 看不到這張表 ＝ 整支回滾了，**一列都沒改**（錯誤訊息會說撈到幾張）。
select 1 as "序", '這一次改到的訂單數（要 1）' as "檢查",
       (select n_upd::text from _undo_result) as "結果",
       case when (select n_upd from _undo_result) = 1 then '✅' else '❌' end as "判定"
union all
select 2, '移房鏈清掉了沒（要 0 筆還帶著鏈）',
       (select count(*)::text from public.orders o
         where o.id = (select order_id from _undo_result) and o.move_chain is not null),
       case when (select count(*) from public.orders o
                   where o.id = (select order_id from _undo_result) and o.move_chain is not null) = 0
            then '✅ 列表上那行「13A5>14B2>13A5」與「移房」標籤會消失' else '❌ 還在' end
union all
select 3, '訂單本身沒被動到（金額／日期／房號）',
       (select o.property_raw || ' / ' || o.checkin::text || '~' || o.checkout::text
               || ' / $' || round(o.amount)::text
          from public.orders o where o.id = (select order_id from _undo_result)),
       case when (select count(*) from public.orders o
                   where o.id = (select order_id from _undo_result)
                     and o.property_raw = '13A5' and o.checkin = date '2027-06-18'
                     and o.checkout = date '2027-08-09' and round(o.amount) = 293000) = 1
            then '✅ 跟改之前一模一樣' else '❌ 有東西被動到了' end
union all
select 4, '備註：使用者自己寫的字有沒有留著',
       coalesce((select note_now from _undo_result), '（清空了）'),
       case when (select note_was from _undo_result) is null
                 or btrim((select note_was from _undo_result)) = '移房 13A5>14B2>13A5'
            then '✅ 本來就只有移房那一行，清空是對的'
            when (select note_now from _undo_result) is not null
                 and (select note_now from _undo_result) not like '%移房 13A5>14B2>13A5%'
            then '✅ 移房那一行抽掉了，其餘原封不動'
            else '❌ 抽錯了，看一下 note_was' end
union all
-- ★ 這一列不是參考值，是判定：不是 0 就代表還有兄弟分段要一起處理
select 5, '兄弟分段（move_group 指向這張單的，預期 0）',
       (select n_sibling::text from _undo_result),
       case when (select n_sibling from _undo_result) = 0 then '✅ 單段，沒有別的段要清'
            else '⚠ 還有分段 —— 停下來，那些段也帶著這次移房的痕跡' end
union all
-- ★ 母體要判定：其他真的移過房的單不可以被掃到
select 6, '母體：全站還有幾張帶移房鏈的單（不該被動到）',
       (select count(*)::text from public.orders where move_chain is not null),
       case when (select count(*) from public.orders where move_chain is not null) = 0
            then '⚠ 一張都不剩 —— 如果本來就只有這一張是移過房的才正常，否則停下來看'
            else '✅ 其他移房紀錄都還在' end
order by 1;
