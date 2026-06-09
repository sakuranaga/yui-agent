"use client";

/**
 * mount 直後に localStorage から theme を読んで body[data-theme] にセット。
 * SSR では何もせず、クライアントに渡った瞬間に適用 (フラッシュ最小化のため
 * useEffect ではなく useLayoutEffect 相当のタイミングが理想だが、
 * Next.js SSR との兼ね合いで useEffect で OK)。
 */
import { useEffect } from "react";
import { applyTheme, getStoredTheme } from "./ThemeSection";

export default function ThemeProvider() {
  useEffect(() => {
    applyTheme(getStoredTheme());
  }, []);
  return null;
}
