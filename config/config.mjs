import yaml from "js-yaml";
import fs from "node:fs/promises";
import path from "node:path";
import { logger } from '../utils/logger.mjs';

export class Config {
  constructor() {
    this.BASE_PATH = path.join(process.cwd(), "config");
    this.CONFIG_FILE = path.join(this.BASE_PATH, "paths.yaml");
    this.chains = new Map();
  }

  async load(chainName = 'ethereum_mainnet') {
    try {
      const data = await fs.readFile(this.CONFIG_FILE, "utf8");
      const config = yaml.load(data);

      // Load default settings
      const defaultConfig = config.default || {};

      // Load chain-specific settings
      const chainConfig = config[chainName];
      if (!chainConfig) {
        throw new Error(`Configuration for chain ${chainName} not found`);
      }

      // Merge chain config with defaults
      const finalConfig = {
        ...defaultConfig,
        ...chainConfig,
        chain_name: chainName
      };

      logger.debug(`Loaded config for ${chainName}:`, finalConfig);
      return finalConfig;

    } catch (error) {
      logger.error(`Failed to load config: ${error.message}`);
      throw error;
    }
  }

  async listAvailableChains() {
    const data = await fs.readFile(this.CONFIG_FILE, "utf8");
    const config = yaml.load(data);
    return Object.keys(config).filter(key => key !== 'default');
  }
}
