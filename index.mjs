import { Config } from './config/config.mjs';
import { logger } from './utils/logger.mjs';
import { CacheManager } from './utils/cache.mjs';
import { SourcifyAPI } from './services/Sourcify_API.mjs';
import { ContractProcessor } from './services/Contract_Processor.mjs';
import { ContractFinder } from './services/Contract_Finder.mjs';
import { HealthCheck } from './utils/Health_Check.mjs';
import path from 'path';
import fs from 'fs/promises';

const VALID_COMMANDS = ['find', 'process', 'submit'];

function parseFolderOption(args) {
  const folderIndex = args.indexOf('--folder');
  return folderIndex !== -1 ? args[folderIndex + 1] : null;
}

function parseCommand() {
  const command = process.argv[2];
  const chain = process.argv[3];
  const folderOption = parseFolderOption(process.argv);

  if (!VALID_COMMANDS.includes(command)) {
    logger.error(`Invalid command. Valid commands are: ${VALID_COMMANDS.join(', ')}`);
    logger.info('Usage examples:');
    logger.info('  Find contracts:    node index.mjs find ethereum_mainnet --folder 00');
    logger.info('  Process contracts: node index.mjs process ethereum_mainnet --folder 00');
    logger.info('  Submit to Sourcify: node index.mjs submit ethereum_mainnet');
    process.exit(1);
  }

  if (!chain) {
    logger.error('No chain specified. Please specify a chain (e.g., ethereum_mainnet)');
    process.exit(1);
  }
  
  return { command, chain, folderOption };
}

async function main() {
  const { command, chain: chainName, folderOption } = parseCommand();
  
  try {
    logger.info(`Starting ${command} phase for ${chainName}${folderOption ? ` (folder: ${folderOption})` : ''}`);

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

    switch (command) {
      case 'find':
        const finder = new ContractFinder(sourcifyApi, chainConfig, cacheManager);
        await finder.resetStats();
        const { stats } = await finder.findMissingContracts(folderOption);
        logger.info('Contract finding phase completed:', stats);
        logger.info(`To process found contracts, run: node index.mjs process ${chainName}${folderOption ? ` --folder ${folderOption}` : ''}`);
        break;

      case 'process':
        // Processing phase
        const processor = new ContractProcessor(sourcifyApi, cacheManager, chainConfig);
        const processedContracts = await processor.processMissingContracts(
          chainConfig.chain_name.split('_')[0],
          chainConfig.chain_name.split('_')[1],
          folderOption
        );
        
        // Save the processed contracts
        await processor.saveProcessedContracts(
          processedContracts,
          chainConfig.chain_name.split('_')[0],
          chainConfig.chain_name.split('_')[1],
          folderOption
        );
        
        logger.info(`Processed and formatted ${processedContracts.length} contracts${folderOption ? ` from folder ${folderOption}` : ''}`);
        logger.info(`To submit contracts to Sourcify, run: node index.mjs submit ${chainName}`);
        break;

      case 'submit':
        // Submission phase
        logger.info('Starting submission to Sourcify...');
        await sourcifyApi.processAndSubmitContracts(
          chainConfig.chain_name.split('_')[0],
          chainConfig.chain_name.split('_')[1],
          chainConfig,
          folderOption
        );
        logger.info('Submission completed');
        break;
    }

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
