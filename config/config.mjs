import yaml from "js-yaml";
import fs from "node:fs/promises";
import path from "node:path";

export class Config {
  constructor() {
    this.BASE_PATH = path.join(process.cwd(), "config");
    this.CONFIG_FILE = path.join(this.BASE_PATH, "paths.yaml");
  }

  async load() {
    try {
      const data = await fs.readFile(this.CONFIG_FILE, "utf8");
      const config = yaml.load(data);

      const finalConfig = {
        sourcify_api: config.sourcify_api || "https://sourcify.dev/server",
        sourcify_repo: config.sourcify_repo || "https://repo.sourcify.dev",
        chain_id: config.chain_id || "1",
        ethereum_repo: config.ethereum_repo || "/home/abcode/opensource/smart-contract-sanctuary-ethereum/contracts/mainnet",
        batch_size: config.batch_size || 10,
        max_retries: config.max_retries || 3,
        verification_delay: config.verification_delay || 5000
      };

      logger.debug('Loaded config:', finalConfig);

      return finalConfig;
    } catch (error) {
      throw new Error(`Failed to load config: ${error.message}`);
    }
  }
}
