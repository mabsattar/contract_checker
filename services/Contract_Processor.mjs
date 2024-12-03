import fs from "node:fs/promises";
import path from "node:path";
import { logger } from '../utils/logger.mjs';
import solc from 'solc';


logger.info("Starting contract verification process");

export class ContractProcessor {
  constructor(sourcifyApi, cacheManager, config) {
    this.sourcifyApi = sourcifyApi;
    this.cacheManager = cacheManager;
    this.config = config;
    this.progress = {
      total: 0,
      processed: 0,
      successful: 0,
      failed: 0,
      matchingContracts: []
    };

    this.missingContracts = [];

    this.processedContracts = [];
  }

  getMissingContractsFilePath(chain, network, folder) {
    const basePath = path.join(process.cwd(), 'chains', chain, network);
    return folder
      ? path.join(basePath, `missing_contracts_${folder}.json`)
      : path.join(basePath, 'missing_contracts.json');
  }

  getFormattedContractsFilePath(chain, network, folder) {
    const basePath = path.join(process.cwd(), 'chains', chain, network);
    return folder
      ? path.join(basePath, `formatted_contracts_${folder}.json`)
      : path.join(basePath, 'formatted_contracts.json');
  }

  //reading and processing the missing contracts file
  async readMissingContracts(chains, network) {
    try {
      const missingContractsFilePath = this.getMissingContractsFilePath(chains, network);
      const fileContent = await fs.readFile(missingContractsFilePath, 'utf-8');
      const missingContracts = JSON.parse(fileContent);
      logger.info(`Loaded ${missingContracts.length} missing contracts from ${missingContractsFilePath}`);
      return missingContracts;
    } catch (error) {
      logger.error(`Failed to read missing contracts from ${missingContractsFilePath}: ${error.message}`);
      throw error;
    }
  }

  async processMissingContracts(chain, network, folder = null) {
    try {
      const missingContracts = await this.readMissingContracts(chain, network, folder);
      const processedContracts = []; // Initialize array to store processed contracts

      if (missingContracts.length === 0) {
        logger.info("No missing contracts to process.");
        return [];
      }

      for (const contractData of missingContracts) {
        const { address, contractName, filePath, fileName } = contractData;

        // Validating required fields
        if (!address || !contractName || !filePath || !fileName) {
          logger.warn(`Skipping contract with missing required fields: ${address}`);
          continue;
        }

        logger.info(`Processing contract: ${fileName}`);
        
        try {
          logger.info("Reading contract source from:", filePath);
          const sourceCode = await fs.readFile(filePath, 'utf-8');

          // Extract compiler version
          const compilerVersion = await this.extractCompilerVersion(sourceCode);
          if (!compilerVersion) {
            logger.warn(`No compiler version found in source, using default`);
            continue;
          }

          const evmVersionMap = {
            1: 'london',
            137: 'paris',
            56: 'london',
          };

          const chainId = parseInt(chain) || 1;
          const evmVersion = evmVersionMap[chainId] || 'london';

          // Ensure source code has SPDX identifier
          const processedSource = !sourceCode.includes('SPDX-License-Identifier') 
            ? '// SPDX-License-Identifier: UNLICENSED\n' + sourceCode
            : sourceCode;

          // Create solc input
          const solcInput = {
            language: 'Solidity',
            sources: {
              [fileName]: {
                content: processedSource
              }
            },
            settings: {
              optimizer: {
                enabled: true,
                runs: 200
              },
              evmVersion: evmVersion,
              outputSelection: {
                '*': {
                  '*': ['abi', 'evm.bytecode', 'evm.deployedBytecode', 'metadata']
                }
              }
            }
          };

          // Load specific compiler version
          const solcSnapshot = await new Promise((resolve, reject) => {
            solc.loadRemoteVersion(compilerVersion, (err, solcSnapshot) => {
              if (err) {
                reject(err);
              } else {
                resolve(solcSnapshot);
              }
            });
          });

          // Compile the contract
          const compiledOutput = JSON.parse(solcSnapshot.compile(JSON.stringify(solcInput)));

          if (compiledOutput.errors) {
            const errors = compiledOutput.errors.filter(error => error.severity === 'error');
            if (errors.length > 0) {
              logger.error(`Compilation errors for ${fileName}:`, errors);
              continue;
            }
          }

          // Get the contract metadata
          const contractMetadata = compiledOutput.contracts[fileName][contractName];
          if (!contractMetadata) {
            logger.error(`No metadata found for ${contractName} in ${fileName}`);
            continue;
          }

          // Format for Sourcify
          const processedContract = {
            address: address.toLowerCase(),
            chainId: chainId.toString(),
            contractName: contractName,
            compilerVersion: compilerVersion,
            optimization: true,
            optimizationRuns: 200,
            evmVersion: evmVersion,
            fileName: fileName,
            source: processedSource,
            metadata: JSON.parse(contractMetadata.metadata),
            libraries: {},
            constructorArguments: '',
          };

          processedContracts.push(processedContract);
          logger.info(`Successfully processed contract: ${fileName}`);
       
        } catch (error) {
          logger.error(`Failed to process contract ${fileName}: ${error.message}`);
          continue;
        }
      }
    
      logger.info(`Successfully processed ${processedContracts.length} contracts`);
      return processedContracts;
     
    } catch (error) {
      logger.error(`Failed to process contracts: ${error.message}`);
      throw error;
    }
  }

