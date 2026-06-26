import { pathToFileURL } from "node:url";
import {
  diffModelMetadataAgainstModelsDev,
  formatModelMetadataDriftReport,
  formatUntrackedModelsDevModelsReport,
  parseModelsDevCatalog,
  unmonitoredKnownModelMetadataEntries,
  untrackedModelsDevModels,
} from "../src/core/model-metadata-drift.ts";

const MODELS_DEV_API_URL = "https://models.dev/api.json";

async function fetchModelsDevCatalog(): Promise<unknown> {
  const response = await fetch(MODELS_DEV_API_URL);
  if (!response.ok) {
    throw new Error(
      `models.dev request failed: ${response.status} ${response.statusText}`,
    );
  }
  return response.json();
}

async function runCheckModelMetadata(): Promise<number> {
  const catalog = parseModelsDevCatalog(await fetchModelsDevCatalog());
  const drift = diffModelMetadataAgainstModelsDev(catalog);
  const unmonitored = unmonitoredKnownModelMetadataEntries();
  const untracked = untrackedModelsDevModels(catalog);
  console.log(formatModelMetadataDriftReport(drift));
  if (unmonitored.length > 0) {
    console.log(`Unmonitored registry entries: ${unmonitored.join(", ")}`);
  }
  if (untracked.length > 0) {
    console.log(formatUntrackedModelsDevModelsReport(untracked));
  }
  return drift.length === 0 &&
    unmonitored.length === 0 &&
    untracked.length === 0
    ? 0
    : 1;
}

function isMainModule(): boolean {
  const scriptPath = process.argv[1];
  return (
    scriptPath !== undefined &&
    import.meta.url === pathToFileURL(scriptPath).href
  );
}

if (isMainModule()) {
  runCheckModelMetadata()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`check:model-metadata failed: ${message}`);
      process.exitCode = 1;
    });
}
