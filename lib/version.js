import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** Single source of truth: the packaged manifest. */
export const version = require('../package.json').version;
