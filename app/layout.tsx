import type { Metadata } from "next";
import { Geist_Mono, Figtree } from "next/font/google";
import "./globals.css";
import ConvexClientProvider from "@/components/ConvexClientProvider";
import { PayflowProvider } from "@/components/providers/PayflowProvider";
import { cn } from "@/lib/utils";

const figtree = Figtree({ subsets: ["latin"], variable: "--font-sans" });

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "AI PayFlow — Autonomous Treasury",
  description:
    "AI analyzes supplier invoices and cash flow. Sui enforces what the agent is allowed to pay.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={cn("font-sans", figtree.variable, geistMono.variable)}>
      <body className="antialiased">
        <ConvexClientProvider>
          <PayflowProvider>{children}</PayflowProvider>
        </ConvexClientProvider>
      </body>
    </html>
  );
}
