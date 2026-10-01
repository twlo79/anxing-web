/* ══════════════════════════════════════════════════════════════════════
 * 查（只讀）：在職同仁的權限與職位 —— 決定「代誰傳」下拉誰在前、誰在後                   2026-10-01
 *
 * 做法 A 的規則是「權限＝房務（cleaner）的人排到最底下灰字」。
 * 稿上誰是房務是我猜的；真正會排到後面的是這裡「權限」那一欄寫房務的人。一個字都不改。
 * ══════════════════════════════════════════════════════════ */
select p.name as 姓名,
       case p.role when 'cleaner' then '房務' when 'housekeeper' then '管家' when 'manager' then '主管'
                   when 'accountant' then '會計' when 'super_admin' then '總經理' else p.role end as 權限,
       coalesce((select case s.staff_type when 'cleaner' then '房務' when 'housekeeper' then '管家' when 'manager' then '經理'
                                           when 'accountant' then '會計' when 'super_admin' then '總經理' else s.staff_type end
                   from public.staff s where s.auth_uid = p.id limit 1), '—') as 職位,
       case when p.role = 'cleaner' then '↓ 排到最底下灰字' else '列在前面' end as 做法A會怎麼排
  from public.profiles p
 where p.active
 order by (p.role = 'cleaner'), p.name;
