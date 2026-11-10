import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "GhostNet — Resilient Emergency Network",
  description: "Offline-first emergency communications prototype"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