  // Helper method to extract compiler version
  async extractCompilerVersion(sourceCode) {
    try {
      const versionRegex = /pragma solidity (\^?\d+\.\d+\.\d+)/;
      const match = sourceCode.match(versionRegex);
      if (match) {
        // Remove the ^ if present and ensure it's a complete version number
        const version = match[1].replace('^', '');
        return version;
      }
      logger.warn('No compiler version found in source, using default');
      return '^0.8.10';
    } catch (error) {
      logger.error(`Error extracting compiler version: ${error.message}`);
      return '^0.8.10';
    }
  }

  validateContract(contract) {
    const required = ['address', 'sourceCode', 'compilerVersion', 'filePath', 'fileName'];
    for (const field of required) {
      if (!contract[field]) {
        throw new Error(`Missing required field: ${field}`);
      }
    }
  }

  isValidContract(sourceCode) {
    const lowerCaseSource = sourceCode.toLowerCase();
    // Check for Solidity pragma
    const pragmaMatch = lowerCaseSource.match(/pragma\s+solidity\s+(\d+(?:\.\d+)*)/);
    if (!pragmaMatch) {
      logger.warn(`No Solidity pragma found in contract source`);
      return false;
    }

    // Check for contract keyword
    const contractMatch = lowerCaseSource.match(/\bcontract\b/i);
    if (!contractMatch) {
      logger.warn(`No contract keyword found in source`);
      return false;
    }

    // Check for Solidity-specific keywords
    const solidityKeywords = ['function', 'event', 'mapping', 'struct'];
    if (!solidityKeywords.some(keyword => source.includes(keyword))) {
      logger.warn(`No Solidity - specific keywords found in source`);
      return false;
    }

    // If we've passed all checks, it's likely a valid Solidity contract
    return true;
  }


  async processFromFile(filePath) {
    try {
      const data = await fs.readFile(filePath, 'utf8');
      const contracts = JSON.parse(data);

      logger.info(`Processing ${contracts.length} contracts from file`);

      // Validate contract format
      const validContracts = contracts.filter(contract => {
        return contract &&
          contract.address &&
          contract.sourceCode &&
          typeof contract.sourceCode === 'string';
      });

      if (validContracts.length !== contracts.length) {
        logger.warn(`Found ${contracts.length - validContracts.length} invalid contracts`);
      }

      // Process each valid contract
      for (const contract of validContracts) {
        try {
          // Transform contract data for submission
          const contractData = await this.transformContract(contract);

          // Submit to Sourcify
          const success = await this.submitContract(contractData);

          if (success) {
            this.progress.successful++;
            await this.cacheManager.markVerified(contract.address);
          } else {
            this.progress.failed++;
            logger.warn(`Failed to verify contract ${contract.address}`);
          }

        } catch (err) {
          logger.error(`Error processing contract ${contract.address}: ${err.message}`);
          this.progress.failed++;
        }
      }

      // Update total processed count
      this.progress.processed += validContracts.length;

    } catch (err) {
      logger.error(`Error reading/parsing contracts file: ${err.message}`);
      throw err;
    }
  }

  async transformContract(contract) {
    if (!contract || !contract.address || !contract.sourceCode) {
      logger.warn(`Invalid contract data for transformation: ${contract?.address}`);
      throw new Error('Invalid contract data');
    }

    // Ensure address is properly formatted
    const address = contract.address.toLowerCase();
    const formattedAddress = address.startsWith('0x') ? address : `0x${address}`;

    return {
      address: formattedAddress,
      contractName: contract.contractName || path.basename(contract.path || ''),
      filename: `${formattedAddress}.sol`,
      source: contract.sourceCode,
      compiler: "solidity",
      compilerVersion: await this.extractCompilerVersion(contract.sourceCode) || "^0.8.10",
      network: "chainName"
    };
  }

  async saveProcessedContracts(processMissingContracts, chain, network, folder = null) {
    const outputPath = this.getFormattedContractsFilePath(chain, network, folder);
    try {
      await fs.writeFile(outputPath, JSON.stringify(processedContracts, null, 2));
      logger.info(`Processed contracts saved to ${outputPath}`);
    } catch (error) {
      logger.error(`Error saving processec contracts: ${error.message}`);
    }
  }

  async saveProgress() {
    try {
      // Split chain name into network parts (e.g. "ethereum_mainnet" -> ["ethereum", "mainnet"])
      const [chain, network] = this.config.chain_name.split('_');

      // Construct proper path following chains/{chain}/{network} structure
      const outputDir = path.join(process.cwd(), 'chains', chain, network);
      await fs.mkdir(outputDir, { recursive: true });

      // Save progress stats
      const statsPath = path.join(outputDir, 'processing_stats.json');
      await fs.writeFile(statsPath, JSON.stringify(this.progress, null, 2));

      logger.debug('Progress saved successfully');
    } catch (error) {
      logger.error('Error saving progress:', error);
    }
  }


  async saveVerificationProgress() {
    const progressPath = path.join(this.chainOutputDir, 'verification_progress.json');
    try {
      const progressData = {
        progress: {
          currentFolder: this.currentFolder,
          processedFolders: this.processedFolders,
          totalFolders: this.totalFolders,
          currentBatch: this.currentBatch,
          stats: this.progress,
          timing: {
            startTime: this.startTime,
            lastUpdateTime: new Date().toISOString(),
            estimatedTimeRemaining: this.calculateTimeRemaining()
          }
        },
        sourcifyStats: this.sourcifyApi.getStats(),
        lastUpdate: new Date().toISOString()
      };

      await fs.writeFile(progressPath, JSON.stringify(progressData, null, 2));
      logger.debug('Verification progress saved successfully');
    } catch (error) {
      logger.error('Error saving verification progress:', error);
    }
  }
}
