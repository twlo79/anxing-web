/*
 * audit_hk_property_bridge —— 哪些房源接不上 ERP／沒有物業（唯讀）
 * ============================================================
 * 2026-09-02 使用者：「這些有房源耶」
 *
 * 各物業卡片展開後，亞曼尼、時兆公區、開3 被歸進「未歸物業」——
 * 而那三個確實有房源、房務主檔裡也有。
 *
 * ============================================================
 * 【要算進物業，這條鏈要三段都通】
 *
 *     hk_work_item.property_code
 *       → hk_property.code            房務主檔有這個代碼嗎
 *       → hk_property.property_id     有沒有接上 ERP 房源（migration_124 建的橋）
 *       → properties.estate_id        那個 ERP 房源屬於哪個物業
 *       → estates.name                物業名稱
 *
 * ★★ 任何一段斷掉，那筆清掃就算不進任何物業 —— 而且**點數也算不出來**
 *   （點數來自 `properties.clean_points`，同一條橋）。
 *   卡片上「⚠4」那個數字跟這件事是同一個原因。
 *
 * ★ 症狀不會報錯:總數還是對的（各物業加起來 ＋ 未歸物業 = 合計），
 *   只是那幾筆的工作量歸不到任何一家。
 *
 * 整份照貼。只有 select。
 */

-- ① 房務主檔：每一個代碼卡在哪一段
select
  p.code                                   as "房務代碼",
  coalesce(p.name, '')                     as "名稱",
  p.active                                 as "啟用",
  p.property_id                            as "接到的 ERP 房源",
  coalesce(pr.name, '')                    as "ERP 房源名稱",
  coalesce(e.name, '')                     as "物業",
  /*
   * ★ 這個月實際用到幾次。0 的先不用管 —— 沒人用的房源接不上不影響任何數字。
   *   有用到才是真的要補。
   */
  (select count(*) from public.hk_work_item w
    where w.property_code = p.code and w.period = to_char(now(), 'YYYYMM'))
                                           as "本月用到幾筆",
  case
    when p.property_id is null   then '⚠⚠ A 沒接上 ERP 房源 —— 去房源管理把它對起來'
    when pr.id is null           then '⚠⚠⚠ B 接到一個不存在的 ERP 房源 —— 資料壞了'
    when pr.estate_id is null    then '⚠ C 接上了，但那個 ERP 房源沒設物業'
    when e.id is null            then '⚠⚠⚠ D 物業 id 指向不存在的物業'
    when pr.clean_points is null then '⚠ E 通了，但沒設打掃點數（點數會算不出來）'
    else '✅ 全通'
  end                                      as "★ 卡在哪"
from public.hk_property p
left join public.properties pr on pr.id = p.property_id
left join public.estates e     on e.id = pr.estate_id
where p.active
order by
  case when p.property_id is null then 1
       when pr.estate_id is null then 2
       when pr.clean_points is null then 3
       else 9 end,
  p.sort, p.code;


-- ② 這個月實際受影響的工作
/*
 * ★★ 第 ① 段列的是主檔（可能有幾十個從來沒用過的）。
 *   這一段只列**這個月真的有工作、而且歸不進物業**的 ——
 *   那才是畫面上「未歸物業」那一條的來源。
 */
select
  w.work_date                              as "日期",
  coalesce(w.property_code, '（沒填）')      as "房源",
  w.work_type                              as "工作類型",
  count(*)                                 as "幾筆",
  string_agg(distinct s.name, '・')         as "誰做的",
  case
    when w.property_code is null or w.property_code = ''
                                 then '使用者留空的（補登時房源沒填）'
    when hp.code is null         then '房務主檔沒有這個代碼'
    when hp.property_id is null  then '沒接上 ERP 房源'
    when pr.estate_id is null    then '那個 ERP 房源沒設物業'
    else '✅ 其實通了 —— 不該出現在這裡'
  end                                      as "★ 原因"
from public.hk_work_item w
left join public.hk_property hp on hp.code = w.property_code
left join public.properties pr  on pr.id = hp.property_id
left join public.hk_staff s     on s.id = w.staff_id
where w.period = to_char(now(), 'YYYYMM')
  and (hp.code is null or hp.property_id is null or pr.estate_id is null)
group by w.work_date, w.property_code, w.work_type, hp.code, hp.property_id, pr.estate_id
order by w.work_date, w.property_code;
