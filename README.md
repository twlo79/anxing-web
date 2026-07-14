# 安幸上工 — 內部管理網站

Next.js 14 + Supabase(Auth + PostgreSQL + RLS)

## 本機執行

```bash
npm install
npm run dev        # http://localhost:3000
```

`.env.local` 已含 Supabase URL 與 publishable key(可公開,安全性由 RLS 保護)。

## 功能現況

| 模組 | 狀態 |
|---|---|
| 登入(Supabase Auth) | ✅ 未登入自動導向 /login |
| 左側選單(依角色顯示) | ✅ 管家看不到營收/支出 |
| 評價查詢 | ✅ 篩選:房源、退房日期區間、評分;點列開細節抽屜(細節評分/分項回饋/私下回饋/房東回覆);負評紅點警示 |
| 營收/支出/清潔記錄 | 🚧 佔位頁,後續階段開發 |

## 部署到 Vultr(簡要)

```bash
# Ubuntu 24.04, 安裝 Node 20+
npm install && npm run build
# 用 pm2 常駐
npm i -g pm2 && pm2 start npm --name anxing -- start
# Nginx 反代 3000 端口 + certbot 上 SSL
```

## 帳號管理

Supabase Dashboard → Authentication → Add user,再到 SQL Editor:
```sql
insert into profiles (id, name, role) values ('<user_uuid>', '名字', 'housekeeper|manager|super_admin');
```
