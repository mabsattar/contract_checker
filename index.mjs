import { Config } from './config/config.mjs';
import { logger } from './utils/logger.mjs';
import { CacheManager } from './utils/cache.mjs';
import { SourcifyAPI } from './services/sourcify-api.mjs';
import { ContractProcessor } from './services/contract-processor.mjs';
import { ContractFinder } from './services/contract-finder.mjs';

async function main() {
  try {
    logger.info("Starting contract verification process");

    // Initialize all components
    const config = await new Config().load();
    const cacheManager = new CacheManager();
    const sourcifyApi = new SourcifyAPI(config.sourcifyApi, config.maxRetries);

    // Phase 1: Find missing contracts
    logger.info("Starting Phase 1: Finding missing contracts");
    const finder = new ContractFinder(sourcifyApi, config);

    // If wants to test with a specific folder
    const testFolder = '00'; // Remove this if you want to scan all folders
    const { stats, missingContractsFile } = await finder.findMissingContracts(testFolder);

    logger.info('Contract finding phase completed:', stats);

    // Check if we should proceed with submission
    if (process.env.AUTO_SUBMIT !== 'true') {
      logger.info('Review missing_contracts.json and set AUTO_SUBMIT=true to proceed with submission');
      return;
    }

    // Phase 2: Submit missing contracts
    if (stats.missing > 0) {
      logger.info(`Starting Phase 2: Submitting ${stats.missing} missing contracts`);
      const processor = new ContractProcessor(sourcifyApi, cacheManager, config);
      await processor.processFromFile(missingContractsFile);
    } else {
      logger.info('No missing contracts found to submit');
    }

    logger.info("Process completed successfully");
  } catch (error) {
    logger.error("Fatal error:", error);
    process.exit(1);
  }
}

// Error handling for unhandled rejections
process.on('unhandledRejection', (error) => {
  logger.error("Unhandled rejection:", error);
  process.exit(1);
});

// Graceful shutdown handler
process.on('SIGINT', async () => {
  logger.info('Received SIGINT. Shutting down gracefully...');
  try {
    // Add any cleanup operations here
    await cleanup();
    process.exit(0);
  } catch (error) {
    logger.error('Error during cleanup:', error);
    process.exit(1);
  }
});

// Cleanup function
async function cleanup() {
  // Add any cleanup operations here
  logger.info('Cleanup completed');
}

// Start the application
main().catch(error => {
  logger.error("Fatal error in main:", error);
  process.exit(1);
});
