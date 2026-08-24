import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Envorso · Win-back console",
  description: "Agent-proposed win-back offers for stale Seawolves ticket carts, reviewed by a marketer before anything reaches a fan.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <main>{children}</main>
      </body>
    </html>
  );
}
