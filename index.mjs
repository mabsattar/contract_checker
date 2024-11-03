import { Config } from './config/config.mjs';
import { logger } from './utils/logger.mjs';
import { CacheManager } from './utils/cache.mjs';
import { SourcifyAPI } from './services/sourcify-api.mjs';
import { ContractProcessor } from './services/contract-processor.mjs';
import { ContractFinder } from './services/contract-finder.mjs';
import { HealthCheck } from './utils/health-check.mjs';
import path from 'path';
import fs from 'fs/promises';

function parseFolderOption(args) {
  const folderIndex = args.indexOf('--folder');
  return folderIndex !== -1 ? args[folderIndex + 1] : null;
}

async function main() {
  try {
    // Remove default value and require explicit chain specification
    const chainName = process.argv[2] || process.env.CHAIN;

    if (!chainName) {
      logger.error('No chain specified. Please specify a chain (e.g., ethereum_mainnet, ethereum_sepolia)');
      logger.info('To see available chains, run: node index.mjs --list-chains');
      process.exit(1);
    }

    logger.info(`Starting contract verification process for ${chainName}`);

    // Initialize components
    const config = new Config();
    const chainConfig = await config.load(chainName);
    const cacheManager = new CacheManager(chainName);
    const sourcifyApi = new SourcifyAPI(chainConfig);

    // Create chain-specific directory structure
    const chainOutputDir = path.join(process.cwd(), 'chains', chainConfig.output_dir);
    await fs.mkdir(chainOutputDir, { recursive: true });

    // Initialize components with chain-specific config
    await cacheManager.init();

    // Initialize health check
    const healthCheck = new HealthCheck();

    // Add periodic health checks
    const healthCheckInterval = setInterval(() => {
      const status = healthCheck.updateStatus(sourcifyApi.getStats());
      if (!status.healthy) {
        logger.error('Unhealthy status detected:', status);
      }
    }, 30000);

    // Check if we're in submission mode
    if (process.env.AUTO_SUBMIT === 'true') {
      logger.info('Starting submission phase...');
      const missingContractsFile = path.join(chainOutputDir, 'missing_contracts.json');

      try {
        // Check if file exists
        await fs.access(missingContractsFile);

        // Process submissions
        const processor = new ContractProcessor(sourcifyApi, cacheManager, chainConfig);
        await processor.processFromFile(missingContractsFile);

        // Clear interval before returning
        clearInterval(healthCheckInterval);
        return;
      } catch (error) {
        // If file doesn't exist, create it with an empty array
        if (error.code === 'ENOENT') {
          await fs.writeFile(missingContractsFile, JSON.stringify([], null, 2));
          logger.info(`Created new missing_contracts.json in ${chainOutputDir}`);

          // Also create other necessary files
          const files = {
            'matching_contracts.json': [],
            'submission_stats.json': {},
            'submitted_contracts.json': []
          };

          for (const [filename, initialData] of Object.entries(files)) {
            const filePath = path.join(chainOutputDir, filename);
            await fs.writeFile(filePath, JSON.stringify(initialData, null, 2));
            logger.info(`Created ${filename} in ${chainOutputDir}`);
          }
        } else {
          logger.error(`Error accessing ${missingContractsFile}:`, error);
          clearInterval(healthCheckInterval);
          process.exit(1);
        }
      }
    }

    // If not in submission mode, run finding phase
    logger.info('Starting finding phase...');
    const finder = new ContractFinder(sourcifyApi, chainConfig, cacheManager);
    await finder.resetStats();

    const folderOption = parseFolderOption(process.argv);
    const { stats } = await finder.findMissingContracts(folderOption);

    logger.info('Contract finding phase completed:', stats);
    logger.info('To submit contracts, run: AUTO_SUBMIT=true node index.mjs ethereum_mainnet');

    // Clear interval before exiting
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
