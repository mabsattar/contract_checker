
import { Config } from './config/config.mjs';
import { logger } from './utils/logger.mjs';
import { CacheManager } from './utils/cache.mjs';
import { SourcifyAPI } from './services/sourcify-api.mjs';
import { ContractProcessor } from './services/contract-processor.mjs';

logger.info("Starting contract verification process");



async function main() {
  try {
    logger.info("Starting contract verification process");

    // Initialize all components
    const config = await new Config().load();
    const cacheManager = new CacheManager();
    const sourcifyApi = new SourcifyAPI(config.sourcifyApi, config.maxRetries);
    const processor = new ContractProcessor(sourcifyApi, cacheManager, config);

    // Specify the test folder
    const testFolder = '00';

    // Start the processing chain
    await processor.processingChain(testFolder);

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

process.on('SIGINT', () => {
  logger.info('Received SIGINT. Shutting down gracefully...');
  // Close open resources, save state, etc.
  process.exit(0);
});
