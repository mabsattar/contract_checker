import { Config } from './config/config.mjs';
import { logger } from './utils/logger.mjs';
import { CacheManager } from './utils/cache.mjs';
import { SourcifyAPI } from './services/sourcify-api.mjs';
import { ContractProcessor } from './services/contract-processor.mjs';
import { ContractFinder } from './services/contract-finder.mjs';
import { HealthCheck } from './utils/health-check.mjs';
import path from 'path';
import fs from 'fs/promises';

async function main() {
  try {
    // Get chain from command line argument or environment variable
    const chainName = process.argv[2] || process.env.CHAIN || 'ethereum_mainnet';

    logger.info(`Starting contract verification process for ${chainName}`);

    // Initialize config for specific chain
    const config = new Config();
    const chainConfig = await config.load(chainName);

    // Create output directory for this chain
    const chainOutputDir = path.join(process.cwd(), 'output', chainName);
    await fs.mkdir(chainOutputDir, { recursive: true });

    // Initialize components with chain-specific config
    const cacheManager = new CacheManager(chainName);
    await cacheManager.init();

    const sourcifyApi = new SourcifyAPI(chainConfig);
    const finder = new ContractFinder(sourcifyApi, chainConfig, cacheManager);

    const healthCheck = new HealthCheck();

    // Add periodic health checks
    const healthCheckInterval = setInterval(() => {
      const status = healthCheck.updateStatus(sourcifyApi.getStats());
      if (!status.healthy) {
        logger.error('Unhealthy status detected:', status);
        // Implement recovery logic if needed
      }
    }, 30000);

    // Reset stats for this chain
    await finder.resetStats();

    // Phase 1: Find missing contracts
    logger.info("Starting Phase 1: Finding missing contracts");
    //const testFolder = '00'; // Remove this if you want to scan all folders
    const { stats, missingContractsFile } = await finder.findMissingContracts(/*testFolder*/);

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

// Add a helper to list available chains
async function listChains() {
  const config = new Config();
  const chains = await config.listAvailableChains();
  console.log('Available chains:');
  chains.forEach(chain => console.log(`- ${chain}`));
}

// Handle command line arguments
if (process.argv[2] === '--list-chains') {
  listChains();
} else {
  main().catch(error => {
    logger.error("Fatal error in main:", error);
    process.exit(1);
  });
}
