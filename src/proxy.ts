import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';

/**
 * Runs before every /staff request:
 *  - refreshes the Supabase Auth session cookie (Server Components can't write cookies), and
 *  - sends signed-out visitors to the sign-in page (the JSON API answers 401 instead).
 * Pages and actions still check the staff member's role and active flag themselves.
 */
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });
  const supabase = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) response.cookies.set(name, value, options);
        for (const [key, value] of Object.entries(headers ?? {})) response.headers.set(key, value);
      },
    },
  });

  const { data } = await supabase.auth.getClaims();
  const signedIn = Boolean(data?.claims?.sub);
  const { pathname, search } = request.nextUrl;

  if (!signedIn && pathname !== '/staff/login') {
    if (pathname.startsWith('/staff/api/')) {
      return NextResponse.json({ error: 'Please sign in again.' }, { status: 401 });
    }
    const login = new URL('/staff/login', request.url);
    login.searchParams.set('next', pathname + search);
    return NextResponse.redirect(login);
  }
  return response;
}

export const config = {
  matcher: ['/staff', '/staff/:path*'],
};
