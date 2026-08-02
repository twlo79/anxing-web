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
//   api/import  用 x-import-key 驗證
//   api/push    subscribe 用 Bearer token、notify 用 x-push-key,兩者都不吃 cookie。
//               漏掉這條的話 Supabase webhook 會被導去 /login,推播永遠不會發出。
//   manifest / sw.js / icons
//               瀏覽器抓這些檔案時未必帶 cookie,被導走 PWA 就裝不起來。
//               sw.js 另外還有 scope 限制,必須從網站根目錄提供。
export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|api/import|api/push|manifest.webmanifest|sw.js|icons/|.*\\.(?:svg|png|jpg|ico)$).*)',
  ],
};
