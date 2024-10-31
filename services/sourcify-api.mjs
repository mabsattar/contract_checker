import axios from 'axios';
import FormData from 'form-data';
import Bottleneck from 'bottleneck';
import { logger } from '../utils/logger.mjs';

export class SourcifyAPI {
    constructor(config) {
        this.repoUrl = config.sourcify_repo;
        this.apiUrl = config.sourcify_api;
        this.chainId = config.chain_id;
        this.maxRetries = config.max_retries || 3;
        this.verificationDelay = config.verification_delay || 5000;

        // Initialize rate limiter
        this.limiter = new Bottleneck({
            minTime: 1000, // Minimum time between requests (1 second)
            maxConcurrent: 1, // Only one request at a time
            reservoir: 30, // Number of requests per minute
            reservoirRefreshAmount: 30,
            reservoirRefreshInterval: 60 * 1000 // 1 minute
        });

        // Add retry mechanism to rate limiter
        this.limiter.on('failed', async (error, jobInfo) => {
            if (jobInfo.retryCount < this.maxRetries - 1) {
                logger.warn(`Request failed, retrying (${jobInfo.retryCount + 1}/${this.maxRetries})`);
                return this.verificationDelay; // Wait before retry
            }
        });

        // Add verification status tracking
        this.verificationStats = {
            successful: 0,
            failed: 0,
            rateLimited: 0,
            malformed: 0,
            lastError: null,
            lastSuccess: null
        };
    }

    async checkContract(address) {
        try {
            // Normalize and validate address
            if (!this.isValidAddress(address)) {
                logger.warn(`Invalid address format: ${address}`);
                return false;
            }

            address = address.toLowerCase();
            if (!address.startsWith('0x')) {
                address = '0x' + address;
            }

            logger.debug(`Checking contract ${address} on chain ${this.chainId}`);

            // Enhanced error handling for API responses
            try {
                const [fullMatch, partialMatch] = await Promise.allSettled([
                    this.limiter.schedule(() => this.makeRequest(`${this.repoUrl}/contracts/full_match/${this.chainId}/${address}/metadata.json`)),
                    this.limiter.schedule(() => this.makeRequest(`${this.repoUrl}/contracts/partial_match/${this.chainId}/${address}/metadata.json`))
                ]);

                if (fullMatch.status === 'fulfilled' && fullMatch.value.status === 200) {
                    this.verificationStats.successful++;
                    this.verificationStats.lastSuccess = address;
                    logger.debug(`Contract ${address} has full match verification`);
                    return true;
                }

                if (partialMatch.status === 'fulfilled' && partialMatch.value.status === 200) {
                    this.verificationStats.successful++;
                    this.verificationStats.lastSuccess = address;
                    logger.debug(`Contract ${address} has partial match verification`);
                    return true;
                }

                return false;
            } catch (error) {
                this.handleApiError(error, address);
                return false;
            }
        } catch (error) {
            logger.error(`Unexpected error checking contract ${address}: ${error.message}`);
            this.verificationStats.failed++;
            this.verificationStats.lastError = {
                address,
                error: error.message,
                timestamp: new Date().toISOString()
            };
            return false;
        }
    }

    async submitContract(contract) {
        try {
            // Validate contract data
            if (!this.validateContractData(contract)) {
                this.verificationStats.malformed++;
                throw new Error('Invalid contract data format');
            }

            const formData = new FormData();
            formData.append('address', contract.address);
            formData.append('chain', this.chainId.toString());

            const files = {
                [`${contract.filename}`]: contract.source
            };
            formData.append('files', JSON.stringify(files));

            const response = await this.limiter.schedule(() =>
                axios.post(`${this.apiUrl}/verify`, formData, {
                    headers: {
                        ...formData.getHeaders(),
                        'Accept': 'application/json'
                    },
                    maxBodyLength: Infinity
                })
            );

            this.verificationStats.successful++;
            this.verificationStats.lastSuccess = contract.address;
            return response.data;

        } catch (error) {
            this.handleApiError(error, contract.address);
            throw error;
        }
    }

    // Helper methods for better error handling and validation
    handleApiError(error, address) {
        if (error.response?.status === 429) {
            this.verificationStats.rateLimited++;
            logger.warn(`Rate limited while processing ${address}`);
        } else {
            this.verificationStats.failed++;
            logger.error(`API error for ${address}: ${error.message}`);
        }

        this.verificationStats.lastError = {
            address,
            error: error.message,
            status: error.response?.status,
            timestamp: new Date().toISOString()
        };
    }

    isValidAddress(address) {
        return /^(0x)?[0-9a-fA-F]{40}$/.test(address);
    }

    validateContractData(contract) {
        return (
            contract &&
            typeof contract.address === 'string' &&
            typeof contract.source === 'string' &&
            typeof contract.filename === 'string'
        );
    }

    // Method to get current statistics
    getStats() {
        return {
            ...this.verificationStats,
            timestamp: new Date().toISOString()
        };
    }

    // Helper method for rate-limited requests
    async makeRequest(url) {
        return this.limiter.schedule(() => axios.head(url));
    }
}
