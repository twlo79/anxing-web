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

// PWA 注意事項:manifest.webmanifest、sw.js、icons/ 一定要排除在登入檢查之外。
// 瀏覽器抓 manifest 與 service worker 時未必帶著登入 cookie,被導去 /login 的話
// 拿到的是 HTML 而不是 JSON/JS,PWA 就裝不起來,而且錯誤訊息完全看不出原因。
// sw.js 另外還有一個限制:它的 scope 取決於檔案路徑,必須從網站根目錄提供。
export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|api/import|manifest.webmanifest|sw.js|icons/|.*\\.(?:svg|png|jpg|ico)$).*)',
  ],
};
