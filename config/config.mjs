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

      return {
        sourcifyApi: config.sourcify_repo || "https://repo.sourcify.dev/api",
        ethereumRepo: config.ethereum_repo,
        chainId: config.chain_id || "1",
        batchSize: config.batch_size || 10,
        maxRetries: config.max_retries || 3,
        verificationDelay: config.verification_delay || 5000
      };
    } catch (error) {
      throw new Error(`Failed to load config: ${error.message}`);
    }
  }
}
