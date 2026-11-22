const CHAIN_LABELS: ReadonlyMap<string, string> = new Map([
	["eip155:1", "Ethereum"],
	["eip155:10", "OP Mainnet"],
	["eip155:137", "Polygon"],
	["eip155:4217", "Tempo"],
	["eip155:8453", "Base"],
	["eip155:42161", "Arbitrum One"],
	["eip155:42220", "Celo"],
	["eip155:43114", "Avalanche C-Chain"],
	["solana:5eykt4usfv8p8njdtrepy1vzqkqzkvdp", "Solana"],
	["tron:mainnet", "Tron"],
	["eip155:42431", "Tempo Testnet"],
	["eip155:43113", "Avalanche Fuji"],
	["eip155:80002", "Polygon Amoy"],
	["eip155:84532", "Base Sepolia"],
	["eip155:421614", "Arbitrum Sepolia"],
	["eip155:11142220", "Celo Sepolia"],
	["eip155:11155111", "Ethereum Sepolia"],
	["eip155:11155420", "OP Sepolia"],
	["solana:etwtrabzayq6imfeykouru166vu2xqa1", "Solana Devnet"],
	["tron:shasta", "Tron Shasta"],
]);

/** A display name for a CAIP-2 chain id, or the id itself when it is not known. */
export function chainLabel(chainId: string): string {
	return CHAIN_LABELS.get(chainId.toLowerCase()) ?? chainId;
}
