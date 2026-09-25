// SPDX-License-Identifier: Apache-2.0

/**
 * Fail the job if the probe did not leave both of its durable outputs.
 *
 * **Its own step, between the probe and the upload**, because the upload cannot make this check:
 * `if-no-files-found: error` rejects an empty directory and accepts one holding half the pair.
 * A probe that wrote its transcript and died before its report would otherwise produce an
 * artifact that looks complete and is missing the file a reader opens first.
 *
 * **It runs `if: always()` and so does the upload after it.** This step failing must not cost the
 * transcript that survived — the point is to *say* the output is incomplete, not to discard what
 * there is. It also must not mask the probe's own exit status: the probe's step has already run
 * and already failed the job if it was going to.
 */

import { missingOutputs, OUTPUT_DIR } from "./probe-output.mjs";

const missing = missingOutputs(process.cwd());

if (missing.length > 0) {
  console.error(
    `check:probe-output — incomplete: ${OUTPUT_DIR}/ is missing ${missing.join(" and ")}. ` +
      `The probe did not leave the output this job exists to preserve.`,
  );
  process.exit(1);
}

console.log(`check:probe-output — clean (${OUTPUT_DIR}/ holds the transcript and the report)`);
