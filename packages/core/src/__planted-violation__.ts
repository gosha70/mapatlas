// SPDX-License-Identifier: Apache-2.0

/**
 * PLANTED VIOLATION — this file exists to prove the isolation gate is real.
 *
 * A bare side-effect import: no bindings, no `from` clause. T0.5 promises this
 * exact form is caught, because a naive `from "..."` regex misses it and an
 * earlier harness shipped a scanner with precisely that hole.
 *
 * `@mapatlas/core` must import nothing from React. CI must reject this.
 * This branch is never merged.
 */

import "react";

export const PLANTED = true;
