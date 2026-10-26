/**
 * 전체 경로에서 공유하는 한국어 문서 틀과 전역 스타일 진입점.
 * CSS는 기본 스타일 → 테마 → 기능별 화면 → 편집기 배치 순서로 덮어쓰므로 import 순서를 유지한다.
 */
import type { Metadata } from "next";
import "./globals.css";
import "./studio-theme.css";
import "./editor-composition.css";
import "./studio-pages.css";
import "./export-ui.css";
import "./editor-layout.css";
import "./resource-experience.css";

export const metadata: Metadata = {
  title: "Flowly · 나만의 AI를 연결하다",
  description: "코드 없이 만드는 나만의 AI 워크플로. 도구, 스킬, 자료를 연결하고 아이디어를 실행해 보세요.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

/** 서버 페이지와 클라이언트 Studio가 동일한 문서 언어·메타데이터·스타일을 사용하도록 감싼다. */
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
