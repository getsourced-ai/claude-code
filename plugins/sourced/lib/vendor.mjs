// The extension's shared modules, vendored byte for byte into ../vendor by
// scripts/sync-plugin-vendor.mjs (an installed plugin cannot reach ../src).
// They set module.exports under CommonJS, so they load through require and
// take their Node branch: no window, no globals.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const VENDOR_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'vendor');

const require = createRequire(join(VENDOR_DIR, 'package.json'));
const stageParser = require('./stage-parser.js');
const recordStages = require('./record-stages.js');
const captureContract = require('./capture-contract.js');

export const { stageFromRecord, searchDataFromStages, entityDataFromRecords, provenanceOf, toEpochSeconds, toEpochMs } = recordStages;
export const { normalizeUrl, domainOf } = stageParser;
export const { validateCaptureDetail } = captureContract;
export { stageParser, recordStages, captureContract };
