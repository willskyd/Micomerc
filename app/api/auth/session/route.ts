
import {
  ADMIN_SESSION_COOKIE,
  adminAuthConfigurationMessage,
  getAdminAuthConfiguration,
  readAdminSession,
} from "@/lib/admin-auth";
import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  try {
    const configuration = getAdminAuthConfiguration();

    if (configuration.missingVariables.length) {
      return NextResponse.json(
        { message: adminAuthConfigurationMessage(configuration.missingVariables) },
        { status: 503 },
      );
    }

    const currentToken = request.cookies.get(ADMIN_SESSION_COOKIE)?.value;
    const session = readAdminSession(currentToken);

    return NextResponse.json(
      session
        ? {
            authenticated: true,
            email: session.email,
            role: session.role,
          }
        : {
            authenticated: false,
          },
    );
  } catch (error) {
    console.error("Could not verify admin session:", error);

    return NextResponse.json(
      { message: "Admin session verification is unavailable" },
      { status: 500 },
    );
  }
}
