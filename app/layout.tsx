import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Bay Six - voice copilot for the repair bay',
  description:
    'A hands-free, eyes-free voice agent for auto technicians. Rime coda is the primary spoken output.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
