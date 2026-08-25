import { pathToFileURL } from 'node:url';
import { ACCEPTANCE_HELP, AcceptanceCliError, runAcceptanceCli } from '../src/acceptance/acceptance-cli.js';
import { redactSensitiveText } from '../src/core/redact.js';

export async function main(argv = process.argv.slice(2)): Promise<number> {
  try {
    const result = await runAcceptanceCli(argv);
    if (argv.includes('--help') || argv.includes('-h')) {
      console.log(ACCEPTANCE_HELP);
      return 0;
    }
    for (const warning of result.warnings ?? []) console.warn(`WARNING: ${redactSensitiveText(warning)}`);
    console.log(JSON.stringify({
      runId: result.runId,
      operationContractConclusion: result.conclusion,
      requirementVerification: result.trust?.requirementVerification,
      summary: result.summary,
      trust: result.trust,
      report: result.artifacts?.reportMarkdown,
      html: result.artifacts?.reportHtml,
      rerun: result.runId ? `npm run acceptance -- --run-id ${result.runId} --case-id <CASE_ID>` : undefined,
    }, null, 2));
    return result.exitCode;
  } catch (error) {
    const message = redactSensitiveText((error as Error).message);
    console.error(`${error instanceof AcceptanceCliError ? 'CONFIG_ERROR' : 'ACCEPTANCE_ERROR'}: ${message}`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
