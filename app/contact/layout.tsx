import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Contact | Stash",
  robots: "noindex, nofollow",
};

export default function ContactLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
