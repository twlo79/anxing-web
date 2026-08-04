-- 關注收租: 釘選契約才顯示於「本月已收/未收」清單; 可自訂顯示名稱
alter table contracts add column if not exists watch boolean not null default false;
alter table contracts add column if not exists display_name text;
