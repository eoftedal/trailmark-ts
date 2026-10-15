/** Port of upstream tests/test_solidity_parser.py. */

import { describe, expect, it } from "vitest";

import { MemoryFileSource } from "../src/fs/source.js";
import type { CodeGraph } from "../src/models/graph.js";
import type { CodeUnit } from "../src/models/nodes.js";
import { parseDirectory, parseSource } from "../src/parse.js";

const SAMPLE_CODE = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./IERC20.sol";

/// An ERC20-like token interface.
interface IERC20 {
    function totalSupply() external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    event Transfer(address indexed from, address indexed to, uint256 value);
}

library SafeMath {
    function add(uint256 a, uint256 b) internal pure returns (uint256) {
        uint256 c = a + b;
        require(c >= a, "overflow");
        return c;
    }
}

/// A simple token contract.
contract Token is IERC20 {
    string public name;
    mapping(address => uint256) private balances;
    address public owner;

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor(string memory _name) {
        name = _name;
        owner = msg.sender;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (balances[msg.sender] < amount) {
            revert("insufficient balance");
        }
        for (uint i = 0; i < 10; i++) {
            balances[to] += 1;
        }
        while (amount > 0) {
            amount--;
        }
        balances[msg.sender] -= amount;
        balances[to] += amount;
        return true;
    }

    function mint(address to, uint256 amount) public onlyOwner {
        balances[to] += amount;
    }

    function balanceOf(address account) public view returns (uint256) {
        return balances[account];
    }
}

struct Point {
    uint256 x;
    uint256 y;
}

