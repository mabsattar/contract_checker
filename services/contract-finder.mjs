import fs from "node:fs/promises";
import path from "node:path";
import { logger } from '../utils/logger.mjs';

export class ContractFinder {
    constructor(sourcifyApi, config) {
        this.sourcifyApi = sourcifyApi;
        this.config = config;
        this.missingContracts = [];
        this.stats = this.initializeStats();
        this.folderProgress = {
            current: '',
            processed: [],
            total: 0
        };
        this.overallStats = {
            totalFiles: 0,
            totalProcessed: 0,
            totalMissing: 0,
            totalMatching: 0,
            totalErrors: 0,
            startTime: new Date().toISOString()
        };
    }

    initializeStats() {
        return {
            total: 0,
            processed: 0,
            missing: 0,
            errors: 0,
            startTime: new Date().toISOString(),
            lastProcessed: null,
            lastVerified: false
        };
    }

    async findMissingContracts(specificFolder = null) {
        try {
            await this.resetStats();
            const repoPath = this.config.ethereum_repo;

            if (!repoPath) {
                throw new Error('ethereum_repo path not found in config');
            }

            if (specificFolder) {
                await this.processSingleFolder(path.join(repoPath, specificFolder));
            } else {
                // Get all folders and sort them
                const folders = (await fs.readdir(repoPath)).sort();
                this.folderProgress.total = folders.length;

                for (const folder of folders) {
                    this.folderProgress.current = folder;
                    await this.processSingleFolder(path.join(repoPath, folder));
                    this.folderProgress.processed.push(folder);
                }
            }

            // Save final results
            await this.saveMissingContracts();
            await this.saveStats();

            // Return the results
            return {
                stats: this.stats,
                missingContractsFile: path.join(process.cwd(), 'missing_contracts.json')
            };

        } catch (error) {
            logger.error('Error in findMissingContracts:', error);
            throw error;
        }
    }

    async resetStats() {
        this.stats = this.initializeStats();
        this.folderProgress = {
            current: '',
            processed: [],
            total: 0
        };
        this.overallStats = {
            totalFiles: 0,
            totalProcessed: 0,
            totalMissing: 0,
            totalMatching: 0,
            totalErrors: 0,
            startTime: new Date().toISOString()
        };

        // Write initial stats to file
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
            const solFiles = files.filter(file => file.endsWith('.sol'));

            logger.info(`Processing ${solFiles.length} contracts in ${folderPath}`);
            this.stats.total += solFiles.length;

            for (const file of solFiles) {
                try {
                    // Extract address and contract name from filename
                    // Pattern: <address>_<contractName>.sol
                    const match = file.match(/^([a-fA-F0-9]{40})_([^.]+)\.sol$/);
                    if (!match) {
                        logger.warn(`Invalid filename format: ${file}`);
                        this.stats.errors++;
                        continue;
                    }

                    const [_, addressWithout0x, contractName] = match;
                    const address = '0x' + addressWithout0x;

                    // Validate address format
                    if (!this.isValidEthereumAddress(address)) {
                        logger.warn(`Invalid address format in filename: ${file}`);
                        this.stats.errors++;
                        continue;
                    }

                    this.stats.processed++;
                    this.stats.lastProcessed = address;

                    // Check if contract exists in Sourcify
                    const isVerified = await this.sourcifyApi.checkContract(address);
                    this.stats.lastVerified = isVerified;

                    if (!isVerified) {
                        // Read contract source
                        const source = await fs.readFile(path.join(folderPath, file), 'utf8');

                        // Validate source code
                        if (!this.validateContractSource(source)) {
                            logger.warn(`Invalid source code in file: ${file}`);
                            this.stats.errors++;
                            continue;
                        }

                        // Add to missing contracts
                        this.missingContracts.push({
                            address: address,
                            contractName: contractName,
                            filename: file,
                            source: source
                        });

                        this.stats.missing++;
                        logger.info(`Found missing contract: ${file}`);
                        logger.debug(`Contract details: Address=${address}, Name=${contractName}`);
                    }

                    // Save progress periodically
                    if (this.stats.processed % 10 === 0) {
                        await this.saveStats();
                        await this.saveMissingContracts();
                        await this.logProgress();
                    }

                } catch (error) {
                    logger.error(`Error processing file ${file}:`, error);
                    this.stats.errors++;
                }
            }

            // Save final results
            await this.saveStats();
            await this.saveMissingContracts();
            await this.logProgress();

            return this.stats;
        } catch (error) {
            logger.error(`Error processing folder ${folderPath}:`, error);
            throw error;
        }
    }

    // Helper method to validate Ethereum addresses
    isValidEthereumAddress(address) {
        return /^0x[0-9a-fA-F]{40}$/.test(address);
    }

    // Helper method to validate contract source
    validateContractSource(source) {
        if (!source || typeof source !== 'string') {
            return false;
        }

        // Check for pragma solidity
        if (!source.includes('pragma solidity')) {
            return false;
        }

        // Check for contract definition
        if (!source.includes('contract ')) {
            return false;
        }

        return true;
    }

    // Helper method to log progress
    async logProgress() {
        const progress = {
            total: this.stats.total,
            processed: this.stats.processed,
            missing: this.stats.missing,
            errors: this.stats.errors,
            lastProcessed: this.stats.lastProcessed,
            lastVerified: this.stats.lastVerified,
            percentage: ((this.stats.processed / this.stats.total) * 100).toFixed(2) + '%'
        };

        logger.info('Progress:', JSON.stringify(progress, null, 2));
    }

    async saveMissingContracts() {
        const filePath = path.join(process.cwd(), 'missing_contracts.json');
        try {
            await fs.writeFile(filePath, JSON.stringify(this.missingContracts, null, 2));
            logger.debug(`Saved ${this.missingContracts.length} missing contracts to ${filePath}`);
        } catch (error) {
            logger.error('Error saving missing contracts:', error);
        }
    }

    async saveStats() {
        const filePath = path.join(process.cwd(), 'contract_stats.json');
        try {
            await fs.writeFile(filePath, JSON.stringify(this.stats, null, 2));
            logger.debug('Stats saved successfully');
        } catch (error) {
            logger.error('Error saving stats:', error);
        }
    }

    getTimeElapsed() {
        const start = new Date(this.overallStats.startTime);
        const now = new Date();
        const elapsed = now - start;

        // Convert to hours, minutes, seconds
        const hours = Math.floor(elapsed / 3600000);
        const minutes = Math.floor((elapsed % 3600000) / 60000);
        const seconds = Math.floor((elapsed % 60000) / 1000);

        // Format the time string
        let timeString = '';
        if (hours > 0) timeString += `${hours}h `;
        if (minutes > 0) timeString += `${minutes}m `;
        timeString += `${seconds}s`;

        return timeString;
    }
}
