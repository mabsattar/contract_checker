import fs from "node:fs/promises";
import path from "node:path";
import { logger } from '../utils/logger.mjs';

export class ContractFinder {
    constructor(sourcifyApi, config) {
        this.sourcifyApi = sourcifyApi;
        this.config = config;
        this.missingContracts = [];
        this.stats = this.initializeStats();

        // Add timeout handling
        this.processTimeout = 30000; // 30 seconds timeout for processing each contract
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
            const repoPath = this.config.ethereum_repo;
            logger.info(`Starting contract search in: ${repoPath}`);

            if (specificFolder) {
                const folderPath = path.join(repoPath, specificFolder);
                logger.info(`Processing specific folder: ${folderPath}`);
                await this.processFolder(folderPath);
            }

            await this.saveStats();
            await this.saveMissingContracts();

            return {
                stats: this.stats,
                missingContractsFile: path.join(process.cwd(), 'missing_contracts.json')
            };

        } catch (error) {
            logger.error('Error in findMissingContracts:', error);
            throw error;
        }
    }

    async processFolder(folderPath) {
        try {
            const files = await fs.readdir(folderPath);
            const solFiles = files.filter(file => file.endsWith('.sol'));

            logger.info(`Processing ${solFiles.length} contracts in ${folderPath}`);

            let processed = 0;
            for (const file of solFiles) {
                try {
                    const startTime = Date.now();

                    // Extract address from filename
                    const match = file.match(/^([a-fA-F0-9]{40})_([^.]+)\.sol$/);
                    if (!match) {
                        logger.warn(`Invalid filename format: ${file}`);
                        this.stats.errors++;
                        continue;
                    }

                    const [_, addressWithout0x, contractName] = match;
                    const address = '0x' + addressWithout0x;

                    logger.debug(`Processing contract: ${file}`);

                    // Process contract with timeout
                    await Promise.race([
                        this.processContract(address, contractName, file, folderPath),
                        new Promise((_, reject) =>
                            setTimeout(() => reject(new Error('Processing timeout')), this.processTimeout)
                        )
                    ]);

                    processed++;
                    if (processed % 10 === 0) {
                        logger.info(`Processed ${processed}/${solFiles.length} contracts in ${folderPath}`);
                    }

                    const processingTime = Date.now() - startTime;
                    logger.debug(`Processed ${file} in ${processingTime}ms`);

                } catch (error) {
                    logger.error(`Error processing file ${file}:`, error);
                    this.stats.errors++;
                }
            }

        } catch (error) {
            logger.error(`Error reading folder ${folderPath}:`, error);
            throw error;
        }
    }

    async processContract(address, contractName, filename, folderPath) {
        try {
            this.stats.processed++;

            // Check if contract exists in Sourcify
            const isVerified = await this.sourcifyApi.checkContract(address);

            if (!isVerified) {
                // Read contract source
                const filePath = path.join(folderPath, filename);
                const source = await fs.readFile(filePath, 'utf8');

                this.missingContracts.push({
                    address,
                    contractName,
                    filename,
                    source
                });

                this.stats.missing++;
                logger.info(`Found missing contract: ${filename}`);
            }

            // Save progress periodically
            if (this.stats.processed % 10 === 0) {
                await this.saveProgress();
            }

        } catch (error) {
            logger.error(`Error processing contract ${address}:`, error);
            this.stats.errors++;
        }
    }

    async saveProgress() {
        try {
            await this.saveStats();
            await this.saveMissingContracts();
            logger.info('Progress Update:', {
                processed: this.stats.processed,
                missing: this.stats.missing,
                errors: this.stats.errors
            });
        } catch (error) {
            logger.error('Error saving progress:', error);
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

    async saveMissingContracts() {
        const filePath = path.join(process.cwd(), 'missing_contracts.json');
        try {
            await fs.writeFile(filePath, JSON.stringify(this.missingContracts, null, 2));
            logger.debug(`Saved ${this.missingContracts.length} missing contracts to ${filePath}`);
        } catch (error) {
            logger.error('Error saving missing contracts:', error);
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

    async resetStats() {
        try {
            this.stats = this.initializeStats();
            await this.saveStats();
            logger.info("Stats reset successfully");
        } catch (error) {
            logger.error("Error resetting stats:", error);
            throw error;
        }
    }

    // Add this method to check if we're parsing addresses correctly
    extractAddressFromFilename(filename) {
        // The address should be the part before the first underscore
        const match = filename.match(/^(0x?[a-fA-F0-9]{40})_/);
        if (!match) return null;

        // Ensure address is properly formatted with 0x prefix
        const address = match[1].toLowerCase();
        return address.startsWith('0x') ? address : `0x${address}`;
    }
}
