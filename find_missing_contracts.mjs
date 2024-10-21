import yaml from 'js-yaml';
import fs from 'node:fs/promises';
import path from 'node:path';
import fetch from 'node-fetch';

const SOURCIFY_API = 'https://sourcify.dev';
const CONFIG_PATH = path.join(process.cwd(), 'config', 'paths.yaml');

async function loadConfig() {
    try {
        const data = await fs.readFile(CONFIG_PATH, 'utf8');
        return yaml.load(data);
    } catch (error) {
        console.error('Error loading config:', error);
        throw error;
    }
}

async function submitContract(chain, contractAddress, contractSource) {
    const payload = {
        address: contractAddress,
        chain: chain,
        files: [
            { name: 'contract.sol', content: contractSource }
        ]
    };

    try {
        const response = await fetch(SOURCIFY_API, {
            method: 'POST',
            body: JSON.stringify(payload),
            headers: { 'Content-Type': 'application/json' }
        });

        if (response.ok) {
            console.log(`Successfully submitted ${contractAddress} on ${chain}`);
        } else {
            const errorText = await response.text();
            console.error(`Failed to submit ${contractAddress}: ${errorText}`);
        }
    } catch (error) {
        console.error('Error submitting contract:', error);
    }
}

async function processChainRepos() {
    const config = await loadConfig();
    const repoPath = config.ethereum_repo || '/home/abcode/opensource/smart-contract-sanctuary-ethereum/contracts';

    console.log("Checking contracts in:", repoPath);

    try {
        const contractFiles = await fs.readdir(repoPath);

        for (const contractFile of contractFiles) {
            if (contractFile.endsWith('.sol')) {
                const contractAddress = contractFile.replace('.sol', '');
                const contractContent = await fs.readFile(path.join(repoPath, contractFile), 'utf8');

                const url = `${SOURCIFY_API}?address=${contractAddress}&chainId=1`;
                console.log(`Checking ${url}`);

                const existingSource = await fetch(url);
                console.log(`Response status: ${existingSource.status}`);

                if (!existingSource.ok) {
                    console.log(`Contract ${contractAddress} does not exist in Sourcify`);
                    await submitContract('ethereum', contractAddress, contractContent);
                } else {
                    console.log(`Contract ${contractAddress} exists in Sourcify`);
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

        const repoPath = config.ethereum_repo || '/home/abcode/opensource/smart-contract-sanctuary-ethereum/contracts';
        console.log("Checking contracts in:", repoPath);

        await processChainRepos();

        console.log("Contract checking completed.");
    } catch (error) {
        console.error('An error occurred:', error);
    }
}

main().catch(console.error);

export { main };