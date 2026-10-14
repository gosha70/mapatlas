// SPDX-License-Identifier: Apache-2.0

import "maplibre-gl/dist/maplibre-gl.css";

import type { ReactNode } from "react";

/** The root layout: a Server Component, as `create-next-app` writes it. */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
