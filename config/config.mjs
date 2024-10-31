import yaml from "js-yaml";
import fs from "node:fs/promises";
import path from "node:path";
import { logger } from '../utils/logger.mjs';
import dotenv from 'dotenv';

export class Config {
  constructor() {
    this.BASE_PATH = path.join(process.cwd(), "config");
    this.CONFIG_FILE = path.join(this.BASE_PATH, "paths.yaml");
    dotenv.config();
  }

  async load(chainName = 'ethereum_mainnet') {
    try {
      const data = await fs.readFile(this.CONFIG_FILE, "utf8");
      let config = yaml.load(data);

      // Replace environment variables in repo_path
      config = this._replaceEnvVars(config);

      // Load chain-specific settings
      const chainConfig = config[chainName];
      if (!chainConfig) {
        throw new Error(`Configuration for chain ${chainName} not found`);
      }

      // Merge with defaults
      const finalConfig = {
        ...config.default,
        ...chainConfig,
        chain_name: chainName
      };

      logger.debug(`Loaded config for ${chainName}`);
      return finalConfig;

    } catch (error) {
      logger.error(`Failed to load config: ${error.message}`);
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
}
