import {
  createDocumentPreparerHttpServer,
  parseDocumentPreparerServiceConfig,
} from './documents/index.js';

function failStartup(): void {
  process.stderr.write('Document preparer service failed to start\n');
  process.exitCode = 1;
}

try {
  const config = parseDocumentPreparerServiceConfig(process.env);
  const server = createDocumentPreparerHttpServer({
    reportError: (code) => {
      process.stderr.write(`Document preparer request rejected: ${code}\n`);
    },
  });
  server.once('error', failStartup);
  server.listen(config.port, config.host, () => {
    process.stdout.write('Document preparer service ready\n');
  });
} catch {
  failStartup();
}
