import "./globals.css";

export const metadata = {
  title: "CS 답변 추천기",
  description: "고객 질문을 입력하면 표준 답변을 확률(%)로 추천합니다."
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}


