import fs from "node:fs/promises";
import path from "node:path";
import { logger } from '../utils/logger.mjs';

export class ContractFinder {
    constructor(sourcifyApi, config) {
        this.sourcifyApi = sourcifyApi;
        this.config = config;
        this.missingContracts = [];
        this.contractAddresses = new Map(); // Will store address mapping
        this.stats = {
            total: 0,
            processed: 0,
            missing: 0,
            errors: 0,
            startTime: new Date().toISOString(),
            lastProcessed: null
        };
        // For auto-saving
        this.saveInterval = null;
    }

    async loadContractAddresses() {
        try {
            // Load the contracts.json file from mainnet directory
            const contractsPath = path.join(this.config.ethereumRepo, '../contracts.json');
            const contractsData = await fs.readFile(contractsPath, 'utf8');
            const contracts = JSON.parse(contractsData);

            // Create mapping of filename to actual address
            contracts.forEach(contract => {
                // Assuming contract has address and filename properties
                this.contractAddresses.set(contract.filename, contract.address);
            });

            logger.info(`Loaded ${this.contractAddresses.size} contract addresses`);
        } catch (error) {
            logger.error('Error loading contract addresses:', error);
            throw error;
        }
    }

    async findMissingContracts(specificFolder = null) {
        try {
            const repoPath = this.config.ethereumRepo;
            logger.info(`Starting contract search in: ${repoPath}`);

            // Start auto-save mechanism
            this.setupAutoSave();

            if (specificFolder) {
                await this.processSingleFolder(path.join(repoPath, specificFolder));
            } else {
                const folders = await fs.readdir(repoPath);
                // Sort folders for consistent processing
                for (const folder of folders.sort()) {
                    await this.processSingleFolder(path.join(repoPath, folder));
                }
            }

            // Save final results
            await this.saveMissingContracts();
            await this.saveStats();
            this.clearAutoSave();

            return {
                stats: this.stats,
                missingContractsFile: 'missing_contracts.json'
            };
        } catch (error) {
            logger.error('Error in findMissingContracts:', error);
            this.clearAutoSave();
            throw error;
        }
    }

    setupAutoSave() {
        // Auto-save every 5 minutes
        this.saveInterval = setInterval(async () => {
            try {
                await this.saveMissingContracts();
                await this.saveStats();
                logger.info('Auto-save completed');
            } catch (error) {
                logger.error('Error in auto-save:', error);
            }
        }, 5 * 60 * 1000);
    }

    clearAutoSave() {
        if (this.saveInterval) {
            clearInterval(this.saveInterval);
            this.saveInterval = null;
        }
    }

    async processSingleFolder(folderPath) {
        try {
            const files = await fs.readdir(folderPath);
            const solFiles = files.filter(f => f.endsWith('.sol'));

            this.stats.total += solFiles.length;
            logger.info(`Processing ${solFiles.length} contracts in ${folderPath}`);

            for (const file of solFiles) {
                try {
                    const contractPath = path.join(folderPath, file);
                    // Get the actual address from our mapping
                    const contractAddress = this.contractAddresses.get(file);

                    if (!contractAddress) {
                        logger.warn(`No address mapping found for file: ${file}`);
                        this.stats.errors++;
                        continue;
                    }

                    // Check if contract exists in Sourcify
                    const exists = await this.sourcifyApi.checkContract(contractAddress);

                    if (!exists) {
                        const source = await fs.readFile(contractPath, 'utf8');
                        this.missingContracts.push({
                            address: contractAddress,
                            path: contractPath,
                            source,
                            foundAt: new Date().toISOString()
                        });
                        this.stats.missing++;
                    }

                    this.stats.processed++;
                    this.stats.lastProcessed = contractAddress;
                } catch (error) {
                    logger.error(`Error processing file ${file}:`, error);
                    this.stats.errors++;
                }

                // Log progress every 100 contracts
                if (this.stats.processed % 100 === 0) {
                    this.logProgress();
                }
            }
        } catch (error) {
            logger.error(`Error processing folder ${folderPath}:`, error);
            throw error;
        }
    }

    // Validate Ethereum address format
    isValidEthereumAddress(address) {
        return /^0x[0-9a-f]{40}$/i.test(address);
    }

    // Basic validation of contract source
    isValidContractSource(source) {
        return source.includes('pragma solidity') &&
            source.includes('contract ') &&
            source.length > 0;
    }

    async saveMissingContracts() {
        const filePath = path.join(process.cwd(), 'missing_contracts.json');
        const backupPath = path.join(process.cwd(), 'missing_contracts.backup.json');

        try {
            // Create backup of existing file
            try {
                await fs.access(filePath);
                await fs.copyFile(filePath, backupPath);
            } catch (error) {
                // File doesn't exist, skip backup
            }

            await fs.writeFile(filePath, JSON.stringify(this.missingContracts, null, 2));
            logger.info(`Saved ${this.missingContracts.length} missing contracts to ${filePath}`);
        } catch (error) {
            logger.error('Error saving missing contracts:', error);
            throw error;
        }
    }

    async saveStats() {
        const filePath = path.join(process.cwd(), 'contract_stats.json');
        try {
            await fs.writeFile(filePath, JSON.stringify({
                ...this.stats,
                lastUpdate: new Date().toISOString()
            }, null, 2));
            logger.info('Stats saved to', filePath);
        } catch (error) {
            logger.error('Error saving stats:', error);
            throw error;
        }
    }

    logProgress() {
        const progress = {
            processed: this.stats.processed,
            total: this.stats.total,
            missing: this.stats.missing,
            errors: this.stats.errors,
            percentage: ((this.stats.processed / this.stats.total) * 100).toFixed(2),
            lastProcessed: this.stats.lastProcessed,
            runningTime: this.getRunningTime()
        };
        logger.info('Progress:', progress);
    }

    getRunningTime() {
        const startTime = new Date(this.stats.startTime);
        const now = new Date();
        const diff = now - startTime;
        const minutes = Math.floor(diff / 60000);
        const hours = Math.floor(minutes / 60);
        return `${hours}h ${minutes % 60}m`;
    }
}
