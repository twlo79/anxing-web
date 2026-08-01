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
  const { data: { user } } = await supabase.auth.getUser();
  const isLogin = request.nextUrl.pathname.startsWith('/login');
  if (!user && !isLogin) return NextResponse.redirect(new URL('/login', request.url));
  if (user && isLogin) return NextResponse.redirect(new URL('/reviews', request.url));
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
