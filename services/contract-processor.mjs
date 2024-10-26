import fs from "node:fs/promises";
import path from "node:path";
import { logger } from '../utils/logger.mjs';

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
            failed: 0
        };

        this.missingContracts = [];
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
        // Check for Solidity pragma
        const pragmaMatch = source.match(/pragma\s+solidity\s+(\d+(?:\.\d+)*)/);
        if (!pragmaMatch) {
            logger.warn(`No Solidity pragma found in contract source`);
            return false;
        }

        // Check for contract keyword
        const contractMatch = source.match(/\bcontract\b/i);
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

        } catch (error) {
            logger.error("Error in processing chain:", error);
            throw error;
        }
    }
}