enum Status { Active, Paused }
`;

async function parseSample(): Promise<CodeGraph> {
  return parseSource("/tmp/sample_token.sol", SAMPLE_CODE, "solidity");
}

function nodes(graph: CodeGraph): CodeUnit[] {
  return [...graph.nodes.values()];
}

function namesOfKind(graph: CodeGraph, kind: string): Set<string> {
  return new Set(
    nodes(graph)
      .filter((n) => n.kind === kind)
      .map((n) => n.name),
  );
}

function tokenTransfer(graph: CodeGraph): CodeUnit {
  return nodes(graph).find((n) => n.name === "transfer" && n.kind === "method" && n.id.includes("Token"))!;
}

describe("SolidityParser nodes", () => {
  it("finds module", async () => {
    const graph = await parseSample();
    expect(nodes(graph).filter((n) => n.kind === "module")).toHaveLength(1);
  });

  it("finds contract", async () => {
    expect(namesOfKind(await parseSample(), "contract").has("Token")).toBe(true);
  });

  it("finds interface", async () => {
    expect(namesOfKind(await parseSample(), "interface").has("IERC20")).toBe(true);
  });

  it("finds library", async () => {
    expect(namesOfKind(await parseSample(), "library").has("SafeMath")).toBe(true);
  });

  it("finds struct", async () => {
    expect(namesOfKind(await parseSample(), "struct").has("Point")).toBe(true);
  });

  it("finds enum", async () => {
    expect(namesOfKind(await parseSample(), "enum").has("Status")).toBe(true);
  });

  it("finds methods", async () => {
    const names = namesOfKind(await parseSample(), "method");
    for (const n of ["transfer", "mint", "balanceOf", "constructor", "onlyOwner"]) expect(names.has(n)).toBe(true);
  });

  it("finds library methods", async () => {
    expect(namesOfKind(await parseSample(), "method").has("add")).toBe(true);
  });

  it("contract docstring", async () => {
    const token = nodes(await parseSample()).find((n) => n.name === "Token")!;
    expect(token.docstring).not.toBeNull();
    expect(token.docstring).toContain("simple token");
  });

  it("interface docstring", async () => {
    const ierc20 = nodes(await parseSample()).find((n) => n.name === "IERC20")!;
    expect(ierc20.docstring).not.toBeNull();
    expect(ierc20.docstring).toContain("ERC20");
  });

  it("method id includes contract", async () => {
    const ids = nodes(await parseSample())
      .filter((n) => n.kind === "method")
      .map((n) => n.id);
    expect(ids.some((id) => id.includes("Token"))).toBe(true);
  });
});

describe("SolidityParser parameters", () => {
  it("function params", async () => {
    const transfer = tokenTransfer(await parseSample());
    expect(transfer.parameters).toHaveLength(2);
    const names = new Set(transfer.parameters.map((p) => p.name));
    expect(names.has("to")).toBe(true);
    expect(names.has("amount")).toBe(true);
  });

  it("param type", async () => {
    const transfer = tokenTransfer(await parseSample());
    const to = transfer.parameters.find((p) => p.name === "to")!;
    expect(to.typeRef).not.toBeNull();
    expect(to.typeRef!.name).toContain("address");
  });

  it("return type", async () => {
    expect(tokenTransfer(await parseSample()).returnType).not.toBeNull();
  });

  it("constructor params", async () => {
    const ctor = nodes(await parseSample()).find((n) => n.name === "constructor")!;
    expect(ctor.parameters).toHaveLength(1);
    expect(ctor.parameters[0]!.name).toBe("_name");
  });

  it("library function params", async () => {
    const add = nodes(await parseSample()).find((n) => n.name === "add")!;
    expect(add.parameters).toHaveLength(2);
    const names = new Set(add.parameters.map((p) => p.name));
    expect(names.has("a")).toBe(true);
    expect(names.has("b")).toBe(true);
  });
});

describe("SolidityParser complexity", () => {
  it("simple function complexity", async () => {
    const balance = nodes(await parseSample()).find((n) => n.name === "balanceOf")!;
    expect(balance.cyclomaticComplexity).toBe(1);
  });

  it("branching function complexity", async () => {
    const transfer = tokenTransfer(await parseSample());
    expect(transfer.cyclomaticComplexity).not.toBeNull();
    expect(transfer.cyclomaticComplexity!).toBeGreaterThanOrEqual(4);
  });

  it("branches tracked", async () => {
    expect(tokenTransfer(await parseSample()).branches.length).toBeGreaterThan(0);
  });
});

describe("SolidityParser edges", () => {
  it("contains edges", async () => {
    const graph = await parseSample();
    expect(graph.edges.filter((e) => e.kind === "contains").length).toBeGreaterThan(0);
  });

  it("inherits edge", async () => {
    const graph = await parseSample();
    const inherits = graph.edges.filter((e) => e.kind === "inherits");
    expect(inherits).toHaveLength(1);
    expect(inherits[0]!.sourceId).toContain("Token");
    expect(inherits[0]!.targetId).toContain("IERC20");
  });

  it("call edges", async () => {
    const graph = await parseSample();
    expect(graph.edges.filter((e) => e.kind === "calls").length).toBeGreaterThan(0);
  });

  it("call confidence", async () => {
    const graph = await parseSample();
    const certain = graph.edges.filter((e) => e.kind === "calls" && e.confidence === "certain");
    expect(certain.length).toBeGreaterThan(0);
  });

  it("method contained by contract", async () => {
    const graph = await parseSample();
    const tokenContains = graph.edges.filter((e) => e.kind === "contains" && e.sourceId.includes("Token"));
    expect(tokenContains.length).toBeGreaterThan(0);
  });
});

describe("SolidityParser dependencies", () => {
  it("imports tracked", async () => {
    expect((await parseSample()).dependencies).toContain("IERC20");
  });
});

describe("SolidityParser parse directory", () => {
  it("parses multiple files", async () => {
    const root = "/tmp/soldir";
    const source = new MemoryFileSource(root, {
      "a.sol": "contract A {\n    function foo() public {}\n}\n",
      "b.sol": "contract B {\n    function bar() public {}\n}\n",
    });
    const graph = await parseDirectory(source, "solidity");
    expect(graph.language).toBe("solidity");
    expect(graph.rootPath).toBe(root);
    const names = new Set(nodes(graph).map((n) => n.name));
    expect(names.has("A")).toBe(true);
    expect(names.has("B")).toBe(true);
  });

  it("ignores wrong extensions", async () => {
    const source = new MemoryFileSource("/tmp/soldir2", { "skip.txt": "not source code" });
    const graph = await parseDirectory(source, "solidity");
    expect(graph.nodes.size).toBe(0);
  });
});
