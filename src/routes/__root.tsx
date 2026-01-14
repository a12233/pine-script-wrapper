import { HeadContent, Scripts, createRootRoute } from '@tanstack/react-router'

import appCss from '../styles.css?url'

export const Route = createRootRoute({
  head: () => ({
    meta: [
      {
        charSet: 'utf-8',
      },
      {
        name: 'viewport',
        content: 'width=device-width, initial-scale=1',
      },
      {
        title: 'Pine Script Publisher',
      },
      {
        name: 'description',
        content: 'Validate and publish TradingView Pine Scripts with ease',
      },
    ],
    links: [
      {
        rel: 'stylesheet',
        href: appCss,
      },
    ],
  }),

  shellComponent: RootDocument,
})

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <nav className="navbar">
          <a href="/" className="nav-brand">
            Pine Script Publisher
          </a>
          <div className="nav-links">
            <a href="/">Home</a>
          </div>
        </nav>
        <main>{children}</main>
        <footer className="footer">
          <p>Pine Script Publisher - Validate and publish TradingView indicators</p>
        </footer>
        <Scripts />
      </body>
    </html>
  )
}
