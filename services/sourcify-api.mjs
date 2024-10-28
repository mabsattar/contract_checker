import axios from 'axios';
import Bottleneck from "bottleneck";
import FormData from 'form-data';
import { logger } from '../utils/logger.mjs';

export class SourcifyAPI {
    constructor(apiUrl, maxRetries = 3) {
        this.apiUrl = apiUrl;
        this.maxRetries = maxRetries;

        // Create axios instance with default config
        this.client = axios.create({
            baseURL: apiUrl,
            timeout: 30000, // Increased timeout for large contracts
        });

        // Setup rate limiting
        this.limiter = new Bottleneck({
            minTime: 3000,
            maxConcurrent: 1
        });

        // Add response interceptor for error handling
        this.client.interceptors.response.use(
            response => response,
            error => this.handleApiError(error)
        );
    }

    async handleApiError(error) {
        if (error.response) {
            logger.error(`API Error: ${error.response.status} - ${JSON.stringify(error.response.data)}`);
        } else if (error.request) {
            logger.error('No response received from API');
        } else {
            logger.error('Error setting up request:', error.message);
        }
        throw error;
    }

    async checkContract(contractAddress, retries = this.maxRetries) {
        try {
            const response = await this.limiter.schedule(() =>
                this.client.get(`/files/any/${contractAddress}`)
            );
            return response.status === 200;
        } catch (error) {
            if (error.response?.status === 429 && retries > 0) {
                logger.warn(`Rate limit hit for ${contractAddress}. Retrying...`);
                await new Promise(resolve => setTimeout(resolve, 5000));
                return this.checkContract(contractAddress, retries - 1);
            }
            if (error.response?.status === 404) {
                // Contract not found is an expected case
                return false;
            }
            logger.error(`Error checking contract ${contractAddress}:`, error.message);
            return false;
        }
    }

    async submitContract(address, contractData) {
        try {
            // Create a new FormData instance
            const formData = new FormData();

            // Add the basic contract information
            formData.append('address', address);
            formData.append('chain', contractData.chainId || '1');

            // Handle the source files
            if (typeof contractData.files === 'object') {
                // If files is an object with named sources
                for (const [filename, content] of Object.entries(contractData.files)) {
                    formData.append(
                        'files',
                        Buffer.from(content),
                        {
                            filename,
                            contentType: 'text/plain'
                        }
                    );
                }
            } else if (contractData.source) {
                // If it's a single source file
                formData.append(
                    'files',
                    Buffer.from(contractData.source),
                    {
                        filename: 'source.sol',
                        contentType: 'text/plain'
                    }
                );
            }

            // Add compiler information if available
            if (contractData.compilerVersion) {
                formData.append('compilerVersion', contractData.compilerVersion);
            }

            const response = await this.limiter.schedule(() =>
                this.client.post('/verify', formData, {
                    headers: {
                        ...formData.getHeaders(),
                        'Accept': 'application/json'
                    },
                    maxContentLength: Infinity,
                    maxBodyLength: Infinity
                })
            );

            logger.info(`Contract ${address} submitted successfully`);
            return {
                success: true,
                data: response.data
            };
        } catch (error) {
            logger.error(`Failed to submit contract ${address}:`, error.message);
            return {
                success: false,
                error: error.message,
                details: error.response?.data
            };
        }
    }

    // Helper method to format contract data
    formatContractData(contract) {
        const formData = new FormData();

        try {
            // Required fields
            formData.append('address', contract.address);
            formData.append('chain', contract.chainId || '1');

            // Source files
            if (contract.source) {
                formData.append('files', Buffer.from(contract.source), 'source.sol');
            }

            // Optional metadata
            if (contract.compilerVersion) {
                formData.append('compilerVersion', contract.compilerVersion);
            }

            return formData;
        } catch (error) {
            logger.error('Error formatting contract data:', error);
            throw error;
        }
    }

    // Method to check verification status
    async checkVerificationStatus(contractAddresses) {
        try {
            const response = await this.client.post('/verification-status', {
                addresses: contractAddresses
            });
            return response.data;
        } catch (error) {
            logger.error('Failed to check verification status:', error.message);
            throw error;
        }
    }
}
