// SPDX-License-Identifier: Apache-2.0

/**
 * Write down everything that failed in one run of the suite, structured (T8.1 increment 2c).
 *
 * **Why the experiment needs it.** A run's *kind* comes from its text and is one of three; whether
 * something **else** failed in the same run is a separate question, and the text cannot answer it
 * reliably. `unrelatedFailures` in `flake-probe.mjs` answers it from this file.
 *
 * **Why not Vitest's own JSON reporter.** Measured on 4.1.11 before this was written: it records a
 * failed test with its messages and a module's first error, and **nothing at all for a failure
 * thrown in a `describe`-level hook** — the tests under it are `skipped`, the module's `message` is
 * empty, and only a counter moves. Unhandled errors are not recorded either. A list of unrelated
 * failures with a hole that shape is the masking this exists to close, so this walks the whole
 * tree — modules, suites, tests — and takes the unhandled errors as well.
 *
 * Added by `vitest.config.ts` only while probing, which names the output file; it writes nothing
 * and is not loaded in an ordinary run.
 */

import { writeFileSync } from "node:fs";

const messagesOf = (errors) => errors.map((error) => String(error?.message ?? error));

export default class ProbeResultsReporter {
  /** @param {{ outputFile: string }} options */
  constructor({ outputFile }) {
    this.outputFile = outputFile;
  }

  onTestRunEnd(testModules, unhandledErrors, reason) {
    const failures = [];
    const record = (kind, where, errors) => {
      if (errors.length > 0) failures.push({ kind, where, messages: messagesOf(errors) });
    };

    for (const testModule of testModules) {
      record("module", testModule.relativeModuleId, testModule.errors());
      for (const suite of testModule.children.allSuites()) {
        record("hook", `${testModule.relativeModuleId} > ${suite.fullName}`, suite.errors());
      }
      for (const test of testModule.children.allTests("failed")) {
        const where = `${testModule.relativeModuleId} > ${test.fullName}`;
        const errors = test.result().errors ?? [];
        // A failed test with no error attached still failed, and must not vanish from the list.
        if (errors.length === 0) failures.push({ kind: "test", where, messages: [] });
        else record("test", where, errors);
      }
    }
    record("unhandled", "an unhandled error outside any test", unhandledErrors);

    writeFileSync(this.outputFile, JSON.stringify({ reason, failures }));
  }
}
