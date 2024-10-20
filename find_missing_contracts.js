const { chromium } = require('playwright');
const fs = require('fs').promises;
const path = require('path');

// Configuration
const SOURCIFY_API = 'https://sourcify.dev/server/verify';
const CONFIG_PATH = path.join(__dirname, 'config', 'paths.yaml');

async function loadConfig() {
    try {
        const data = await fs.readFile(CONFIG_PATH, 'utf8');
        return JSON.parse(data);
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

async function processChainRepos(repoBaseDir) {
    const config = await loadConfig();
    const repoPath = config.ethereum_repo || '/home/abcode/opensource/smart-contract-sanctuary-ethereum/contracts';

    const browser = await chromium.launch();
    const page = await browser.newPage();

    try {
        await page.goto(repoPath);

        const links = await page.$$eval('a', as => as.map(a => a.href));
        for (const link of links) {
            if (link.includes('.sol')) {
                const contractFile = path.basename(link);
                const contractAddress = contractFile.replace('.sol', '');

                const contractContent = await fs.readFile(path.join(repoPath, contractFile), 'utf8');

                // Check if contract exists in Sourcify
                const existingSource = await fetch(SOURCIFY_API, {
                    method: 'GET',
                    params: { address: contractAddress, chainId: 1 }
                });

                if (!existingSource.ok) {
                    await submitContract(path.basename(repoPath), contractAddress, contractContent);
                }
            }
        }
    } finally {
        await browser.close();
    }
}

async function main() {
    try {
        await processChainRepos('/home/abcode/opensource/smart-contract-sanctuary-ethereum/contracts');
    } catch (error) {
        console.error('An error occurred:', error);
    }
}

main().catch(console.error);
