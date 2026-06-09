/**
 * POST /api/auth/logout
 * cookie を即座に expire させる。
 */
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const COOKIE_NAME = "vroid-auth";

export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE_NAME, "", {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    path: "/",
    maxAge: 0,
  });
  return res;
}
