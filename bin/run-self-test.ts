import { pathToFileURL } from 'node:url';
import { redactSensitive, redactSensitiveText } from '../src/core/redact.js';
import { SELF_TEST_HELP, SelfTestCliError, runSelfTestCli } from '../src/self-test/self-test-cli.js';

export async function main(argv = process.argv.slice(2)): Promise<number> {
  try {
    const result = await runSelfTestCli(argv);
    if (argv.includes('--help') || argv.includes('-h')) {
      console.log(SELF_TEST_HELP);
      return 0;
    }
    console.log(JSON.stringify(redactSensitive(result.report), null, 2));
    return result.exitCode;
  } catch (error) {
    console.error(`${error instanceof SelfTestCliError ? 'CONFIG_ERROR' : 'SELF_TEST_ERROR'}: ${redactSensitiveText((error as Error).message)}`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
