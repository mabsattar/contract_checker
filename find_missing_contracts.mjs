import yaml from 'js-yaml';
import fs from 'node:fs/promises';
import path from 'node:path';
import fetch from 'node-fetch';
import Bottleneck from 'bottleneck';


const SOURCIFY_API = 'https://sourcify.dev/server';
const BASE_PATH = path.join(process.cwd(), 'config');
const CONFIG_FILE = path.join(BASE_PATH, 'paths.yaml');
const CACHE_FILE = path.join(BASE_PATH, 'sourcify_cache.json');




const limiter = new Bottleneck({
    minTime: 60000 // 60 seconds between requests
});


async function loadConfig() {
    try {
        const data = await fs.readFile(CONFIG_FILE, 'utf8');
        return yaml.load(data);
    } catch (error) {
        console.error('Error loading config:', error);
        throw error;
    }
}

async function getCachedContracts() {
    try {
        const cacheData = await fs.readFile(CACHE_FILE, 'utf8');
        return JSON.parse(cacheData);
    } catch (error) {
        console.error('Error reading cache:', error);
        return {};
    }
}


async function saveCachedContracts(contracts) {
    await fs.writeFile(CACHE_FILE, JSON.stringify(contracts, null, 2));
}

async function checkContract(contractAddress) {
    return limiter.schedule(async () => {
        try {
            const url = `${SOURCIFY_API}?address=${contractAddress}&chainId=1`;
            console.log(`Checking ${url}`);

            // Add a timeout to prevent hanging on slow connections
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 seconds timeout

            const existingSource = await fetch(url, { signal: controller.signal });

            clearTimeout(timeoutId);

            console.log(`Response status: ${existingSource.status}`);

            const cacheResult = {
                ok: existingSource.ok,
                timestamp: Date.now(),
            };
            await saveCachedContracts({ ...getCachedContracts(), [contractAddress]: cacheResult });

            return existingSource.ok;


        } catch (error) {
            if (error.name === 'AbortError') {
                console.error('Request timed out');
            } else if (error instanceof Error && error.message.includes('ENOTFOUND')) {
                console.error('DNS resolution failed:', error.message);
            } else {
                console.error('Fetch error:', error.message);
            }
            throw error;
        }
    });
}


async function submitContract(chain, contractAddress, contractSource) {
    return limiter.schedule(async () => {
        const maxRetries = 3;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const payload = {
                    address: contractAddress,
                    chain: chain,
                    files: [{ name: 'contract.sol', content: contractSource }]
                };

                const response = await fetch(`${SOURCIFY_API}/input-files`, {
                    method: 'POST',
                    body: JSON.stringify(payload),
                    headers: { 'Content-Type': 'application/json' }
                });

                if (response.ok) {
                    console.log(`Successfully submitted ${contractAddress} on ${chain}`);
                    return true;
                } else {
                    const errorText = await response.text();
                    console.error(`Failed to submit ${contractAddress}: ${errorText}`);
                }
            } catch (error) {
                if (attempt < maxRetries) {
                    console.log(`Attempt ${attempt} failed. Retrying...`);
                    await new Promise(resolve => setTimeout(resolve, 1000 * attempt)); // Exponential backoff
                } else {
                    throw error;
                }
            }
        }
    });
}


async function processChainRepos() {
    const config = await loadConfig();
    const repoPath = config.ethereum_repo || path.join(BASE_PATH, '..', '..', 'smart-contract-sanctuary-ethereum', 'contracts');

    console.log("Checking contracts in:", repoPath);

    try {
        const contractFolders = await fs.readdir(repoPath);

        for (const folder of contractFolders) {
            const folderPath = path.join(repoPath, folder);
            const stat = await fs.stat(folderPath);

            if (stat.isDirectory()) {
                // Read the .sol files within the folder
                const contractFiles = await fs.readdir(folderPath);

                for (const contractFile of contractFiles) {
                    if (contractFile.endsWith('.sol')) {
                        const contractAddress = contractFile.replace('.sol', '');
                        const contractContent = await fs.readFile(path.join(folderPath, contractFile), 'utf8');

                        const existingSource = await checkContract(contractAddress);
                        console.log(`Response status: ${existingSource ? 'OK' : 'Not Found'}`);

                        if (!existingSource) {
                            console.log(`Contract ${contractAddress} does not exist in Sourcify`);
                            await submitContract('ethereum', contractAddress, contractContent);
                        } else {
                            console.log(`Contract ${contractAddress} exists in Sourcify`);
                        }
                    }
                }
            }
        }
    } catch (error) {
        console.error('Error processing repos:', error);
    }
}

async function main() {
    try {
        console.log("Starting contract checker...");

        const config = await loadConfig();
        console.log("Loaded configuration:", config);

        const repoPath = config.ethereum_repo || path.join(BASE_PATH, '..', '..', 'smart-contract-sanctuary-ethereum', 'contracts');
        console.log("Checking contracts in:", repoPath);

        await processChainRepos();

        console.log("Contract checking completed.");
    } catch (error) {
        console.error('An error occurred:', error);
    }
}

main().catch(console.error);
