<!-- SPDX-License-Identifier: Apache-2.0 -->

# Security Policy

## Reporting a vulnerability

Please report security issues **privately** via GitHub's "Report a vulnerability"
(Security Advisories) on this repository, rather than opening a public issue. Include
steps to reproduce and the affected version/commit. We aim to acknowledge within a few
business days.

## Scope notes for a mapping/location engine

MAP-ATLAS handles **location data**, which is sensitive by nature. Contributions are held
to these rules:

- **No telemetry by default.** The engine must not phone home or transmit location,
  tracks, or media anywhere the consuming application did not explicitly configure.
- **The analyzer seam is an egress boundary.** A `MediaAnalyzer` may send photos to a
  remote service; the engine must make that call explicit and consumer-controlled, never
  implicit. Document any network egress in the analyzer's contract.
- **Storage stays local unless told otherwise.** The default `StorageAdapter` persists to
  on-device storage only. A sync/remote adapter is a consumer concern.
- **The presentation seam is an injection boundary.** `MarkerStyle.html` (an
  `EventPresentation`) is inserted into the DOM verbatim so consumers can draw their own marks.
  It is **consumer-authored markup** and must never be built from user input, imported files, or
  analyzer output. Consumers that need user-derived marker content must escape it themselves;
  the engine escapes `ariaLabel` and text, not `html`.
- **Sensor channels are location-adjacent data.** `TrackPoint.channels` may carry health
  telemetry (heart rate) alongside a precise position and timestamp. It is stored and exported
  exactly like the rest of a track: locally by default, never transmitted by the engine, and
  subject to the consumer's own privacy transforms before anything leaves a device.
- **No secrets in the repo**, ever — keys, tokens, tile-provider credentials belong in
  consumer configuration.

Privacy transforms on shared data (e.g. coarsening or trimming a track before it leaves a
device) are the **consumer's** responsibility; MAP-ATLAS provides the raw primitives and
must not silently weaken them.
