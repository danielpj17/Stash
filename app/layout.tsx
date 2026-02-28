import type { Metadata } from "next";
import "./globals.css";
import Providers from "@/components/Providers";

export const metadata: Metadata = {
  title: "Financial Dashboard",
  description: "Track expenses, budget, and net worth",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-charcoal">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
