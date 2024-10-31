import { Config } from './config/config.mjs';
import { logger } from './utils/logger.mjs';
import { CacheManager } from './utils/cache.mjs';
import { SourcifyAPI } from './services/sourcify-api.mjs';
import { ContractProcessor } from './services/contract-processor.mjs';
import { ContractFinder } from './services/contract-finder.mjs';
import { HealthCheck } from './utils/health-check.mjs';

async function main() {
  try {
    logger.info("Starting contract verification process");

    // Initialize all components
    const config = await new Config().load();
    const cacheManager = new CacheManager();
    const sourcifyApi = new SourcifyAPI(config);
    const finder = new ContractFinder(sourcifyApi, config);

    const healthCheck = new HealthCheck();

    // Add periodic health checks
    const healthCheckInterval = setInterval(() => {
      const status = healthCheck.updateStatus(sourcifyApi.getStats());
      if (!status.healthy) {
        logger.error('Unhealthy status detected:', status);
        // Implement recovery logic if needed
      }
    }, 30000);

    // Reset stats before starting
    await finder.resetStats();

    // Phase 1: Find missing contracts
    logger.info("Starting Phase 1: Finding missing contracts");
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

    // Cleanup
    clearInterval(healthCheckInterval);
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
  logger.info('Received interrupt signal. Saving progress...');
  try {
    await finder.saveProgress();
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
