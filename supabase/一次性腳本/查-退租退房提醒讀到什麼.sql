/*
 * 查-退租退房提醒讀到什麼.sql　2026-09-16
 *
 * 【為什麼查這個】
 * 使用者回報「退租提醒 0／退房提醒 0，明顯沒讀到」，而畫面上 4B5 Sarah
 * 那條色條確實在十二月中結束。
 *
 * ★★★ 我的推測是:那兩個 0 是**算出來的 0**，不是讀不到 ——
 *   提醒的窗口是「**今天**起算 45 天／7 天」，而 Sarah 是十二月退房，
 *   離今天九十幾天。
 *
 *   但推測不算數。這支就是去問資料:到底有沒有東西落在那兩個窗口裡，
 *   以及最近要結束的那幾筆各自是幾天後 —— 有了這幾個數字，
 *   「窗口該開多大」「該不該改成看目前這段期間」才有得談。
 *
 * ★ 這支**只讀不寫**，跑幾次都一樣。
 *
 * 【怎麼跑】整份貼進 Supabase SQL Editor，把表格貼回來。
 */

select v.ord, v."檢查", v."結果" from (

  select 1 as ord, '① 今天與兩個窗口' as "檢查",
         current_date::text
         || '　│ 契約窗口到 ' || (current_date + 45)::text
         || '　│ 訂單窗口到 ' || (current_date + 7)::text as "結果"

  /* ── 契約 ───────────────────────────────────────────── */

  union all
  select 2, '② 正隆・啟用中、有房號的契約 共幾張',
         coalesce((select count(*)::text from public.contracts c
                    left join public.estates e on e.id = c.estate_id
                   where e.name = '正隆' and c.active and c.room is not null), '0') || ' 張'

  union all
  /* ★ 這一列就是畫面上那個「退租提醒 N」的來源 */
  select 3, '③ 其中【45 天內】到期的（＝畫面上的退租提醒）',
         coalesce((select count(*)::text from public.contracts c
                    left join public.estates e on e.id = c.estate_id
                   where e.name = '正隆' and c.active and c.room is not null
                     and c.end_date between current_date and current_date + 45), '0') || ' 張'

  union all
  /*
   * ★★ 這一列最重要:**不管幾天**，最近要到期的五張是哪幾張、各是幾天後。
   *   如果第一張是 200 天後，那 45 天的窗口本來就會是 0 —— 不是壞掉。
   *   如果第一張是 50 天後，那就是窗口只差一點點,值得討論要不要放寬。
   */
  select 4, '④ 最近要到期的 5 張（不限天數）',
         coalesce((select string_agg(x.s, '　│ ' order by x.d)
                     from (select c.room || ' ' || coalesce(c.display_name, c.tenant_name, '?')
                                  || ' 迄 ' || c.end_date::text
                                  || '（' || (c.end_date - current_date)::text || ' 天後）' as s,
                                  c.end_date as d
                             from public.contracts c
                             left join public.estates e on e.id = c.estate_id
                            where e.name = '正隆' and c.active and c.room is not null
                              and c.end_date >= current_date
                            order by c.end_date
                            limit 5) x), '★ 一張都沒有（正隆沒有任何未來會到期的啟用契約）')

  union all
  select 5, '⑤ 已經過期但還沒停用的契約',
         coalesce((select count(*)::text from public.contracts c
                    left join public.estates e on e.id = c.estate_id
                   where e.name = '正隆' and c.active and c.room is not null
                     and c.end_date < current_date), '0')
         || ' 張　（有的話它們不會進提醒 —— 提醒只看還沒發生的）'

  /* ── 訂單 ───────────────────────────────────────────── */

  union all
  select 6, '⑥ 【7 天內】退房的短租訂單（＝畫面上的退房提醒）',
         coalesce((select count(*)::text from public.orders o
                   where o.contract_id is null
                     and coalesce(o.source, '') not in ('oneoff', 'airbnb_cancelled')
                     and o.checkout between current_date and current_date + 7), '0') || ' 筆'

  union all
  select 7, '⑦ 最近要退房的 5 筆（不限天數、排除月租單）',
         coalesce((select string_agg(y.s, '　│ ' order by y.d)
                     from (select coalesce(o.property_raw, '?') || ' ' || coalesce(o.guest_name, '?')
                                  || ' 退 ' || o.checkout::text
                                  || '（' || (o.checkout - current_date)::text || ' 天後）' as s,
                                  o.checkout as d
                             from public.orders o
                            where o.contract_id is null
                              and coalesce(o.source, '') not in ('oneoff', 'airbnb_cancelled')
                              and o.checkout >= current_date
                            order by o.checkout
                            limit 5) y), '★ 一筆都沒有')

  union all
  /*
   * ★★★ Sarah 那一筆的原始值。
   *   畫面上它的色條在十二月中結束 —— 這裡要看的是三件事:
   *     checkout 到底是幾號、source 是什麼、contract_id 是不是 null。
   *   contract_id **有值**的話它是月租單,會被提醒故意排掉（不是 bug）。
   */
  select 8, '⑧ Sarah 那一筆的原始值',
         coalesce((select string_agg(coalesce(o.property_raw, '?')
                          || '　' || coalesce(o.checkin::text, 'null')
                          || ' ~ ' || coalesce(o.checkout::text, 'null')
                          || '　距今 ' || coalesce((o.checkout - current_date)::text, '?') || ' 天'
                          || '　source=' || coalesce(o.source, 'null')
                          || '　contract_id=' || case when o.contract_id is null then 'null（真的短租）'
                                                      else '有值（月租單，提醒會排掉）' end,
                          '　│ ')
                     from public.orders o
                    where o.guest_name ilike '%sarah%'), '★ 找不到叫 Sarah 的訂單')

  union all
  /*
   * ⑨ 如果改成「這段期間內結束的」會是幾筆 —— 拿十二月當例子。
   *   這一列是給「窗口該怎麼定」用的參考，不是判定對錯。
   */
  select 9, '⑨ 【改成看十二月】的話會有幾筆',
         coalesce((select count(*)::text from public.contracts c
                    left join public.estates e on e.id = c.estate_id
                   where e.name = '正隆' and c.active and c.room is not null
                     and c.end_date between date '2026-12-01' and date '2026-12-31'), '0')
         || ' 張契約到期　＋　'
         || coalesce((select count(*)::text from public.orders o
                      where o.contract_id is null
                        and coalesce(o.source, '') not in ('oneoff', 'airbnb_cancelled')
                        and o.checkout between date '2026-12-01' and date '2026-12-31'), '0')
         || ' 筆訂單退房'

) as v(ord, "檢查", "結果")
order by v.ord;
