import os

def list_sol_files(directory):
    """Recursively list all .sol files in the given directory."""
    sol_files = []
    for root, _, files in os.walk(directory):
        for file in files:
            if file.endswith('.sol'):
                sol_files.append(os.path.relpath(os.path.join(root, file), directory))
    return sol_files

def main():
    # Set the paths to your repositories
    sanctuary_dir = ''  # Replace with your actual path
    sourcify_dir = '/path/to/sourcify'                   # Replace with your actual path

    # List all .sol files in both directories
    sanctuary_contracts = set(list_sol_files(sanctuary_dir))
    sourcify_contracts = set(list_sol_files(sourcify_dir))

    # Find missing contracts
    missing_contracts = sanctuary_contracts - sourcify_contracts

    # Output missing contracts to a text file
    with open('missing_contracts.txt', 'w') as f:
        for contract in missing_contracts:
            f.write(f"{contract}\n")

    print(f"Missing contracts have been listed in 'missing_contracts.txt'.")
    print(f"Total missing contracts: {len(missing_contracts)}")

if __name__ == '__main__':
    main()
