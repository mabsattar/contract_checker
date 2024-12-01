import fs from "node:fs/promises";
import path from "node:path";
import { logger } from '../utils/logger.mjs';
import solc from 'solc';
import { keccak256 } from 'ethereum-cryptography/keccak';
import { utf8ToBytes } from 'ethereum-cryptography/utils';


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
          // Reading the source code from the file
          logger.info("Reading contract source from:", filePath);
          const sourceCode = await fs.readFile(filePath, 'utf-8');

          // Get chain-specific EVM version
          const evmVersionMap = {
            1: 'london',    // Ethereum Mainnet
            137: 'paris',   // Polygon
            56: 'london',   // BSC
          };

        const chainId = parseInt(chain) || 1; // Default to mainnet if chain parsing fails
        const evmVersion = evmVersionMap[chainId] || 'london';
        // Create input for solc
        const input = {
          language: 'Solidity',
          sources: {
            [filePath]: {
              content: sourceCode,
              keccak256: `0x${Buffer.from(keccak256(utf8ToBytes(contract.sourceCode))).toString('hex')}`,
              license: license
            }
          },
          version: 1,
          settings: {
            optimizer: {
              enable: true,
              runs: 200
            },
            outputSelection: {
              '*': {
                '*': ['abi', 'evm.bytecode', 'evm.deployedBytecode', 'metadata']
              }
            },
            output: {
              abi: [], // Empty ABI since we don't have it
              devdoc: {
                kind: "dev",
                methods: {},
                version: 1
              },
              userdoc: {
                kind: "user",
                methods: {},
                version: 1
              }
            },

            compilationTarget: {
              [fileName]: contractName,
            },
          },
          compiler: {
            version: compilerSettings.compilerVersion,
          },
          evmVersion: evmVersion,
          libraries: {},
          metadata: {
            bytecodeHash: "ipfs",
            useLiteralContent: true
          },
          optimizer: {
            enabled: true,
            runs: 200
          },
          remappings: []
        }

          // Ensure source code has SPDX identifier
          if (!sourceCode.includes('SPDX-License-Identifier')) {
            sourceCode = '// SPDX-License-Identifier: UNLICENSED\n' + sourceCode;
          }

          // Format the processed contract
          const processedContract = {
            address: address.toLowerCase(),
            contractName: contractName,
            fileName: fileName,
            source: sourceCode,
            compilerVersion: await this.extractCompilerVersion(sourceCode),
            optimization: true,
            optimizationRuns: 200,
            evmVersion: evmVersion
          };

          // Add to processed contracts array
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

  async extractCompilerVersion(sourceCode) {
    try {
      const versionRegex = /pragma solidity (\^?\d+\.\d+\.\d+)/;
      const match = sourceCode.match(versionRegex);
      if (match) {
        return match[1].replace('^', '');
      }
      // Default version if not found
      logger.warn('No compiler version found in source, using default');
      return '0.8.10';
    } catch (error) {
      logger.error(`Error extracting compiler version: ${error.message}`);
      return '0.8.10'; // Default fallback version
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
      compilerVersion: await this.extractCompilerVersion(contract.sourceCode) || "0.8.10",
      network: "chainName"
    };
  }

  async saveProcessedContracts(processedContracts, chain, network, folder = null) {
    const outputPath = this.getFormattedContractsFilePath(chain, network, folder);
    try {
      await fs.writeFile(outputPath, JSON.stringify(processedContracts, null, 2));
      logger.info(`Processed contracts saved to ${outputPath}`);
    } catch (error) {
      logger.error(`Error saving processed contracts: ${error.message}`);
      throw error;
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
