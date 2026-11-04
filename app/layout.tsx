import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = { title: "ConsentCraft — Good stories, made together", description: "A shared studio for comics. Create with your people, give everyone a voice, and publish something you're all proud of." };
export default function RootLayout({ children }: { children: React.ReactNode }) { return <html lang="en"><body>{children}</body></html>; }
