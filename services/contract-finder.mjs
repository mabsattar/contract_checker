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
            const repoPath = this.config.ethereumRepo;

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
            const solFiles = files.filter(f => f.endsWith('.sol'));

            this.stats.total = solFiles.length;
            this.overallStats.totalFiles += solFiles.length;

            logger.info(`Processing ${solFiles.length} contracts in ${folderPath}`);

            for (const file of solFiles) {
                try {
                    const contractPath = path.join(folderPath, file);

                    // Extract address and name from filename
                    const [address, contractName] = file.split('_');
                    const name = contractName.replace('.sol', '');

                    // Add 0x prefix for Sourcify API
                    const contractAddress = `0x${address}`;

                    // Validate address format
                    if (!this.isValidEthereumAddress(contractAddress)) {
                        logger.warn(`Invalid address format in filename: ${file}`);
                        this.stats.errors++;
                        this.overallStats.totalErrors++;
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
                            name,
                            foundAt: new Date().toISOString()
                        });
                        this.stats.missing++;
                        this.overallStats.totalMissing++;
                        logger.info(`Found missing contract: ${file}`);
                    } else {
                        this.overallStats.totalMatching++;  // Optional
                    }

                    this.stats.processed++;
                    this.overallStats.totalProcessed++;
                    this.stats.lastProcessed = contractAddress;

                } catch (error) {
                    logger.error(`Error processing file ${file}:`, error);
                    this.stats.errors++;
                    this.overallStats.totalErrors++;
                }

                if (this.stats.processed % 100 === 0) {
                    this.logProgress();
                }
            }
        } catch (error) {
            logger.error(`Error processing folder ${folderPath}:`, error);
            throw error;
        }
    }

    // Helper method to validate Ethereum addresses
    isValidEthereumAddress(address) {
        return /^0x[0-9a-fA-F]{40}$/.test(address);
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

    logProgress() {
        try {
            const progress = {
                overall: {
                    totalFiles: this.overallStats.totalFiles,
                    processed: this.overallStats.totalProcessed,
                    missing: this.overallStats.totalMissing,
                    matching: this.overallStats.totalMatching,
                    errors: this.overallStats.totalErrors,
                    percentage: ((this.overallStats.totalProcessed / this.overallStats.totalFiles) * 100).toFixed(2) + '%'
                },
                folders: {
                    current: this.folderProgress.current,
                    processed: this.folderProgress.processed,
                    remaining: this.folderProgress.total - this.folderProgress.processed.length,
                    totalFolders: this.folderProgress.total
                },
                currentFolder: {
                    total: this.stats.total,
                    processed: this.stats.processed,
                    missing: this.stats.missing,
                    errors: this.stats.errors,
                    percentage: ((this.stats.processed / this.stats.total) * 100).toFixed(2) + '%'
                },
                lastProcessed: {
                    address: this.stats.lastProcessed,
                    verified: this.stats.lastVerified,
                    timestamp: new Date().toISOString()
                },
                timeElapsed: this.getTimeElapsed()
            };

            logger.info('Progress:', JSON.stringify(progress, null, 2));
        } catch (error) {
            logger.error('Error in logProgress:', error);
        }
    }
}
