import fetch from "node-fetch";
import Bottleneck from "bottleneck";
import { logger } from '../utils/logger.mjs';

export class SourcifyAPI {
    constructor(apiUrl, maxRetries = 3) {
        this.apiUrl = apiUrl;
        this.maxRetries = maxRetries;
        this.limiter = new Bottleneck({
            minTime: 3000,
            maxConcurrent: 1
        });
    }

    async checkContract(contractAddress, retries = this.maxRetries) {
        try {
            const response = await this.limiter.schedule(() =>
                fetch(`${this.apiUrl}/files/any/${contractAddress}`, {
                    timeout: 5000
                })
            );

            if (response.status === 429 && retries > 0) {
                logger.warn(`Rate limit hit for ${contractAddress}. Retrying...`);
                await new Promise(resolve => setTimeout(resolve, 5000));
                return this.checkContract(contractAddress, retries - 1);
            }

            return response.ok;
        } catch (error) {
            logger.error(`Error checking contract ${contractAddress}:`, error);
            return false;
        }
    }

    async submitContract(address, contractData) {
        const formData = new FormData();
        formData.append('address', address);
        formData.append('chain', this.config.chainId);
        formData.append('files', JSON.stringify(contractData.files));

        try {
            const response = await fetch(`${this.apiUrl}/verify`, {
                method: 'POST',
                body: formData
            });
            return await response.json();
        } catch (error) {
            logger.error(`Error submitting contract ${address}:`, error);
            throw error;
        }
    }
}