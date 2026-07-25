import { pathToFileURL } from "node:url";
import {
  type ClassifyModelMetadataAgainstModelsDevOptions,
  classifyModelMetadataAgainstModelsDev,
  formatModelMetadataCheckReport,
  hasActionableModelMetadataFindings,
  type ModelMetadataDriftCheckResult,
  type ModelsDevCatalog,
  parseModelsDevCatalog,
} from "../src/core/model-metadata-drift.ts";

const MODELS_DEV_API_URL = "https://models.dev/api.json";

interface CheckModelMetadataOptions
  extends ClassifyModelMetadataAgainstModelsDevOptions {
  readonly apiUrl?: string;
  readonly fetchCatalog?: () => Promise<unknown>;
  readonly writeStdout?: (text: string) => void;
  readonly writeStderr?: (text: string) => void;
}

async function fetchModelsDevCatalog(apiUrl: string): Promise<unknown> {
  const response = await fetch(apiUrl);
  if (!response.ok) {
    throw new Error(
      `models.dev request failed: ${response.status} ${response.statusText}`,
    );
  }
  return response.json();
}

export async function runCheckModelMetadata(
  options: CheckModelMetadataOptions = {},
): Promise<number> {
  const writeStdout =
    options.writeStdout ??
    ((text: string) => {
      process.stdout.write(text);
    });
  const writeStderr =
    options.writeStderr ??
    ((text: string) => {
      process.stderr.write(text);
    });
  const fetchCatalog =
    options.fetchCatalog ??
    (() => fetchModelsDevCatalog(options.apiUrl ?? MODELS_DEV_API_URL));

  let result: ModelMetadataDriftCheckResult;
  try {
    const catalog: ModelsDevCatalog = parseModelsDevCatalog(
      await fetchCatalog(),
    );
    result = classifyModelMetadataAgainstModelsDev(catalog, options);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    writeStderr(`check:model-metadata source failure: ${message}\n`);
    return 2;
  }

  writeStdout(`${formatModelMetadataCheckReport(result)}\n`);
  return hasActionableModelMetadataFindings(result) ? 1 : 0;
}

function isMainModule(): boolean {
  const scriptPath = process.argv[1];
  return (
    scriptPath !== undefined &&
    import.meta.url === pathToFileURL(scriptPath).href
  );
}

/* v8 ignore next 4: direct script execution is covered by CLI smoke tests outside the in-process coverage runtime. */
if (isMainModule()) {
  runCheckModelMetadata().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
