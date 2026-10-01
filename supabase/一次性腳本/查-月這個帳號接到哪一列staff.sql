/* ══════════════════════════════════════════════════════════════════════
 * 查（只讀）：profiles 裡的「月」接到 staff 哪一列？                                        2026-10-01
 *
 * 權限管理頁上沒有「月」，但在職名單裡有她 —— 兩邊名字不一樣。
 * 猜是頁上那列「test」（dianne@gmail.com），用 auth_uid 對一次就知道。一個字都不改。
 * ══════════════════════════════════════════════════════════ */
select p.name as profiles姓名, p.role as 權限, p.active as profiles在職,
       coalesce(s.name, '（沒接到 staff）') as staff姓名, s.email as staff帳號, s.staff_type as 職位, s.active as staff在職,
       (select email from auth.users u where u.id = p.id) as 登入email
  from public.profiles p
  left join public.staff s on s.auth_uid = p.id
 where p.name = '月' or s.name = 'test'
 order by p.name;
