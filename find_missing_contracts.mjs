import { Config } from './config/config.mjs';
import { logger } from './utils/logger.mjs';
import { CacheManager } from './utils/cache.mjs';
import { SourcifyAPI } from './services/sourcify-api.mjs';
import { ContractProcessor } from './services/contract-processor.mjs';

async function main() {
  try {
    logger.info("Starting contract verification process");

    // Initialize all components
    const config = await new Config().load();
    const cacheManager = new CacheManager();
    const sourcifyApi = new SourcifyAPI(config.sourcifyApi, config.maxRetries);
    const processor = new ContractProcessor(sourcifyApi, cacheManager, config);

    // Start the processing chain
    await processor.processingChain();

    logger.info("Process completed successfully");
  } catch (error) {
    logger.error("Fatal error:", error);
    process.exit(1);
  }
}

main().catch(error => {
  logger.error("Unhandled error:", error);
  process.exit(1);
});