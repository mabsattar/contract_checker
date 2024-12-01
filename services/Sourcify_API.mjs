import axios from 'axios';
import { logger } from '../utils/logger.mjs';
import path from 'path';
import fs from 'fs/promises';
import FormData from 'form-data';

export class SourcifyAPI {
  constructor(config) {
    this.chainId = config.chain_id;
    this.apiUrl = config.sourcify_api;
    this.timeout = config.sourcify.timeout;

    logger.info('sourcifyApi initialized with:', {
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
  }

   /**
   * Validates the contract data.
   * @param {Object} contract - Contract object to validate.
   * @returns {boolean} - True if valid, false otherwise.
   */
   _validateContractData(contract) {
    return (
      contract &&
      contract.address &&
      contract.contractName &&
      contract.compilerVersion &&
      contract.source
    );
  }

  /**
   * Handles API errors.
   * @param {Error} error - Error object.
   * @param {string} address - Contract address.
   * @returns {boolean} - Always returns false to indicate failure.
   */

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

  getStats() {
    return {
      ...this.verificationStats,
      timestamp: new Date().toISOString()
    };
  }


  async saveMetadata(contract, metadata) {
    const metadataPath = path.join(
      'chains',
      this.chainId.toString(),
      'metadata',
      `${contract.address}.json`
    );

    try {
      await fs.mkdir(path.dirname(metadataPath), { recursive: true });
      await fs.writeFile(
        metadataPath,
        JSON.stringify(metadata, null, 2)
      );
      logger.debug(`Saved metadata for ${contract.address}`);
    } catch (error) {
      logger.error(`Error saving metadata for ${contract.address}:`, error);
    }
  }

  _validateSourceCode(source) {
    if (!source.includes('pragma solidity')) {
      // Add pragma if missing
      source = '// SPDX-License-Identifier: UNLICENSED\npragma solidity ^0.8.0;\n' + source;
    }
    return source;
  }

  async contractSubmission(contract) {
    try {
      // Validate contract data
      if (!this._validateContractData(contract)) {
        throw new Error(`Invalid contract data for address: ${contract.address}`);
      }
  
      // Prepare submission payload
      const payload = new FormData();
      payload.append('address', contract.address);
      payload.append('chain', this.chainId.toString());
      payload.append('contractName', contract.contractName);
      payload.append('compilerVersion', contract.compilerVersion);
      payload.append('source', contract.source);
  
      // Handle additional metadata (optional)
      if (contract.metadata) {
        payload.append('metadata', JSON.stringify(contract.metadata));
      }
  
      // Define endpoint
      const submissionUrl = `${this.apiUrl}/input-files`;
  
      // Submit to Sourcify
      const response = await axios.post(submissionUrl, payload, {
        headers: {
          ...payload.getHeaders(),
        },
        timeout: this.timeout,
      });
  
      if (response.status === 200 || response.status === 201) {
        // Submission successful
        logger.info(`Successfully submitted contract: ${contract.address}`);
        this.verificationStats.successful++;
        this.verificationStats.matchingContracts.push({
          address: contract.address,
          status: 'submitted',
          timestamp: new Date().toISOString(),
        });
  
        // Optionally save metadata
        if (response.data.metadata) {
          await this.saveMetadata(contract, response.data.metadata);
        }
  
        return true;
      } else {
        // Handle unexpected responses
        logger.warn(`Unexpected response from Sourcify for ${contract.address}:`, response.statusText);
        this.verificationStats.failed++;
        return false;
      }
    } catch (error) {
      return this._handleApiError(error, contract.address);
    }
  }

  async processAndSubmitContracts(chain, network, config) {
    try {
      const processor = new ContractProcessor(config.sourcifyApi, config.cacheManager, config);
      const sourcify = new SourcifyAPI(config);
  
      // Step 1: Process missing contracts
      logger.info(`Processing missing contracts for chain: ${chain}, network: ${network}`);
      const processedContracts = await processor.processMissingContracts(chain, network);
  
      if (processedContracts.length === 0) {
        logger.info("No contracts to submit.");
        return;
      }
  
      // Step 2: Submit each processed contract to Sourcify
      for (const contract of processedContracts) {
        try {
          logger.info(`Submitting contract: ${contract.address}`);
          const isSubmitted = await sourcify.contractSubmission(contract);
          if (isSubmitted) {
            logger.info(`Contract ${contract.address} submitted successfully`);
          } else {
            logger.warn(`Failed to submit contract ${contract.address}`);
          }
        } catch (error) {
          logger.error(`Error during submission of contract ${contract.address}: ${error.message}`);
        }
      }
  
      // Optional: Save progress or statistics
      logger.info("Processing and submission completed.");
      await processor.saveProgress();
  
    } catch (error) {
      logger.error(`Error in processAndSubmitContracts: ${error.message}`);
      throw error;
    }
  }
}
  


