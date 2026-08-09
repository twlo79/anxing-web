# 主機升級到 Node 22

> 2026-08-09 建立。執行前把整份看完一次 —— 有一段（pm2）是最容易漏掉、
> 而且漏掉的症狀是「看起來成功了但其實還在跑舊版」。

## 為什麼要做

部署 log 每次都跳這一排：

```
npm warn EBADENGINE Unsupported engine {
  package: '@supabase/supabase-js@2.110.3',
  required: { node: '>=22.0.0' },
  current:  { node: 'v20.20.2', npm: '10.8.2' }
}
⚠️ Node.js 20 and below are deprecated and will no longer be supported
   in future versions of @supabase/supabase-js.
```

**現在只是警告，還能跑。** 但 supabase-js 已經宣告不支援 Node 20，
下一次它更新時可能就真的用了 Node 22 才有的 API ——
那時候不會在 build 期報錯，會在**執行期**炸掉，也就是全站 503 那種形狀。

Next 14.2 在 Node 22 上完全支援（官方要求 18.17+），沒有相容性問題。

## 需要多久 / 會不會斷線

**約 5 分鐘，其中約 3 分鐘網站是關掉的。** 挑沒人在用的時間做（清晨或深夜）。

刻意先停服務再動 node_modules —— 一邊跑一邊砍套件的話，
Node 會在某個請求需要載入新模組時才崩潰，那個錯誤很難連回這次升級。

---

## 步驟

以下全部在主機上執行（`ssh` 進去之後）。

### 0. 先看現在是什麼狀態

```bash
node -v                 # 預期 v20.x
npm -v
which node              # ★ 這一行決定下面走哪條路
pm2 list
pm2 describe anxing | grep -i "exec interpreter\|script path\|node version"
```

`which node` 的結果決定安裝方式：

| 輸出 | 安裝方式 | 走哪一步 |
|---|---|---|
| `/usr/bin/node` 或 `/usr/local/bin/node` | apt / NodeSource | **1-A** |
| `/root/.nvm/versions/node/v20.../bin/node` | nvm | **1-B** |

### 1-A. 用 NodeSource 升級（apt）

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v                 # 預期 v22.x
npm -v
```

### 1-B. 用 nvm 升級

```bash
source ~/.nvm/nvm.sh
nvm install 22
nvm alias default 22
nvm use 22
node -v                 # 預期 v22.x
which node              # 路徑會變成 .../v22.../bin/node ← 記住這件事
```

> ⚠️ **nvm 的路徑會變**，這會影響下一步的 pm2。apt 的路徑不變，pm2 那步比較單純。

### 2. pm2 —— 最容易漏掉的一步

pm2 有**兩個東西**跑在 Node 上：守護行程本身，以及你的 app。
只做 `pm2 restart` 的話，兩個都還在舊 Node 上 —— 而 `pm2 list` 會顯示 online、
網站也開得起來，**看起來完全成功**。

```bash
# 讓 pm2 守護行程本身換到新的 Node
pm2 update

# 停掉 app（接下來要動 node_modules，不能讓它跑著）
pm2 stop anxing
```

nvm 使用者**多做一步** —— app 的直譯器路徑被寫死在 pm2 的設定裡了，
只 restart 不會換，必須整個刪掉重建：

```bash
# 只有 nvm 使用者需要
pm2 delete anxing
```

### 3. 重建 node_modules 與 build

換了 Node 大版本，原生模組（編譯過的 `.node` 檔）的 ABI 就對不上了。
**一定要整個重裝**，不能只 `npm install`。

```bash
cd /opt/anxing-web
rm -rf node_modules package-lock.json.bak
npm install --no-audit --no-fund
rm -rf .next
npm run build
```

`npm install` 之後那排 EBADENGINE 警告應該就消失了 —— 那是升級成功的第一個訊號。

### 4. 起服務

```bash
cd /opt/anxing-web

# apt 使用者（剛才只有 stop）
pm2 start anxing

# nvm 使用者（剛才 delete 過，要重建）
pm2 start npm --name anxing -- start

pm2 save            # ★ 存下來,重開機才會自動起
pm2 list
```

> nvm 使用者若主機重開過機會發現服務沒起來，是因為 `pm2 startup` 產生的
> systemd 設定裡還指著舊的 node 路徑。重新產生一次：
> `pm2 unstartup && pm2 startup` 然後照它印出來的指令貼一次，再 `pm2 save`。

### 5. 驗證 —— 三個都要過

```bash
# (1) 服務真的回得出 200
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3001/api/health
# 預期 200

# (2) 跑的是新 Node（不是舊的）
pm2 describe anxing | grep -i "node version"
# 預期 22.x

# (3) log 沒有崩潰迴圈
pm2 logs anxing --lines 40 --nostream
```

然後**用手機或瀏覽器實際開一次 justwork.estia.com.tw**，登入、點進儀表板、
開一張請款單。curl 200 只證明伺服器活著，不證明頁面渲染得出來。

### 6. 收尾：把版本要求寫進 package.json

升級成功之後才做這一步（提早做的話，主機還在 Node 20 時 `npm install` 會多噴一排警告）。

`package.json` 的 `"private": true` 附近加上：

```json
  "engines": {
    "node": ">=22"
  },
```

作用是**下一次有人在錯的 Node 版本上裝套件時會被警告**。
現在沒有這一欄，所以「主機該用哪個 Node」這件事只存在於這份文件裡，
而文件沒有人會在 `npm install` 的時候讀。

改完照常 `.\deploy.ps1 "主機升級Node22;package.json補engines"`。

---

## 出事了怎麼退回去

整個升級沒有動到任何資料，退回去只是換 Node 版本再重建一次。

### apt / NodeSource

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

### nvm

```bash
source ~/.nvm/nvm.sh
nvm alias default 20
nvm use 20
```

兩種都接著做：

```bash
pm2 update
pm2 delete anxing
cd /opt/anxing-web
rm -rf node_modules .next
npm install --no-audit --no-fund
npm run build
pm2 start npm --name anxing -- start
pm2 save
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3001/api/health
```

---

## 常見狀況

| 症狀 | 原因 | 怎麼辦 |
|---|---|---|
| `node -v` 已經是 22，但 `pm2 describe` 還顯示 20 | 漏了 `pm2 update`，或 nvm 的路徑寫死在 pm2 設定裡 | `pm2 update`，nvm 再加 `pm2 delete anxing` 重建 |
| build 過了但一有請求就崩潰 | node_modules 還是 Node 20 編的 | `rm -rf node_modules` 重裝，**不能只 `npm install`** |
| 健康檢查 000 / 連不上 | 服務沒起來 | `pm2 logs anxing --lines 60 --nostream` 看實際錯誤 |
| 重開機後網站沒起來 | `pm2 save` 沒做，或 systemd 指著舊 node 路徑 | `pm2 unstartup && pm2 startup`，照指示貼一次，再 `pm2 save` |
| 下一次 GitHub Actions 部署失敗 | CI 用的是主機上的 node，理論上跟著新版走 | 看 Actions log 的 `node -v`；workflow 沒有指定版本，是吃主機預設 |

## 這次升級不會動到什麼

* **Supabase 資料庫** —— 完全沒關係，一個欄位都不碰
* **`.env.local`** —— 在 `.gitignore` 裡，`git reset --hard` 與這次操作都不影響
* **程式碼** —— 只有第 6 步的 `engines` 欄位，而且那是選配
