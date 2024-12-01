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

  getMissingContractsFilePath(chain, network) {
    return path.join(process.cwd(), 'chains', chain, network, 'missing_contracts.json')
  }

  //reading and processing the missing contracts file
  async readMissingContracts(chains, network) {
    const missingContractsFilePath = this.getMissingContractsFilePath(chains, network);
    try {
      const fileContent = await fs.readFile(missingContractsFilePath, 'utf-8');
      const missingContracts = JSON.parse(fileContent);
      logger.info(`Loaded ${missingContracts.length} missing contracts from ${missingContractsFilePath}`);
      return missingContracts;
    } catch (error) {
      logger.error(`Failed to read missing contracts from ${missingContractsFilePath}: ${error.message}`);
      throw error;
    }
  }

  async processMissingContracts(chain, network) {
    try {
      const missingContracts = await this.readMissingContracts(chain, network);

      if (missingContracts.length === 0) {
        logger.info("No missing contracts to process.");
        return [];
      }

      for (const contract of missingContracts) {
        const { address, contractName, filePath, fileName } = contract;

        //validating required fields
        if (!address || !contractName || !filePath || !fileName) {
          throw new Error('missing required contract fields');
        }

        const config = new config();

        console.log(`Processing contract: ${fileName}`);

        // Reading the source code from the file
        const fullPath = path.join(baseDirectory, fileName);
        console.log("Reading contract source from:", filePath);

        const sourceCode = await fs.readFile(fullPath, 'utf-8');

        // Get chain-specific EVM version
        const evmVersionMap = {
          1: 'london',    // Ethereum Mainnet
          137: 'paris',   // Polygon
          56: 'london',   // BSC
        };

        const evmVersion = evmVersionMap[this.chainId] || 'london';

        // Create input for solc
        const input = {
          language: 'Solidity',
          sources: {
            [contract.filePath]: {
              content: contract.sourceCode,
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
              [contract.fileName]: contract.contractName,
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
        sourceCode = contract.source;
        if (!source.includes('SPDX-License-Identifier')) {
          source = '// SPDX-License-Identifier: UNLICENSED\n' + source;
        }
        // Format and validate using solc
        const output = JSON.parse(solc.compile(JSON.stringify(input)));

        // Extract contract details
        const contractKey = Object.keys(output.contract[fileName])[0];
        const contract = output.contract[fileName][contractKey];

        // Check for errors
        if (output.errors) {
          const errors = output.errors.filter(error => error.severity === 'error');
          if (errors.length > 0) {
            logger.error(`Compilation errors in ${fileName}: `, errors);
            throw new Error('Contract compilation failed');
          }
        }

        //adding processed contracts to the results array
        processedContracts.push({
          address: contract.address.toLowerCase(),
          contractname: contract.contractName,
          filename: contract.fileName,
          source: sourceCode,
          compilerVersion: await this.extractCompilerVersion(sourceCode)
        });
      }
      return this.processMissingContracts;
    } catch (error) {
      logger.error(`Failed to process contract  ${error.message}`);
      throw error;
    }
  }


  async extractCompilerVersion(sourceCode) {
    const versionRegex = /pragma solidity (\^?\d+\.\d+\.\d+)/;
    const match = sourceCode.match(versionRegex);
    return match ? match[1].replace('^', '') : null;
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


  async saveProcessedcontracts(processMissingContracts, chain, network) {
    const outputPath = path.join(process.cwd(), 'chains', chain, network, 'formatted_contracts.json');
    try {
      await fs.writeFile(outputPath, JSON.stringify(processMissingContracts, null, 2));
      logger.info(`{rpcessed contracts saved to ${outputPath}`);
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
