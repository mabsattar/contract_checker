import fs from "node:fs/promises";
import path from "node:path";
import { logger } from '../utils/logger.mjs';

export class ContractFinder {
    constructor(sourcifyApi, config) {
        this.sourcifyApi = sourcifyApi;
        this.config = config;
        this.missingContracts = [];
        this.contractAddresses = new Map();
        this.stats = this.initializeStats();
    }

    initializeStats() {
        return {
            total: 0,
            processed: 0,
            missing: 0,
            errors: 0,
            startTime: new Date().toISOString(),
            lastProcessed: null
        };
    }

    async loadContractAddresses() {
        try {
            // Path to contracts.json in mainnet directory
            const contractsPath = path.join(this.config.ethereumRepo, '../contracts.json');
            logger.info(`Loading contract addresses from: ${contractsPath}`);

            const contractsData = await fs.readFile(contractsPath, 'utf8');
            const contracts = JSON.parse(contractsData);

            // Handle files named like: "address_ContractName.sol" (without 0x prefix)
            contracts.forEach(contract => {
                const address = contract.address.toLowerCase().replace('0x', '');
                const fileName = `${address}_${contract.name}.sol`;
                this.contractAddresses.set(fileName.toLowerCase(), contract.address);
            });

            logger.info(`Loaded ${this.contractAddresses.size} contract addresses`);
        } catch (error) {
            logger.error('Error loading contract addresses:', error);
            throw error;
        }
    }

    async findMissingContracts(specificFolder = null) {
        try {
            // Reset stats
            await this.resetStats();

            // Load contract addresses first
            await this.loadContractAddresses();

            const repoPath = this.config.ethereumRepo;
            logger.info(`Starting contract search in: ${repoPath}`);

            if (specificFolder) {
                await this.processSingleFolder(path.join(repoPath, specificFolder));
            } else {
                const folders = await fs.readdir(repoPath);
                for (const folder of folders.sort()) {
                    await this.processSingleFolder(path.join(repoPath, folder));
                }
            }

            // Save results
            await this.saveMissingContracts();
            await this.saveStats();

            return {
                stats: this.stats,
                missingContractsFile: 'missing_contracts.json'
            };
        } catch (error) {
            logger.error('Error in findMissingContracts:', error);
            throw error;
        }
    }

    async resetStats() {
        // Reset stats file
        const statsPath = path.join(process.cwd(), 'contract_stats.json');
        await fs.writeFile(
            statsPath,
            JSON.stringify(this.initializeStats(), null, 2)
        );
        logger.info('Stats reset successfully');
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
                    const contractAddress = this.contractAddresses.get(file.toLowerCase());

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

                    // Log progress periodically
                    if (this.stats.processed % 100 === 0) {
                        this.logProgress();
                    }
                } catch (error) {
                    logger.error(`Error processing file ${file}:`, error);
                    this.stats.errors++;
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

    async validateContractSource(source) {
        // Basic validation checks
        const minLength = 50; // Minimum reasonable length
        const requiredElements = [
            'pragma solidity',  // Must have pragma
            'contract'          // Must have contract keyword
        ];

        try {
            // Check length
            if (source.length < minLength) {
                logger.warn('Contract source too short');
                return false;
            }

            // Check required elements
            for (const element of requiredElements) {
                if (!source.includes(element)) {
                    logger.warn(`Missing required element: ${element}`);
                    return false;
                }
            }

            // Check pragma version
            const pragmaMatch = source.match(/pragma solidity (\^?\d+\.\d+\.\d+|>=?\d+\.\d+\.\d+)/);
            if (!pragmaMatch) {
                logger.warn('Invalid or missing pragma solidity version');
                return false;
            }

            return true;
        } catch (error) {
            logger.error('Error validating contract source:', error);
            return false;
        }
    }
}
