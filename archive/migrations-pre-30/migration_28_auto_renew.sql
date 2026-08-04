-- 契約自動展延: 到期後每月自動產生營收與收租,直到停用(active=false)為止
alter table contracts add column if not exists auto_renew boolean not null default false;
