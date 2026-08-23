-- 修：時兆 B6 的押金補登成「已移轉 → B5」
--
-- ============================================================
-- 【現況】
--
--   時兆 B6　李瑪琍　NT$ 20,000　收 2026-06-12　→ 暫收中
--   時兆 B5　李瑪琍　NT$ 20,000　收 2026-06-12　退 2026-08-05 → 已退
--
-- 同一個人、同一筆錢、同一天收，但系統裡是兩列 ——
-- 所以那 20,000 現在被算了兩次：一次在暫收中（B6），一次在已退（B5）。
--
-- 錢的實際經過只有兩件事：6/12 收進來、8/5 退出去。
--
--
-- ============================================================
-- 【只改 B6，B5 一個欄位都不碰】（2026-08-19 使用者指定）
--
-- B5 那一列現在是對的：收 6/12、退 8/5、匯款元大 48088，
-- 錢真的照這個走過一遍。改它只會把正確的紀錄弄髒。
--
-- 要修的是 B6 —— 它是重複的那一列，錢從來沒有第二次進來過。
--
-- ★ 代價要知道:這樣是**單向的**指標。B6 指向 B5，B5 不回指。
--   影響有兩個，都不嚴重但要記著：
--     ① B5 的詳情裡看不到「這筆錢是從 B6 來的」（B6 那邊看得到）
--     ② `undo_deposit_transfer` 撤不了這一組（它要求兩邊互指）——
--        要再改只能寫另一支 SQL
--
--   換來的是 B5 那一列的退款資訊完全不動。這筆交換是划算的:
--   B5 是**錢真的匯出去**的憑據，弄壞它的代價比查不到來源大得多。
--
--
-- ============================================================
-- 【為什麼不能用 transfer_deposit RPC】
--
-- 那支會擋下來，因為 B5 已經有 received_on：
--     '目的已經收過押金了 —— 重複收兩次押金是錯的'
--
-- 那個擋是對的，它將來要防的是「手滑對同一筆收兩次」。
-- 這一筆是**已經發生完的歷史**（移房、收款、退款都做完了），
-- 只是當初沒有移轉功能。為了補歷史去放寬那條檢查是本末倒置。
--
--
-- ============================================================
-- 【移轉日】★ 唯一要你確認的東西
--
-- 沒有人記得房客實際哪一天換的房。預設 2026-06-12 ——
-- 系統裡 B5 就是那天「收到」的，用同一天兩列接得起來，
-- 中間不會出現一段「錢在誰手上說不清楚」的空窗。
--
-- 知道真正的換房日就改這一行（要落在 6/12 ~ 8/5 之間）：
DO $$ BEGIN PERFORM set_config('anxing.move_on', '2026-06-12', false); END $$;
-- ============================================================


do $$
declare
  v_from uuid; v_to uuid; v_on date;
  n_from int; n_to int;
