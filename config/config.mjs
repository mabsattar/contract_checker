import yaml from "js-yaml";
import fs from "node:fs/promises";
import path from "node:path";
import { logger } from '../utils/logger.mjs';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

export class Config {
  constructor() {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);

    this.BASE_PATH = __dirname;
    this.CONFIG_FILE = path.join(this.BASE_PATH, "paths.yaml");
    dotenv.config();
  }
  async listAvailableChains() {
    try {
      const data = await fs.readFile(this.CONFIG_FILE, "utf8");
      const config = yaml.load(data);

      // Filter out the 'default' key and return remaining chain names
      return Object.keys(config).filter(key => key !== 'default');
    } catch (error) {
      logger.error(`Failed to list chains: ${error.message}`);
      throw error;
    }
  }

  async load(chainName) {
    try {
      // Validate chain name is provided
      if (!chainName) {
        throw new Error('Chain name must be specified. Use --list-chains to see available chains.');
      }

      const config = await this.loadConfig();

      // Debug lines to help troubleshoot
      console.log('Environment ETH_REPO_PATH:', process.env.ETH_REPO_PATH);
      console.log('Resolved repo_path:', config[chainName]?.repo_path);

      const chainConfig = config[chainName];

      // Validate chain exists in config
      if (!chainConfig) {
        throw new Error(`Invalid chain name: ${chainName}. Use --list-chains to see available chains.`);
      }

      // Merge with default config and add chain name
      return {
        ...config.default,
        ...chainConfig,
        chain_name: chainName
      };
    } catch (error) {
      logger.error(`Failed to load chain config: ${error.message}`);
      throw error;
    }
  }

  _replaceEnvVars(config) {
    const replaceEnvInString = (str) => {
      return str.replace(/\${([^}]+)}/g, (_, envVar) => {
        const value = process.env[envVar];
        if (!value) {
          logger.warn(`Environment variable ${envVar} not found`);
          return '${' + envVar + '}';
        }
        return value;
      });
    };

    // Deep clone and replace env vars
    return Object.entries(config).reduce((acc, [key, value]) => {
      if (typeof value === 'object' && value !== null) {
        acc[key] = this._replaceEnvVars(value);
      } else if (typeof value === 'string') {
        acc[key] = replaceEnvInString(value);
      } else {
        acc[key] = value;
      }
      return acc;
    }, {});
  }

  async listAvailableChains() {
    const data = await fs.readFile(this.CONFIG_FILE, "utf8");
    const config = yaml.load(data);
    return Object.keys(config).filter(key => key !== 'default');
  }

  async loadConfig() {
    try {
      const data = await fs.readFile(this.CONFIG_FILE, "utf8");
      const config = yaml.load(data);
      return this._replaceEnvVars(config);
    } catch (error) {
      logger.error(`Failed to load config: ${error.message}`);
      throw error;
    }
  }
}
