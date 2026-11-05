import type { Metadata } from "next";
import "./globals.css";
import { Web3Provider } from "@/components/web3-provider";

export const metadata: Metadata = {
  title: "ConsentCraft — Good stories, made together",
  description: "A shared studio for comics. Create with your people, give everyone a voice, and publish something you're all proud of."
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Web3Provider>
          {children}
        </Web3Provider>
      </body>
    </html>
  );
}