begin
  v_on := current_setting('anxing.move_on')::date;

  /*
   * ★★ 先精準定位，對不到就整支停下來。
   *
   * 更新錯一列**不會報錯** —— 只會有另一個房客的押金憑空變成「已移轉」,
   * 而那筆錢在報表上就此消失，沒有任何跡象。
   *
   * 所以條件開到最緊（房號＋姓名＋金額＋收款日＋退款狀態），
   * 筆數不是剛好 1 就 raise exception。
   * SQL Editor 把整份腳本包在一個交易裡，例外會讓全部回滾。
   */
  /*
   * 【為什麼是 array_agg 不是 min】
   *
   * Postgres **沒有 min(uuid)**（uuid 沒有定義 min 聚合），會噴 42883。
   * array_agg 有，取第一個元素就好。
   *
   * 筆數與 id 一定要在**同一句**查 —— 拆成兩句就等於把同一組條件
   * 抄兩遍,而抄漏一個條件的那一句會安靜地選到別列。
   */
  select count(*), (array_agg(id))[1] into n_from, v_from
    from public.deposits
   where room = 'B6' and guest_name = '李瑪琍'
     and amount = 20000 and received_on = date '2026-06-12'
     and returned_on is null and not orphaned;

  select count(*), (array_agg(id))[1] into n_to, v_to
    from public.deposits
   where room = 'B5' and guest_name = '李瑪琍'
     and amount = 20000 and returned_on = date '2026-08-05'
     and not orphaned;

  if n_from <> 1 then
    raise exception 'B6（李瑪琍 20,000 收 2026-06-12 未退）找到 % 列，應該剛好 1 列。已全部回滾。', n_from;
  end if;
  if n_to <> 1 then
    raise exception 'B5（李瑪琍 20,000 退 2026-08-05）找到 % 列，應該剛好 1 列。已全部回滾。', n_to;
  end if;

  -- 移轉日不能早於收款、也不能晚於 B5 的退款 ——
  -- 那會變成「還沒收就移走」或「退完了才移過去」，兩個都講不通
  if v_on < date '2026-06-12' or v_on > date '2026-08-05' then
    raise exception '移轉日 % 不在 2026-06-12 ~ 2026-08-05 之間。已回滾。', v_on;
  end if;

  -- 留一份修改前的樣子。改完才發現不對的話，這是唯一能回去的依據
  create table if not exists public.deposits_fix_b6_b5 as
  select *, now() as _backup_at from public.deposits where id = v_from;

  /*
   * refund_status 設成 approved 是 dep_refund_chk 約束逼的
   * （returned_on 有值就必須是 approved），**不是真的走過兩票**。
   * manager_approved_* / admin_approved_* 留空 —— 那兩欄才是審核的證據。
   *
   * returned_method = 'internal' → 畫面顯示「押金移轉」。
   * 記成匯款的話，明年對元大帳戶時會有一筆匯出永遠找不到對應的流水。
   */
  update public.deposits set
    returned_on      = v_on,
    returned_method  = 'internal',
    returned_account = null,
    refund_status    = 'approved',
    transfer_to_id   = v_to,
    transferred_at   = now(),
    note = concat_ws('・', nullif(note, ''),
             '押金移轉至 B5 ' || to_char(v_on, 'YYYY-MM-DD') || '（補登，錢沒有實際退出）')
  where id = v_from;

  raise notice 'B6=% 已標記移轉至 B5=%，移轉日 %', v_from, v_to, v_on;
end $$;


-- ============================================================
-- 驗證
-- ============================================================
select
  f.room                          as "來源房",
  t.room                          as "目的房",
  f.guest_name                    as "房客",
  f.amount                        as "金額",
  f.received_on                   as "B6 收款日",
  f.returned_on                   as "移轉日",
  t.returned_on                   as "B5 實際退款日",
  case when f.returned_method = 'internal'
       then '✅ 移轉' else '❌ 方式不對' end                     as "B6 出去的方式",
  case when t.returned_method = 'internal'
       then '❌ B5 被動到了' else '✅ B5 沒動' end               as "B5 退款紀錄",
  case when t.received_method is not null and t.received_account is not null
       then '✅ B5 收款資訊還在' else '⚠ B5 收款資訊是空的' end  as "B5 收款紀錄"
from public.deposits f
join public.deposits t on t.id = f.transfer_to_id
where f.room = 'B6' and f.guest_name = '李瑪琍';


-- ★★ 這 20,000 現在只算一次
--    修之前:暫收中 1 筆 ＋ 已退 1 筆 —— 同一筆錢被算兩次
--    修之後:暫收中 0 筆、已移轉 1 筆、已退 1 筆
select
  case
    when returned_on is null        then '暫收中'
    when transfer_to_id is not null then '已移轉（錢沒出去）'
    else                                 '已退（錢真的出去了）'
  end                as "狀態",
  room               as "房號",
  count(*)           as "筆數",
  sum(amount)        as "金額"
from public.deposits
where guest_name = '李瑪琍' and amount = 20000 and not orphaned
group by 1, 2
order by 1, 2;
