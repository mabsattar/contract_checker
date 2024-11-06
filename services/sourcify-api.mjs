import axios from 'axios';
import FormData from 'form-data';
import { logger } from '../utils/logger.mjs';

export class SourcifyAPI {
    constructor(config) {
        this.chainId = config.chain_id;
        this.apiUrl = config.sourcify_api;
        this.shouldTryPartialMatch = config.sourcify.attempts.partial_match;
        this.timeout = config.sourcify.timeout;

        logger.info('SourcifyAPI initialized with:', {
            chainId: this.chainId,
            apiUrl: this.apiUrl
        });

        this.verificationStats = {
            successful: 0,
            failed: 0,
            rateLimited: 0,
            malformed: 0,
            lastError: null,
            lastSuccess: null,
            matchingContracts: []
        };

        this.stats = {
            ...this.stats,
            fullMatches: 0,
            partialMatches: 0,
            failed: 0
        };
    }

    _isValidAddress(address) {
        // Check if address is a string and matches Ethereum address format
        return typeof address === 'string' &&
            /^(0x)?[0-9a-fA-F]{40}$/i.test(address);
    }

    async checkContract(address) {
        try {
            if (!this._isValidAddress(address)) {
                logger.warn(`Invalid address format: ${address}`);
                return false;
            }

            // Normalize address to lowercase
            address = address.toLowerCase();
            if (!address.startsWith('0x')) {
                address = '0x' + address;
            }

            // First try the verification check endpoint
            const verifyUrl = `${this.apiUrl}/check-by-addresses?addresses=${address}&chainIds=${this.chainId}`;
            logger.debug(`Checking Sourcify verification at: ${verifyUrl}`);

            const response = await axios.get(verifyUrl);
            logger.debug(`Sourcify response for ${address}:`, response.data);

            // The API returns an array of results
            if (Array.isArray(response.data) && response.data.length > 0) {
                const result = response.data[0];

                // Check if contract is verified (either full or partial match)
                const isVerified = result.status === 'perfect' || result.status === 'partial';

                if (isVerified) {
                    this.verificationStats.successful++;
                    this.verificationStats.lastSuccess = address;
                    this.verificationStats.matchingContracts.push({
                        address,
                        status: result.status,
                        timestamp: new Date().toISOString()
                    });
                    logger.debug(`Contract ${address} is verified in Sourcify (${result.status})`);
                    return true;
                }
            }

            // If we get here, try the files endpoint as a fallback
            const filesUrl = `${this.apiUrl}/files/any/${this.chainId}/${address}`;
            try {
                const filesResponse = await axios.head(filesUrl);
                if (filesResponse.status === 200) {
                    this.verificationStats.successful++;
                    this.verificationStats.lastSuccess = address;
                    this.verificationStats.matchingContracts.push({
                        address,
                        status: 'files exist',
                        timestamp: new Date().toISOString()
                    });
                    logger.debug(`Contract ${address} is verified in Sourcify (files exist)`);
                    return true;
                }
            } catch (error) {
                if (error.response?.status === 404) {
                    logger.debug(`Contract ${address} is not verified in Sourcify (no files found)`);
                    return false;
                }
                // For other errors, continue to the main error handler
                throw error;
            }

            return false;

        } catch (error) {
            return this._handleApiError(error, address);
        }
    }

    async submitContract(contract) {
        try {
            if (!this._validateContractData(contract)) {
                throw new Error('Invalid contract data format');
            }

            const formData = new FormData();
            formData.append('address', contract.address.toLowerCase());
            formData.append('chain', this.chainId);

            // Add source files with proper structure
            const sourceFileName = contract.filename;
            formData.append('files', Buffer.from(contract.source), sourceFileName);

            // Try to create metadata if not present
            if (!contract.metadata) {
                // Create basic metadata structure
                const metadata = {
                    language: "Solidity",
                    sources: {
                        [sourceFileName]: {
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
                formData.append('files', Buffer.from(JSON.stringify(metadata)), 'metadata.json');
            } else {
                formData.append('files', Buffer.from(contract.metadata), 'metadata.json');
            }

            // First try full match
            logger.debug(`Attempting full match for ${contract.address}`);
            const fullMatchResponse = await axios.post(
                `${this.apiUrl}/verify`,
                formData,
                {
                    headers: { ...formData.getHeaders() },
                    params: { chainId: this.chainId }
                }
            );

            if (fullMatchResponse.data.status === 'success') {
                logger.info(`Full match successful for ${contract.address}`);
                return true;
            }

            // If full match fails, try partial match
            logger.debug(`Attempting partial match for ${contract.address}`);
            const partialMatchResponse = await axios.post(
                `${this.apiUrl}/verify`,
                formData,
                {
                    headers: { ...formData.getHeaders() },
                    params: {
                        chainId: this.chainId,
                        partial: true
                    }
                }
            );

            if (partialMatchResponse.data.status === 'success') {
                logger.info(`Partial match successful for ${contract.address}`);
                return true;
            }

            logger.warn(`Both full and partial matches failed for ${contract.address}`);
            return false;

        } catch (error) {
            logger.error(`Error submitting contract ${contract.address}:`, {
                message: error.message,
                response: error.response?.data,
                status: error.response?.status
            });
            return false;
        }
    }

    _handleApiError(error, address) {
        if (error.response) {
            // Handle rate limiting
            if (error.response.status === 429) {
                this.verificationStats.rateLimited++;
                logger.warn(`Rate limited while checking ${address}`);
                return false;
            }

            // Handle 404s (not found)
            if (error.response.status === 404) {
                logger.debug(`Contract ${address} not found in Sourcify`);
                return false;
            }
        }

        // Log other errors
        logger.error(`API error checking ${address}:`, error.message);
        this.verificationStats.failed++;
        this.verificationStats.lastError = error.message;
        return false;
    }

    _validateContractData(contract) {
        // Validate required fields for submission
        const required = ['address', 'filename', 'source'];
        return required.every(field => {
            const hasField = !!contract[field];
            if (!hasField) {
                logger.warn(`Missing required field ${field} in contract data`);
            }
            return hasField;
        });
    }

    getStats() {
        return {
            ...this.verificationStats,
            timestamp: new Date().toISOString()
        };
    }
}
