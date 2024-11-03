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
    }

    async processContract(contractData) {
        // Validate required fields
        if (!contractData.address || !contractData.contractName || !contractData.source) {
            throw new Error('Missing required contract fields');
        }

        // Format filename consistently
        const filename = `${contractData.address.toLowerCase()}_${contractData.contractName}.sol`;

        // Ensure source code has SPDX identifier
        let source = contractData.source;
        if (!source.includes('SPDX-License-Identifier')) {
            source = '// SPDX-License-Identifier: UNLICENSED\n' + source;
        }

        try {
            // Create input for solc
            const input = {
                language: 'Solidity',
                sources: {
                    [filename]: {
                        content: source
                    }
                },
                settings: {
                    outputSelection: {
                        '*': {
                            '*': ['*']
                        }
                    }
                }
            };

            // Format and validate using solc
            const output = JSON.parse(solc.compile(JSON.stringify(input)));

            // Check for errors
            if (output.errors) {
                const errors = output.errors.filter(error => error.severity === 'error');
                if (errors.length > 0) {
                    logger.error(`Compilation errors in ${filename}:`, errors);
                    throw new Error('Contract compilation failed');
                }
            }

            return {
                address: contractData.address.toLowerCase(),
                contractName: contractData.contractName,
                filename: filename,
                source: source,
                compilerVersion: await this.extractCompilerVersion(source)
            };
        } catch (error) {
            logger.error(`Failed to process contract ${filename}: ${error.message}`);
            throw error;
        }
    }

    async extractCompilerVersion(sourceCode) {
        const versionRegex = /pragma solidity (\^?\d+\.\d+\.\d+)/;
        const match = sourceCode.match(versionRegex);
        return match ? match[1].replace('^', '') : null;
    }

    validateContract(contractData) {
        const required = ['address', 'source', 'compilerVersion'];
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
            logger.warn(`No Solidity-specific keywords found in source`);
            return false;
        }

        // If we've passed all checks, it's likely a valid Solidity contract
        return true;
    }


    async processContractsInBatches(contracts, batchSize = 10) {
        for (let i = 0; i < contracts.length; i += batchSize) {
            const batch = contracts.slice(i, i + batchSize);
            try {
                await Promise.all(batch.map(async (contract) => {
                    try {
                        // Validate contract
                        const isValid = this.isValidContract(contract);
                        if (!isValid) {
                            logger.warn(`Invalid contract found: ${contract.address}`);
                            logger.debug(`Contract validation error: ${contract.address}`);
                            logger.debug(`Contract source code: ${contract.source}`);
                            console.log(`Invalid contract: ${contract.address}`);
                            console.log(`Contract source code: ${contract.source}`);
                        } else {
                            // Transform contract into Sourcify's required format
                            const transformedContract = this.transformContract(contract);
                            console.log(`Transformed contract: ${transformedContract}`);

                            // Submit contract to Sourcify
                            const response = await this.sourcifyApi.submitContract(contract.address, transformedContract);

                            // Handle response
                            if (response.success) {
                                this.progress.successful++;
                            } else {
                                this.progress.failed++;
                                logger.error(`Failed to submit contract ${contract.address}: ${response.error}`);
                            }
                        }
                    } catch (error) {
                        logger.error(`Error processing contract ${contract.address}: ${error}`);
                        this.progress.failed++;
                    }
                }));
                console.log(`Processed ${i + batchSize} contracts`);
                await new Promise(resolve => setTimeout(resolve, 10000)); // Pause for 10 seconds
            } catch (error) {
                logger.error(`Error processing batch: ${error}`);
            }
        }
    }


    async submitContract(contract) {
        try {
            const compilerVersion = await this.extractCompilerVersion(contract.source);
            const contractData = {
                address: `0x${contract.address}`,
                contractName: path.basename(contract.path || ''),
                source: contract.source,
                compiler: "solidity",
                compilerVersion: compilerVersion || "0.8.10",
                network: "mainnet"
            };

            return await this.sourcifyApi.submitContract(contractData.address, contractData);
        } catch (error) {
            logger.error(`Error submitting contract ${contract.address}:`, error);
            throw error;
        }
    }

    async processContractFolder(folderPath, cache) {
        const contractFiles = await fs.readdir(folderPath);

        logger.debug(`Processing folder: ${folderPath}`);
        logger.debug(`Total contracts: ${this.progress.total}`);

        await Promise.all(
            contractFiles
                .filter(file => file.endsWith(".sol"))
                .map(async (contractFile) => {
                    const contractPath = path.join(folderPath, contractFile);
                    try {
                        const contractContent = await fs.readFile(contractPath, "utf8");
                        const contractAddress = contractFile.replace(".sol", "").toLowerCase();

                        this.progress.total++;

                        const isValid = this.isValidContract(contractContent);
                        if (!this.isValidContract(contractContent)) {
                            logger.warn(`Invalid contract found: ${contractAddress}`);
                            logger.debug(`Contract validation error: ${contractAddress}`);
                            logger.debug(`Contract source code: ${contractContent.substring(0, 200)}...`);
                            return;
                        }

                        if (cache[contractAddress]) {
                            logger.info(`Skipping cached contract: ${contractAddress}`);
                            return;
                        }

                        const existsInSourcify = await this.sourcifyApi.checkContract(contractAddress);

                        if (!existsInSourcify) {
                            this.missingContracts.push({
                                address: contractAddress,
                                source: contractContent,
                                path: contractPath
                            });

                            cache[contractAddress] = {
                                processed: false,
                                timestamp: new Date().toISOString()
                            };
                        }

                        this.progress.processed++;
                        logger.debug(`Processed contracts: ${this.progress.processed}`);
                        logger.debug(`Failed contracts: ${this.progress.failed}`);
                    } catch (error) {
                        logger.error(`Error processing contract ${contractFile}:`, error);
                    }
                })
        );

        // Add progress reporting
        const progress = {
            processed: this.progress.processed,
            total: this.progress.total,
            successful: this.progress.successful,
            failed: this.progress.failed,
            percentage: ((this.progress.processed / this.progress.total) * 100).toFixed(2)
        };

        logger.info('Progress:', progress);
    }

    async processingChain(specificFolder = null) {
        try {
            const repoPath = this.config.ethereumRepo || path.join(process.cwd(), "..", "..", "smart-contract-sanctuary-ethereum", "contracts", "mainnet");
            const cache = await this.cacheManager.load();

            logger.info("Starting contract processing from:", repoPath);

            if (specificFolder) {
                const folderPath = path.join(repoPath, specificFolder);

                try {
                    const stat = await fs.stat(folderPath);
                    if (stat.isDirectory()) {
                        logger.info(`processing specific folder: ${specificFolder}`);
                        await this.processContractFolder(folderPath, cache);
                        await this.cacheManager.save(cache);
                    } else {
                        throw new Error(`${specificFolder} is not a valid folder path`);
                    }
                } catch (error) {
                    logger.error(`Error processing folder ${specificFolder}:`, error);
                    throw error;
                }
            }

            const contractFolders = await fs.readdir(repoPath);

            // Process folders in batches
            for (let i = 0; i < contractFolders.length; i += this.config.batchSize) {
                const batch = contractFolders.slice(i, i + this.config.batchSize);

                await Promise.all(batch.map(async (folder) => {
                    const folderPath = path.join(repoPath, folder);
                    const stat = await fs.stat(folderPath);

                    if (stat.isDirectory()) {
                        await this.processContractFolder(folderPath, cache);
                    }
                }));

                // Save cache periodically
                await this.cacheManager.save(cache);

                logger.info(`Progress: ${this.progress.processed}/${this.progress.total} contracts processed`);

                // Pause between folder batches
                await new Promise(resolve => setTimeout(resolve, 5000));
            }

            // Process missing contracts
            if (this.missingContracts.length > 0) {
                logger.info(`Processing ${this.missingContracts.length} missing contracts`);
                await this.processContractsInBatches(this.missingContracts);
            }

            // Add checkpoint saving
            await this.saveCheckpoint({
                lastProcessedFolder: folder,
                progress: this.progress
            });

        } catch (error) {
            logger.error("Error in processing chain:", error);
            // Save current state before throwing
            await this.saveErrorState(error);
            throw error;
        }
    }

    async transformContract(contract) {
        return {
            address: contract.address,
            chainId: this.config.chainId,
            files: {
                'source.sol': contract.source
            },
            compilerVersion: await this.extractCompilerVersion(contract.source)
        };
    }

    validateContractSource(source) {
        if (!source.includes('pragma solidity')) {
            return false;
        }

        // Add more validation as needed
        return true;
    }

    async processFromFile(filePath) {
        try {
            const data = await fs.readFile(filePath, 'utf8');
            const contracts = JSON.parse(data);

            logger.info(`Processing ${contracts.length} contracts from file`);

            // Validate contract format before processing
            const validContracts = contracts.filter(contract => {
                return contract &&
                    contract.address &&
                    contract.contractName &&
                    contract.source &&
                    typeof contract.source === 'string';
            });

            if (validContracts.length !== contracts.length) {
                logger.warn(`Found ${contracts.length - validContracts.length} invalid contracts`);
            }

            // Process each valid contract
            for (const contract of validContracts) {
                try {
                    // Extract pragma version from source
                    const version = this.extractPragmaVersion(contract);
                    if (!version) {
                        logger.warn(`Could not extract pragma version for ${contract.address}`);
                        continue;
                    }

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

    async prepareContractData(contract) {
        // Extract compiler version
        const compilerVersion = await this.extractCompilerVersion(contract.source);
        if (!compilerVersion) {
            throw new Error(`Could not extract compiler version for ${contract.address}`);
        }

        // Generate metadata
        const metadata = {
            language: 'Solidity',
            compiler: {
                version: compilerVersion
            },
            sources: {
                [contract.filename]: {
                    content: contract.source
                }
            },
            settings: {
                optimizer: {
                    enabled: true,
                    runs: 200
                }
            }
        };

        return {
            address: contract.address,
            filename: contract.filename,
            source: contract.source,
            compilerVersion,
            metadata
        };
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
}
