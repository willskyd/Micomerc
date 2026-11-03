
import { ADMIN_SESSION_COOKIE } from "@/lib/admin-auth";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");

  let sameOrigin = false;

  try {
    sameOrigin = !!origin && !!host && new URL(origin).host === host;
  } catch {
    sameOrigin = false;
  }

  if (!sameOrigin) {
    return NextResponse.json(
      { message: "Sign-out request origin is not allowed" },
      { status: 403 },
    );
  }

  const response = NextResponse.json({ authenticated: false });

  response.cookies.set(ADMIN_SESSION_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });

  return response;
}
