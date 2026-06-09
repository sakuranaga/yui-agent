import type { Metadata } from "next";
import { M_PLUS_Rounded_1c, Zen_Kurenaido } from "next/font/google";
import "./globals.css";

// 全体のベースフォントを Google Fonts の M PLUS Rounded 1c に統一。
// next/font が build 時に self-host 化するので外部リクエストは発生しない。
//
// preload: false の理由: M_PLUS_Rounded_1c / Zen_Kurenaido は Japanese フォントで、
// Google Fonts API は Japanese を Unicode range で 100+ サブセットに細分割する
// (= 1 フォントで ~120 woff2 ファイル)。subsets に "japanese" は指定できない仕様で、
// preload を true (= default) のままだと <link rel="preload"> が 200+ 件生成されて
// 「preloaded but not used within a few seconds」警告がコンソールを汚す + Next 16
// dev mode では何らかの理由で 30秒〜数分ごとに preload tag が再注入される挙動も
// 観測 (本番でも warning は出続ける)。CSS 経由のロードで display: swap で fallback
// → 本フォント差し替えする戦略にする。
// 公式: https://nextjs.org/docs/messages/google-fonts-missing-subsets
const mPlusRounded = M_PLUS_Rounded_1c({
  weight: ["400", "500", "700"],
  subsets: ["latin"],
  variable: "--font-mpr",
  display: "swap",
  preload: false,
});

// 日記用の手書き風フォント。
const zenKurenaido = Zen_Kurenaido({
  weight: ["400"],
  subsets: ["latin"],
  variable: "--font-diary",
  display: "swap",
  preload: false,
});

export const metadata: Metadata = {
  title: "VRoid Chat",
  description: "Chat with a VRM character",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ja" className={`${mPlusRounded.variable} ${zenKurenaido.variable}`}>
      <body>{children}</body>
    </html>
  );
}
