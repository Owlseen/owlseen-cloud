import type { Metadata, Viewport } from "next";
import { Geologica, Spline_Sans_Mono } from "next/font/google";
import { ThemeProvider } from "next-themes";
import { CloudAnalytics } from "@/components/cloud/cloud-analytics";
import { isCloudService } from "@/components/cloud/cloud-service";
import { BRAND } from "@/domain/brand";
import "./globals.css";

const sans = Geologica({ variable: "--font-brand-sans", subsets: ["latin", "latin-ext"], axes: ["SHRP"], display: "swap" });
const mono = Spline_Sans_Mono({ variable: "--font-brand-mono", subsets: ["latin", "latin-ext"], display: "swap" });

export const metadata: Metadata = {
  // Where the social card is served from; a build that doesn't know its address leaves it to the platform.
  metadataBase: process.env.BETTER_AUTH_URL ? new URL(process.env.BETTER_AUTH_URL) : undefined,
  title: { default: BRAND, template: `%s · ${BRAND}` },
  description: "How your sites do in search: positions, keywords, pages and what dropped out of the index, from a screen or from your assistant.",
  robots: { index: false },
};

export const viewport: Viewport = {
  colorScheme: "dark light",
  themeColor: "#0a0a08",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" suppressHydrationWarning className={`dark ${sans.variable} ${mono.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col">
        {/* Dark first, as an owl works at night, with light on request: never following the system into a different look from the site. */}
        <ThemeProvider attribute="class" defaultTheme="dark" enableSystem={false}>
          {children}
        </ThemeProvider>
        {isCloudService() && <CloudAnalytics />}
      </body>
    </html>
  );
}
