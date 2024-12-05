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
    this.compilerCache = new Map();

    this.progress = {
      total: 0,
      processed: 0,
      successful: 0,
      failed: 0,
      matchingContracts: [],
      startTime: new Date().toISOString(),
      lastUpdateTime: null
    };

    this.processedContracts = [];

    this.defaultSettings = {
      evmVersionMap: {
        1: 'london', // Ethereym
        137: 'paris', // Polygon
        56: 'london', // BSC
        42161: 'paris', // Arbitrum
        10: 'paris'     // Optimism
      },
      optimizer: {
        enabled: true,
        runs: 200
      }
    };
  }

  async loadCompiler(version) {
    if (this.compilerCache.has(version)) {
      return this.compilerCache.get(version);
    }

    try {
      const compiler = await new Promise((resolve, reject) => {
        solc.loadRemoteVersion(version, (err, solcSnapshot) => {
          if (err) reject(err);
          else resolve(solcSnapshot);
        });
      });

      this.compilerCache.set(version, compiler);
      return compiler;
    } catch (error) {
      logger.error(`Error loading compiler version ${version}: ${error.message}`);
      throw error;
    }
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

  async processMissingContracts(chain, network, folder = null, batchSize=50) {
    try {
      const missingContracts = await this.readMissingContracts(chain, network, folder);
      this.processedContracts = []; // Initialize array to store processed contracts
      this.progress.total = missingContracts.length;

      for (let i = 0; i < missingContracts.length; i+= batchSize) {
        const batch = missingContracts.slice(i, i + batchSize);
        const batchResults = await Promise.allSettled(
          batch.map(contract => this.processContract(contract, chain))
        );

        batchResults.forEach((result, index) => {
          const contract = batch[index];
          if (result.status === 'fulfilled' && result.value) {
            processedContracts.push(result.value);
            this.progress.successful++;
          } else {
            logger.error(`Failed to process ${contract.address}: ${result.reason}`);
            this.progress.failed++;
          }
          this.progress.processed++
        });

        //saving progress afrter each batch
        await this.saveProgress();

        //adding an optional delay between batches
        if (i + batchSize < missingContracts.length) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }

      logger.info(`Saving processed contracts: ${JSON.stringify(processedContracts, null, 2)}`);
      await this.saveProcessedContracts(processedContracts, chain, network, folder);
      return processedContracts;

    } catch (error) {
      logger.error(`Failed to process contracts: ${error.message}`);
      throw error;
    }
  }
   
  async processContract(contractData, chain) {

    const {address, contractName, filePath, fileName} = contractData;

    try {
      if (!this.validateContractData(contractData)) {
        throw new Error("Invalid contract data");        
      };

      const sourceCode = await fs.readFile(filePath, 'utf-8');
      if (!this.isValidContract(sourceCode)) {
        throw new Error(`Invalid Solidity contract`);        
      }

      // Extract compiler version
      const compilerVersion = await this.extractCompilerVersion(sourceCode);
      const compiler = await this.loadCompiler(compilerVersion);
      
      const chainId = parseInt(chain);
      const evmVersion = this.defaultSettings.evmVersionMap[chainId] || 'london'; 

      const processedSource = this.ensureSPDXLicense(sourceCode);
      const compilationResult = await this.compileContract(compiler, {
        fileName,
        contractName,
        source: processedSource,
        evmVersion
      });

      return {
        address: address.toLowerCase(),
        chainId: chainId.toString(),
        contractName,
        compilerVersion,
        optimization: this.defaultSettings.optimizer.enabled,
        optimizationRuns: this.defaultSettings.optimizer.runs,
        evmVersion,
        fileName,
        source: processedSource,
        metadata: compilationResult.metadata,
        libraries: compilationResult.libraries || {},
        constructorArguments: '',
      };

    } catch (error) {
      logger.error(`Error processing ${address}: ${error.message}`);
      throw error;
    }
  }

  async compileContract(compiler, {fileName, contractName, source, evmVersion }) {
    const input = {
      language: 'Solidity',
      sources: {
        [fileName]: {content: source}
      },
      settings: {
        optimizer: this.defaultSettings.optimizer,
        evmVersion,
        outputSelection: {
          '*' : {
            '*': ['abi', 'evm.bytecode', 'evm.deployedBytecode', 'metadata']
          }
        }
      }
    };  

    const output = JSON.parse(compiler.compile(JSON.stringify(input)));

    if(output.errors) {
      const errors = output.errors.filter(e => e.severity === 'error');
      if (errors.length > 0) {
        throw new Error (`Contract ${contractName} not found in compilation output`);
      }
    }

    const contract = output.contracts[fileName][contractName];
    if (!contract) {
      throw new Error(`Contract ${contractName} not found in compilation output`);
      
    }

      return {
        metadata: JSON.parse(contract.metadata),
        libraries: this.extractLibraries(contract),
      };
    }

    ensureSPDXLicense(source) {
      if (!source.includes('SPDX-License-Identifier')) {
        return '//SPDX-License-Identifier: UNLICENSED\n' + source;
      }
      
      return source;
    }

    validateContractData(contract) {
      const required = ['address', 'contractName', 'filePath', 'fileName'];
      return required.every(field => !!contract[field]);
    }
  
    extractLibraries(contract) {
      const libraries = {};
      if (contract.evm?.bytecode?.linkReferences) {
        for (const [file, fileLibs] of Object.entries(contract.evm.bytecode.linkReferences)) {
          for (const libName of Object.keys(fileLibs)) {
            libraries[libName] = ''; // To be filled by deployment process
          }
        }
      }
      return libraries;
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
      return '^0.6.0';
    } catch (error) {
      logger.error(`Error extracting compiler version: ${error.message}`);
      return '^0.6.0';
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
    if (!solidityKeywords.some(keyword => lowerCaseSource.includes(keyword))) {
      logger.warn(`No Solidity - specific keywords found in source`);
      return false;
    }

    // If we've passed all checks, it's likely a valid Solidity contract
    return true;
  }

  async saveProcessedContracts(processedContracts, chain, network, folder = null) {
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


  // async saveVerificationProgress() {
  //   const progressPath = path.join(this.chainOutputDir, 'verification_progress.json');
  //   try {
  //     const progressData = {
  //       progress: {
  //         currentFolder: this.currentFolder,
  //         processedFolders: this.processedFolders,
  //         totalFolders: this.totalFolders,
  //         currentBatch: this.currentBatch,
  //         stats: this.progress,
  //         timing: {
  //           startTime: this.startTime,
  //           lastUpdateTime: new Date().toISOString(),
  //           estimatedTimeRemaining: this.calculateTimeRemaining()
  //         }
  //       },
  //       sourcifyStats: this.sourcifyApi.getStats(),
  //       lastUpdate: new Date().toISOString()
  //     };

  //     await fs.writeFile(progressPath, JSON.stringify(progressData, null, 2));
  //     logger.debug('Verification progress saved successfully');
  //   } catch (error) {
  //     logger.error('Error saving verification progress:', error);
  //   }
  // }
}
