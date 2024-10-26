import fs from "node:fs/promises";
import path from "node:path";
import { logger } from '../utils/logger.mjs';

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
        return source.includes('contract') &&
            source.includes('pragma solidity') &&
            source.length > 100;
    }


    async processContractsInBatches(contracts, batchSize = 10) {
        for (let i = 0; i < contracts.length; i += batchSize) {
            const batch = contracts.slice(i, i + batchSize);

            const results = await Promise.allSettled(
                batch.map(contract => this.submitContract(contract))
            );

            // Update cache with results
            for (let j = 0; j < batch.length; j++) {
                const contract = batch[j];
                const result = results[j];

                const cache = await this.cacheManager.load();
                if (result.status === 'fulfilled' && result.value.success) {
                    cache[contract.address] = {
                        processed: true,
                        verificationTimestamp: new Date().toISOString()
                    };
                    this.progress.successful++;
                } else {
                    cache[contract.address] = {
                        processed: false,
                        error: result.reason || 'Verification failed',
                        timestamp: new Date().toISOString()
                    };
                    this.progress.failed++;
                }
                await this.cacheManager.save(cache);
            }

            this.progress.processed += batch.length;
            logger.info(`Progress: ${this.progress.processed}/${this.progress.total} contracts processed`);

            // Pause between batches
            await new Promise(resolve => setTimeout(resolve, 5000));
        }

        return {
            processed: this.progress.processed,
            successful: this.progress.successful,
            failed: this.progress.failed
        };
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

        await Promise.all(
            contractFiles
                .filter(file => file.endsWith(".sol"))
                .map(async (contractFile) => {
                    const contractPath = path.join(folderPath, contractFile);
                    const contractContent = await fs.readFile(contractPath, "utf8");
                    const contractAddress = contractFile.replace(".sol", "").toLowerCase();

                    this.progress.total++;

                    if (!this.isValidContract(contractContent)) {
                        logger.warn(`Invalid contract found: ${contractAddress}`);
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
                })
        );
    }

    async processingChain() {
        try {
            const repoPath = this.config.ethereumRepo || path.join(process.cwd(), "..", "..", "smart-contract-sanctuary-ethereum", "contracts", "mainnet");
            const cache = await this.cacheManager.load();

            logger.info("Starting contract processing from:", repoPath);

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