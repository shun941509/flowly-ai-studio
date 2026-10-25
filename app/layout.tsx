import type { Metadata } from "next";
import "./globals.css";
import "./studio-theme.css";
import "./editor-composition.css";

export const metadata: Metadata = {
  title: "Flowly · 나만의 AI를 연결하다",
  description: "코드 없이 만드는 나만의 AI 워크플로. 도구, 스킬, 자료를 연결하고 아이디어를 실행해 보세요.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
