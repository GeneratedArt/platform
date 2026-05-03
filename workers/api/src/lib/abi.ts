import {
  encodeFunctionData,
  parseAbi,
  type Hex,
} from "viem";

export type { Hex };

/// Subset of GAProjectFactory ABI we encode against from the Worker.
export const factoryAbi = parseAbi([
  "function createProject(string name, string symbol, uint96 royaltyBps, uint256 maxSupply) returns (address)",
  "event ProjectCreated(address indexed project, address indexed artist, string name, string symbol, uint96 royaltyBps, uint256 maxSupply)",
]);

/// Subset of GAProject (clone) ABI used by the mint UI and Worker.
export const projectAbi = parseAbi([
  "function setBaseFrozenCID(string cid)",
  "function mint(bytes32 seed) returns (uint256)",
  "function isCIDLocked() view returns (bool)",
  "function totalMinted() view returns (uint256)",
  "function maxSupply() view returns (uint256)",
  "function frozenCID() view returns (string)",
  "function tokenURI(uint256 tokenId) view returns (string)",
  "event Minted(uint256 indexed tokenId, address indexed to, bytes32 seed)",
  "event FrozenCIDLocked(string cid)",
]);

export function encodeCreateProjectCalldata(
  name: string,
  symbol: string,
  royaltyBps: number,
  maxSupply: bigint,
): Hex {
  return encodeFunctionData({
    abi: factoryAbi,
    functionName: "createProject",
    args: [name, symbol, BigInt(royaltyBps), maxSupply],
  });
}

export function encodeSetBaseFrozenCIDCalldata(cid: string): Hex {
  return encodeFunctionData({
    abi: projectAbi,
    functionName: "setBaseFrozenCID",
    args: [cid],
  });
}

export function encodeMintCalldata(seed: Hex): Hex {
  return encodeFunctionData({
    abi: projectAbi,
    functionName: "mint",
    args: [seed],
  });
}
