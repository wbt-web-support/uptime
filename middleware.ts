import { createServerClient } from '@supabase/ssr'
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({
    request: {
      headers: request.headers,
    },
  })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return [...request.cookies.getAll()]
        },
        setAll(cookiesToSet) {
          for (const cookie of cookiesToSet) {
            response.cookies.set(cookie.name, cookie.value, cookie.options)
          }
        },
      },
    }
  )

  const {
    data: { session },
  } = await supabase.auth.getSession()

  // Check if the request is for the admin page
  if (request.nextUrl.pathname.startsWith('/admin')) {
    if (!session) {
      // If there's no session, redirect to the login page
      return NextResponse.redirect(new URL('/sign-in', request.url))
    }

    // Get the admin email(s) from environment variables or hard-coded value
    const adminEmail = process.env.ADMIN_EMAIL || 'admin@example.com'
    const adminEmails = adminEmail.split(',').map(email => email.trim().toLowerCase())

    // Check if the user's email is in the list of admin emails
    if (!session.user?.email || !adminEmails.includes(session.user.email.toLowerCase())) {
      // If not an admin, redirect to the home page
      return NextResponse.redirect(new URL('/', request.url))
    }
  } else if (request.nextUrl.pathname.startsWith('/protected')) {
    // For other protected routes, just check for a session
    if (!session) {
      return NextResponse.redirect(new URL('/sign-in', request.url))
    }
  }

  return response
}

// Every page (not API routes, Next.js files or images): getSession() above
// refreshes the login, and when its refresh token is dead ("Invalid Refresh Token:
// Refresh Token Not Found") Supabase clears the login cookie through setAll -
// which only reaches the browser from here. Run on /admin and /protected only,
// every other page kept the dead cookie and hit the same error on each load.
export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)'],
}
