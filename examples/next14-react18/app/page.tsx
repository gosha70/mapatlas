// SPDX-License-Identifier: Apache-2.0

import { TripLoop } from "./trip-loop";

/**
 * A Server Component that renders the client-side trip loop — the shape most App Router
 * consumers write: the page stays on the server and the interactive part is a client module.
 */
export default function Page() {
  return (
    <main>
      <h1>Next 14 · React 18 consumer</h1>
      <TripLoop />
    </main>
  );
}
