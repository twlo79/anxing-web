-- migration_126：把 listing_id 從舊房源搬到現行房源
--
-- ============================================================
-- 【卡在哪】
--
-- 同步建議上出現：
--
--     listing 664230264721654781 —— 1 筆訂單沒有進來
--     這個 listing 只對到已停用的「舊-A18」
--
-- 訂單抓回來了，但對不到現行的房源，所以**整筆沒進系統** ——
-- 而報表看起來完全正常，錢就這樣不見。
--
-- 該做的事很清楚：把 listing_id 從「舊-A18」搬到「A18」。
-- 但 `airbnb_listing_id` 是 UNIQUE（migration_62 就撞過一次），
-- 直接在 A18 那格貼上去會噴 duplicate key。
--
-- 正確順序是「先清舊的、再設新的」，而那要求人先知道舊的掛在哪、
-- 找到那一列（它還是**停用**的，通常在清單底下）、清空、再回來貼。
-- 四個步驟，中間任何一步分心就變成兩邊都空的 —— 那比原本更糟：
-- 原本至少還有一條建議在提醒，兩邊都空之後連提醒都沒了。
--
--
-- ============================================================
-- 【為什麼要一支 RPC，不在前端做兩次 update】
--
-- 前端做兩次的話，第一次成功、第二次失敗（RLS、網路斷）就是兩邊都空。
-- 一支函式一個交易，要嘛都成、要嘛都不動。
--
-- 這件事本來就是「搬」，不是「清空」加「填入」—— 讓它在資料庫裡
-- 也是一個動作。

create or replace function public.move_listing_id(
  p_listing text, p_to uuid
) returns table(item text, detail text)
language plpgsql security definer set search_path = public as $fn$
declare
  v_from_name text;
  v_to_name   text;
  v_id        text;
begin
  if current_role_of() not in ('manager', 'super_admin') then
    return query select '權限不足'::text, '只有主管以上能改房源對照'::text;
    return;
  end if;

  -- 貼整段網址也收 —— 從 Airbnb 複製過來時常常連 https://... 一起帶
  v_id := (regexp_match(coalesce(p_listing, ''), '\d{6,}'))[1];
  if v_id is null then
    return query select '格式不對'::text, 'listing_id 要是數字,或直接貼房源網址'::text;
    return;
  end if;

  select name into v_to_name from properties where id = p_to;
  if v_to_name is null then
    return query select '找不到目標房源'::text, ''::text;
    return;
  end if;

  -- 誰現在拿著它
  select name into v_from_name
    from properties
   where airbnb_listing_id = v_id and id <> p_to;

  update properties set airbnb_listing_id = null
   where airbnb_listing_id = v_id and id <> p_to;

  update properties set airbnb_listing_id = v_id where id = p_to;

  /*
   * 回傳「從哪搬來的」而不只是「成功」。
   *
   * 使用者按下去的時候只看到一個 listing_id，他要確認的是
   * 「我剛剛是不是把某個還在用的房源的對照拔掉了」——
   * 只回「已更新」的話，那個確認做不了。
   */
  return query select '已搬移'::text,
    coalesce(v_from_name || ' → ', '（原本沒有人使用）→ ') || v_to_name;
end $fn$;

grant execute on function public.move_listing_id(text, uuid) to authenticated;

comment on function public.move_listing_id(text, uuid) is
  '把 airbnb_listing_id 從原本的房源搬到指定房源。'
  '一個交易做完「清舊的」與「設新的」—— 分兩次做的話中間失敗會變成兩邊都空,'
  '而那比原本更糟:原本至少還有一條同步建議在提醒。';


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('126_move_listing_id');
  end if;
end $$;


-- ============================================================
-- 驗證
-- ============================================================
do $$
declare n int;
begin
  drop table if exists _chk126;
  create temp table _chk126 (ord int, item text, result text, detail text);

  insert into _chk126 values (1, 'move_listing_id 函式',
    case when to_regprocedure('public.move_listing_id(text, uuid)') is not null
         then '✅' else '❌' end, '');

  /*
   * 現在有哪些 listing_id 卡在停用的房源上。
   *
   * 這就是「訂單抓回來了卻沒進系統」的完整清單 ——
   * 每一列都代表某個 listing 的錢正在漏。
   */
  select count(*) into n
    from public.properties p
   where p.airbnb_listing_id is not null and not p.active;
  insert into _chk126 values (2, '★★ listing_id 卡在停用房源上',
    case when n = 0 then '✅ 沒有' else '⚠ ' || n || ' 個' end,
    case when n = 0 then '' else
      (select string_agg(p.name || '（' || p.airbnb_listing_id || '）', '、' order by p.name)
         from public.properties p
        where p.airbnb_listing_id is not null and not p.active)
      || ' —— 到「權限管理 → 房源管理」在現行那間房的 listing_id 欄直接貼上,'
         '會問你要不要搬過來' end);

  select count(*) into n from public.properties where active and airbnb_listing_id is null;
  insert into _chk126 values (3, '現行房源沒填 listing_id', n || ' 間',
    '不走 Airbnb 的房源留空是正常的');
end $$;

select item as "檢查項目", result as "結果", detail as "說明"
from _chk126 order by ord, item;
