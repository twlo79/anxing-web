/** @type {import('next').NextConfig} */
//
// 這裡曾經是 `{ output: 'standalone' }`，但 pm2 跑的是 `npm start` → `next start`。
// 那兩個不相容，Next 自己有警告：
//   ⚠ "next start" does not work with "output: standalone" configuration.
//
// 症狀是服務起得來（log 會顯示 ✓ Ready），一有請求就
// `Cannot find module '.next/server/pages/_error.js'` 然後崩潰、
// pm2 重啟、再崩潰 —— 對外看到的是全站 503，重啟次數一路累積（曾經到 79）。
//
// standalone 的用途是把相依套件打包成最小可攜目錄，給 Docker 那類場景用。
// 這裡是在主機上 npm install + npm run build 再 next start，node_modules 本來就在，
// standalone 沒有帶來任何好處，只帶來上面那個不相容。
//
// 真要改回 standalone 的話，pm2 的啟動指令要同時改成
// `node .next/standalone/server.js` —— 兩邊必須一起改，只改一邊就是現在這個狀況。
//
// ── outputFileTracing: false ─────────────────────────────────
// 2026-08-09 部署 #218 失敗，卡在 build 的最後一個階段：
//
//   ✓ Compiled successfully
//   ✓ Generating static pages (17/17)
//     Collecting build traces ...
//   Error: ENOENT: .next/server/app/_not-found/page.js.nft.json
//
// 程式沒問題 —— 同一個 commit 在下一次部署（#219）就過了。這是 flaky：
// collectBuildTraces 開多個 worker 掃相依關係，記憶體吃緊時 worker 會中途死掉，
// 少寫一個 .nft.json，主行程再去讀就 ENOENT。Vultr 那台記憶體不大，偶發命中。
//
// 而那些 .nft.json **對這個專案完全沒有用途**。
// 它們是 output: 'standalone' 與 serverless 打包在用的，用來算出「這個路由需要
// 哪些 node_modules 檔案」好只複製那些。這裡是在主機上 npm install + next start，
// node_modules 本來就完整躺在旁邊，沒有人會去讀那份清單。
//
// 所以關掉整個階段：少一個失敗點，build 也快幾秒。
// 哪天真的改回 standalone，這一行要跟著拿掉（連同上面那段的 pm2 啟動指令）。
//
const nextConfig = {
  outputFileTracing: false,
};
export default nextConfig;
