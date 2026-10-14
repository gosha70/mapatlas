// SPDX-License-Identifier: Apache-2.0

import { MapCanvas } from "@mapatlas/react";

/**
 * **A Server Component importing the engine directly** — no client wrapper in between (ADR-0043).
 *
 * Before `@mapatlas/react` marked its modules `"use client"`, this exact file failed the
 * consumer's `next build` while prerendering, with `useRef is not a function`: the RSC graph
 * evaluated the component's hooks on the server runtime. Now the import is a client reference,
 * the shell prerenders, and the map mounts after hydration. Only serialisable props cross the
 * boundary, which is why no callback and no store is passed here.
 */
export default function ServerImportPage() {
  return (
    <main>
      <h1>Imported from a Server Component</h1>
      <div id="map" style={{ width: 640, height: 360 }}>
        <MapCanvas sources={[]} initialCamera={{ center: { lat: 45.84, lng: 6.865 }, zoom: 12 }} />
      </div>
    </main>
  );
}
