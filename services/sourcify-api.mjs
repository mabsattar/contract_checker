import axios from 'axios';
import FormData from 'form-data';
import { logger } from '../utils/logger.mjs';

export class SourcifyAPI {
    constructor(config) {
        this.chainId = config.chain_id;
        this.apiUrl = config.sourcify_api || 'https://sourcify.dev/server';
        this.repoUrl = config.sourcify_repo || 'https://repo.sourcify.dev';

        // Configure axios with base URL and timeouts
        this.client = axios.create({
            baseURL: this.apiUrl,
            timeout: 30000, // 30 seconds
            headers: {
                'Accept': 'application/json'
            }
        });

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
            if (!this._isValidAddress(address)) {
                logger.warn(`Invalid address format: ${address}`);
                return false;
            }

            // Using the check-by-addresses endpoint as documented in sourcify-go
            const response = await this.client.get('/check-by-addresses', {
                params: {
                    addresses: address,
                    chainIds: this.chainId
                }
            });

            const isVerified = response.data.some(result =>
                result.status === 'perfect' || result.status === 'partial'
            );

            if (isVerified) {
                this.verificationStats.successful++;
                this.verificationStats.lastSuccess = address;
                logger.debug(`Contract ${address} is verified`);
                return true;
            }

            return false;
        } catch (error) {
            this._handleApiError(error, address);
            return false;
        }
    }

    async submitContract(contract) {
        try {
            if (!this._validateContractData(contract)) {
                this.verificationStats.malformed++;
                throw new Error('Invalid contract data format');
            }

            const formData = new FormData();
            formData.append('address', contract.address);
            formData.append('chain', this.chainId.toString());

            // Following sourcify-go's file submission format
            const files = {
                [`${contract.filename}`]: contract.source
            };
            formData.append('files', JSON.stringify(files));

            const response = await this.client.post('/verify', formData, {
                headers: {
                    ...formData.getHeaders()
                },
                maxBodyLength: Infinity
            });

            if (response.data.status === 'success') {
                this.verificationStats.successful++;
                this.verificationStats.lastSuccess = contract.address;
                return response.data;
            }

            throw new Error(response.data.message || 'Verification failed');
        } catch (error) {
            this._handleApiError(error, contract.address);
            throw error;
        }
    }

    // Helper methods for better error handling and validation
    _handleApiError(error, address) {
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

    _isValidAddress(address) {
        return /^(0x)?[0-9a-fA-F]{40}$/.test(address);
    }

    _validateContractData(contract) {
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
}
