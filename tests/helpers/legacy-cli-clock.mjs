// Explicit test-only preload: retain historical v1 CLI coverage after its real retirement.
// Production CLI does not import this module or read this test clock variable.
import { mock } from 'node:test';
import { NOW } from './development-evidence-fixture.mjs';

mock.timers.enable({ apis: ['Date'], now: Date.parse(process.env.SEORI_TEST_LEGACY_CLI_NOW ?? NOW) });
