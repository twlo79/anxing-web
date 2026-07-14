# 部署指南(GitHub + Vultr 自動部署)

流程:改程式 push 到 GitHub main → Actions 自動 SSH 進 Vultr → pull + build + 重啟。

## 一、上傳到 GitHub(在你電腦的專案資料夾,PowerShell)

```powershell
cd C:\Users\ASUS\Desktop\anxing-web\anxing-web
git init
git add .
git commit -m "init: 安幸上工 評價模組"
```

到 github.com → New repository → 名稱 `anxing-web`、選 **Private** → 建立,然後:

```powershell
git remote add origin https://github.com/<你的帳號>/anxing-web.git
git branch -M main
git push -u origin main
```

(`.env.local` 已在 .gitignore,不會被上傳——正確行為,金鑰不進版控)

## 二、Vultr 主機初始化(SSH 進主機,只做一次)

```bash
# 1. 安裝 Node 20 + pm2 + nginx + git
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs nginx git
sudo npm i -g pm2

# 2. 取程式碼(私有 repo:GitHub → Settings → Developer settings →
#    Personal access tokens → Fine-grained → 只勾這個 repo 的 Contents:Read)
sudo git clone https://<TOKEN>@github.com/<你的帳號>/anxing-web.git /opt/anxing-web
cd /opt/anxing-web

# 3. 環境變數(內容跟本機 .env.local 相同)
cat > .env.local <<'ENV'
NEXT_PUBLIC_SUPABASE_URL=https://slujiahiagfvrsisjdmb.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=sb_publishable_hZKsChstgt9zmyhZED9NhQ_3pzPFtdy
ENV

# 4. 首次建置啟動
npm install && npm run build
pm2 start npm --name anxing -- start
pm2 save && pm2 startup   # 照它輸出的指令再貼一次,開機自啟

# 5. Nginx 反向代理
sudo tee /etc/nginx/sites-available/anxing <<'NGINX'
server {
  listen 80;
  server_name 你的網域;   # 例 app.anxing.com
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
  }
}
NGINX
sudo ln -s /etc/nginx/sites-available/anxing /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# 6. HTTPS(先把網域 DNS A 記錄指到主機 IP)
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d 你的網域

# 7. 防火牆
sudo ufw allow OpenSSH && sudo ufw allow 'Nginx Full' && sudo ufw enable
```

## 三、啟用自動部署(GitHub 網頁,只做一次)

Repo → Settings → Secrets and variables → Actions → New repository secret,建三個:

| Secret 名稱 | 值 |
|---|---|
| `VULTR_HOST` | 主機 IP |
| `VULTR_USER` | root(或你的登入帳號) |
| `VULTR_SSH_KEY` | SSH **私鑰**全文(本機 `~/.ssh/id_rsa`;沒有就 `ssh-keygen` 產一組,公鑰放主機 `~/.ssh/authorized_keys`) |

完成後,任何 push 到 main 都會自動部署,Actions 頁籤可看進度。

## 四、讓 Claude 直接推更新(可選)

GitHub → Settings → Developer settings → Personal access tokens → **Fine-grained token**:
- Repository access:只選 `anxing-web`
- Permissions:Contents → **Read and write**
把 token 給 Claude,以後改完程式直接 push,自動上線。
