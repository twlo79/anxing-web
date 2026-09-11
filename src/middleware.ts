import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (cookies: { name: string; value: string; options?: Record<string, unknown> }[]) => {
          cookies.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookies.forEach(({ name, value, options }) => response.cookies.set(name, value, options as any));
        },
      },
    }
  );
  // getUser() 在 access token 過期時會用 refresh token 換一組新的,
  // 新 token 由上面的 setAll 寫進 response。
  const { data: { user } } = await supabase.auth.getUser();

  // 導向時必須把 response 上的 cookie 一起帶走。
  //
  // 少了這步會造成間歇性登出,而且很難查:Supabase 的 refresh token 是一次性的,
  // 續期時舊的當場作廢。若那次續期剛好發生在會導向的請求上,新 token 隨著被丟棄的
  // response 一起消失,瀏覽器手上只剩已作廢的舊 token —— 下次續期必定失敗,直接登出。
  // access token 一小時到期,所以症狀是「隔一段時間就要重新登入」。
  function redirectTo(path: string) {
    const r = NextResponse.redirect(new URL(path, request.url));
    response.cookies.getAll().forEach((c) => r.cookies.set(c));
    return r;
  }

  const isLogin = request.nextUrl.pathname.startsWith('/login');
  if (!user && !isLogin) return redirectTo('/login');
  if (user && isLogin) return redirectTo('/reviews');
  return response;
}

// 這個 middleware 是「沒有登入 cookie 就導去 /login」。
// 凡是不靠 cookie 驗證的路徑都必須排除,否則會拿到登入頁的 HTML 而不是預期的回應,
// 而且狀態碼是 200 —— 呼叫端會以為成功,失敗完全沒有徵兆。
//
// ══════════════════════════════════════════════════════════
// ★★★ 2026-09-11：改成排除**整個 `/api/`**，不再逐支列舉
// ══════════════════════════════════════════════════════════
//
// 原本這裡列的是 `api/import|api/push|api/health` —— 一支一支加。
// 而 2026-09-07 新增 `api/close-period`（每日自動關帳）時**沒有人回來改這一行**。
//
// 後果:GitHub Actions 每天打那支端點，每天被導去 /login，
// **關帳從上線到現在一次都沒成功過**（`period_lock` 一列都沒有）。
// 而且這支檔案上面那三行註解，白紙黑字警告的就是這件事。
//
// 同一天查出來還有兩支是一樣的狀況:
//   api/notifications/purge   用 x-import-key
//   api/sync/reconcile        用 x-import-key
// 兩支也都打不通，只是還沒有人發現。
//
// ★★ 所以改成排除整個 `/api/`。**這是安全的** —— 2026-09-11 逐一查過，
//   每一支 API 路由都自己驗身分，沒有一支靠 middleware 擋:
//
//     x-import-key      import/*（8 支）、close-period、notifications/purge、sync/reconcile
//     x-push-key        push/notify
//     Bearer ＋ 角色    admin/staff-account（要 super_admin）、push/subscribe
//     Bearer            bank-statements/import（走呼叫者的 token，RLS 是唯一真相）
//     不需要            health（部署腳本 curl 它）
//
// ★★★ 為什麼這樣比較好:逐支列舉要求「每次加新端點的人都記得回來改這裡」，
//   而那件事已經失敗過一次了。排除整個 `/api/` 之後，
//   **新端點預設就是通的**，而驗證責任留在它自己身上 —— 那本來就是它的事。
//
// ★ 代價:哪天有人寫了一支**忘記驗身分**的 API，它會直接對外開放。
//   防線是 code review 與 RLS（資料庫那一層照樣擋）。
//   拿「忘記驗身分」換掉「忘記開白名單」是划算的:
//   前者寫的時候就看得見，後者是靜默的，而且症狀出現在別的地方。
//
//   manifest / sw.js / icons
//               瀏覽器抓這些檔案時未必帶 cookie,被導走 PWA 就裝不起來。
//               sw.js 另外還有 scope 限制,必須從網站根目錄提供。
export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|api/|manifest.webmanifest|sw.js|icons/|.*\\.(?:svg|png|jpg|ico)$).*)',
  ],
};
