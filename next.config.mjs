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
const nextConfig = {};
export default nextConfig;
