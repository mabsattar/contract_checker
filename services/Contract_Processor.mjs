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

  async processContract(contractData, chain, network) {
    // Validate required fields
    if (!contractData.address || !contractData.contractName || !contractData.filePath || !contractData.fileName) {
      throw new Error('Missing required contract fields');
    }

    try {
      const missingContracts = await this.readMissingContracts(chain, network);

      //collecting processed contract results here
      const processedContracts = [];

      for (const contract of missingContracts) {
        const { address, contractName, filePath, fileName } = contract;

        const config = new config();
        const chainConfig = await this.config.load(chainName);

        const missingContractsFile = path.join(chainConfig.repo_path, "missing_contracts.json");
        const outputDir = path.join(chainConfig.repo_path, "output");

        console.log(`Processing contract: ${fileName}`);

        // Reading the source code from the file
        const fullPath = path.join(baseDirectory, fileName);
        console.log("Reading contract source from:", filePath);

        const sourceCode = await fs.readFile(filePath, 'utf-8');

        // Extract pragma solidity version
        const pragmaMatch = sourceCode.match(/pragma solidity (\^?\d+\.\d+\.\d+|[\^\~]\d+\.\d+)/);
        const compilerVersion = pragmaMatch ? pragmaMatch[1] : '0.8.17';

        // Extract SPDX license
        const licenseMatch = contractData.source.match(/SPDX-License-Identifier: (.*)/);
        const license = licenseMatch ? licenseMatch[1].trim() : 'UNLICENSED';

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
            [contractData.filePath]: {
              content: contractData.sourceCode,
              keccak256: `0x${Buffer.from(keccak256(utf8ToBytes(contract.source))).toString('hex')}`,
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
        const contractKey = Object.keys(output.contracts[fileName])[0];
        const contract = output.contracts[fileName][contractKey];

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
          address: contractData.address.toLowerCase(),
          contractName: contractData.contractName,
          filename: fileName,
          source: sourceCode,
          compilerVersion: await this.extractCompilerVersion(source)
        });
      }
      return processedContracts;
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

  validateContract(contractData) {
    const required = ['address', 'source', 'compilerVersion', 'filePath', 'fileName'];
    for (const field of required) {
      if (!contractData[field]) {
        throw new Error(`Missing required field: ${field}`);
      }
    }
  }

  isValidContract(source) {
    const lowerCaseSource = source.toLowerCase();
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


  async saveProcessedcontract(processedContracts, chain, network){
    const outputPath = path.join(process.cwd(), 'chains', chain, network, 'formatted_contracts.json');
    try {
      await fs.writeFile(outputPath, JSON.stringify(processedContracts, null, 2));
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

  extractCompilerVersion(source) {
    if (!source) {
      logger.warn('No source code provided for compiler version extraction');
      return null;
    }

    try {
      // Look for pragma solidity statement in source
      const pragmaRegex = /pragma solidity (?:\^|>=|~)?(0\.[0-9]+\.[0-9]+)/;
      const pragmaMatch = source.match(pragmaRegex);

      if (pragmaMatch) {
        return pragmaMatch[1];
      }

      logger.warn('No pragma version found in source code');
      return null;
    } catch (error) {
      logger.error('Error extracting compiler version:', error);
      return null;
    }
  }

  extractPragmaVersion(contract) {
    if (!contract || !contract.source) {
      logger.warn(`Invalid contract data for address ${contract?.address}`);
      return null;
    }

    try {
      return this.extractCompilerVersion(contract.source) || "0.8.10";
    } catch (error) {
      logger.error(`Error extracting pragma version for ${contract?.address}: ${error.message}`);
      return "0.8.10"; // Default fallback
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
