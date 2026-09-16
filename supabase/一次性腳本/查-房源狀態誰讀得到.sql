/*
 * 查-房源狀態誰讀得到.sql　2026-09-16
 *
 * 【為什麼查這個】
 * 使用者：「房源狀態 > 打開 管家 會計 主管 總經理 全部打開。」
 *
 * ★★★ 側欄那扇門**本來就對五種權限全開**（含房務）——
 *   所以會擋人的只可能是資料庫這一層。這一頁讀四張表:
 *   contracts、orders、properties、estates，
 *   其中任何一張擋住某個權限，那個人打開會看到
 *   **一張整片空白的排房表**，不是錯誤訊息（README 坑 C:成功、0 列）。
 *
 * ★★ 這支**只讀不寫**，跑幾次都一樣。
 *   在看過這張表之前我不會去動任何 policy ——
 *   照著名字盲目 drop 再 create，正是 README 那條
 *   「拔掉沒看過的那五條，症狀是房務阿姨什麼都看不到」的踩法。
 *
 * 【怎麼看】
 *   「定義裡出現的權限」那一欄就是答案。
 *   四個都在 → 已經開好了，什麼都不用改。
 *   少了誰 → 那個人現在看到的是空表。
 *   一個權限名字都沒有 → 那條 policy 用的是別的條件（例如「登入就看得到」），
 *                        看最後一欄的定義。
 *
 * 【怎麼跑】整份貼進 Supabase SQL Editor，把表格貼回來。
 */

select
  p."表",
  p."policy",
  p."動作",
  (case when p.d ilike '%cleaner%'     then '房務 '   else '' end
    || case when p.d ilike '%housekeeper%' then '管家 '   else '' end
    || case when p.d ilike '%accountant%'  then '會計 '   else '' end
    || case when p.d ilike '%manager%'     then '主管 '   else '' end
    || case when p.d ilike '%super_admin%' then '總經理 ' else '' end)
    as "定義裡出現的權限",
  case
    when p.d !~* '(cleaner|housekeeper|accountant|manager|super_admin)'
      then '★ 沒列到任何權限 —— 看右邊的定義，可能是「登入就看得到」或另有條件'
    when p.d ilike '%housekeeper%' and p.d ilike '%accountant%'
     and p.d ilike '%manager%'     and p.d ilike '%super_admin%'
      then '✅ 那四種都在'
    else '⚠ 少了人 —— 少掉的那個權限打開會是空表'
  end as "判定",
  left(p.d, 300) as "定義（前 300 字）"
from (
  select
    tablename  as "表",
    policyname as "policy",
    cmd        as "動作",
    coalesce(qual, '') || ' ／ ' || coalesce(with_check, '') as d
  from pg_policies
  where schemaname = 'public'
    /*
     * ★ 房源狀態這一頁讀的就是這四張。
     *   contracts / orders  → 畫面上的色條
     *   properties          → 左邊那一欄有哪幾間房（含 show_in_room_calendar）
     *   estates             → 物業下拉與排序
     */
    and tablename in ('contracts', 'orders', 'properties', 'estates')
) p
order by p."表", p."policy";
