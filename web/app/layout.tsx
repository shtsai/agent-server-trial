export const metadata = { title: "agent-server-trial" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "ui-sans-serif, system-ui", margin: 0, background: "#0b0d10", color: "#e6e8eb" }}>
        {children}
      </body>
    </html>
  );
}
