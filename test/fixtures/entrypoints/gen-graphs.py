"""Generate hand-built graph fixtures for test/entrypoints.test.ts.

For languages whose parser is not ported to TypeScript yet, the entrypoint
tests run detection on a graph recorded from the upstream Python parser.
Each case stores the input files, the parsed graph (pre-detection), and the
upstream ``attack_surface()`` for a differential check.

Usage (from the upstream checkout, which has a working ``uv`` env):

    cd $UPSTREAM && uv run python <this file> > <trailmark-ts>/test/fixtures/entrypoints/graphs.json
"""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

import trailmark.parse as parse_api
from trailmark.query.api import QueryEngine


def _servlet(m: str) -> dict[str, str]:
    return {"C.java": f"class C extends HttpServlet {{\n    public void {m}() {{}}\n}}\n"}


CASES: list[tuple[str, str, dict[str, str]]] = [
    # --- test_entrypoints.py ---
    ("move_public_entry", "move", {"m.move": "module 0x1::m { public entry fun main(account: &signer) { } }\n"}),
    (
        "tact_receivers",
        "tact",
        {"wallet.tact": 'contract Wallet { init(owner: Address) { } receive("ping") { } }\n'},
    ),
    (
        "func_receivers",
        "func",
        {"wallet.fc": "() recv_internal() impure { }\nint get_balance() method_id { return 1; }\n"},
    ),
    (
        "sway_abi",
        "sway",
        {
            "wallet.sw": "contract;\nabi Wallet { fn deposit(amount: u64); }\n"
            "pub fn helper(amount: u64) -> u64 { amount }\n"
        },
    ),
    (
        "rego_rules",
        "rego",
        {"policy.rego": 'package example.auth\nallow if { true }\ndeny[msg] if { msg := "no" }\n'},
    ),
]

_SCHEMA_FILES = {
    "auth.proto": 'syntax = "proto3"; package example.auth; '
    "service Auth { rpc Login (Request) returns (Response); } "
    "message Request { string token = 1; } message Response { bool ok = 1; }\n",
    "auth.thrift": "namespace py example.auth\n"
    "struct Request { 1: string token }\n"
    "service Auth { bool login(1: Request req) }\n",
    "schema.graphql": "type Query { user(id: ID!): User }\ntype User { id: ID! }\n",
}
CASES += [(f"schema_{lang}", lang, _SCHEMA_FILES) for lang in ("proto", "thrift", "graphql")]

CASES += [
    (
        "rust_actix_get",
        "rust",
        {
            "server.rs": "use actix_web::{get, Responder};\n\n"
            '#[get("/users/{id}")]\n'
            "async fn get_user() -> impl Responder {\n"
            '    "ok"\n'
            "}\n"
        },
    ),
    (
        "rust_no_mangle",
        "rust",
        {"ffi.rs": '#[no_mangle]\npub extern "C" fn add_one(x: i32) -> i32 {\n    x + 1\n}\n'},
    ),
    (
        "sol_external",
        "solidity",
        {
            "Vault.sol": "// SPDX-License-Identifier: MIT\npragma solidity ^0.8.0;\ncontract Vault {\n"
            "    function withdraw(uint256 amount) external {\n    }\n}\n"
        },
    ),
    (
        "sol_public",
        "solidity",
        {
            "Token.sol": "// SPDX-License-Identifier: MIT\npragma solidity ^0.8.0;\ncontract Token {\n"
            "    function balanceOf(address who) public view returns (uint256) {\n"
            "        return 0;\n    }\n}\n"
        },
    ),
    (
        "sol_internal",
        "solidity",
        {
            "Lib.sol": "// SPDX-License-Identifier: MIT\npragma solidity ^0.8.0;\ncontract Lib {\n"
            "    function _helper(uint256 x) internal pure returns (uint256) {\n"
            "        return x + 1;\n    }\n}\n"
        },
    ),
    (
        "sol_fallback_receive",
        "solidity",
        {
            "Wallet.sol": "// SPDX-License-Identifier: MIT\npragma solidity ^0.8.0;\ncontract Wallet {\n"
            "    receive() external payable {}\n    fallback() external payable {}\n}\n"
        },
    ),
    (
        "ts_nestjs",
        "typescript",
        {
            "users.controller.ts": "import { Controller, Get } from '@nestjs/common';\n\n"
            "@Controller('users')\nexport class UsersController {\n"
            "  @Get(':id')\n  findOne(id: string) {\n    return { id };\n  }\n}\n"
        },
    ),
    (
        "ts_nextjs_app_router",
        "typescript",
        {
            "route.ts": "export async function GET(request: Request) {\n"
            "  return new Response('ok');\n}\n"
            "export async function POST(request: Request) {\n"
            "  return new Response('created');\n}\n"
        },
    ),
    (
        "java_spring",
        "java",
        {
            "UserController.java": "import org.springframework.web.bind.annotation.*;\n\n"
            "@RestController\npublic class UserController {\n"
            '    @GetMapping("/users/{id}")\n'
            "    public User get(@PathVariable long id) {\n        return null;\n    }\n}\n"
        },
    ),
    (
        "java_jaxrs",
        "java",
        {
            "Resource.java": "import javax.ws.rs.*;\n\n"
            '@Path("/users")\npublic class UserResource {\n'
            "    @GET\n"
            '    @Path("/{id}")\n'
            '    public User get(@PathParam("id") long id) {\n        return null;\n    }\n}\n'
        },
    ),
    (
        "cs_aspnet",
        "c_sharp",
        {
            "UsersController.cs": "using Microsoft.AspNetCore.Mvc;\n\n"
            '[ApiController]\n[Route("api/[controller]")]\n'
            "public class UsersController : ControllerBase {\n"
            '    [HttpGet("{id}")]\n'
            "    public IActionResult Get(int id) {\n        return Ok();\n    }\n}\n"
        },
    ),
    (
        "php_symfony",
        "php",
        {
            "ProductController.php": "<?php\nnamespace App\\Controller;\n\n"
            "use Symfony\\Component\\Routing\\Annotation\\Route;\n\n"
            "class ProductController {\n"
            "    #[Route('/products', methods: ['GET'])]\n"
            "    public function list() {\n        return [];\n    }\n}\n"
        },
    ),
    (
        "erlang_export",
        "erlang",
        {
            "auth.erl": "-module(auth).\n-export([login/2, logout/1]).\n\n"
            "login(User, Pass) -> ok.\nlogout(User) -> ok.\ninternal_only() -> ok.\n"
        },
    ),
    ("swift_main", "swift", {"app.swift": "@main\nstruct App {\n    static func main() {}\n}\n"}),
    (
        "objc_app_delegate",
        "objc",
        {
            "AppDelegate.m": "#import <UIKit/UIKit.h>\n@interface AppDelegate : NSObject\n"
            "- (BOOL)application:(UIApplication *)app "
            "didFinishLaunchingWithOptions:(NSDictionary *)opts;\n"
            "@end\n@implementation AppDelegate\n"
            "- (BOOL)application:(UIApplication *)app "
            "didFinishLaunchingWithOptions:(NSDictionary *)opts {\n"
            "    return YES;\n}\n@end\n"
        },
    ),
    (
        "objc_non_app",
        "objc",
        {
            "Foo.m": "@interface Foo : NSObject\n- (void)helper;\n@end\n"
            "@implementation Foo\n- (void)helper { }\n@end\n"
        },
    ),
    (
        "kotlin_spring",
        "kotlin",
        {
            "UserController.kt": "import org.springframework.web.bind.annotation.*\n\n"
            "@RestController\nclass UserController {\n"
            '    @GetMapping("/users/{id}")\n'
            '    fun get(id: Long): String { return "ok" }\n}\n'
        },
    ),
    (
        "kotlin_android",
        "kotlin",
        {
            "MainActivity.kt": "package com.example\n\nclass MainActivity {\n"
            "    fun onCreate(bundle: Bundle?) {\n        super.onCreate(bundle)\n    }\n}\n"
        },
    ),
    ("kotlin_helper", "kotlin", {"Util.kt": "class Util {\n    fun helper(x: Int): Int { return x + 1 }\n}\n"}),
    (
        "dart_vm_entry",
        "dart",
        {"callbacks.dart": "@pragma('vm:entry-point')\nvoid nativeCallback(String data) {\n  print(data);\n}\n"},
    ),
    ("dart_plain", "dart", {"util.dart": "void log(String s) { print(s); }\n"}),
    ("dart_main", "dart", {"app.dart": "void main() { print('hi'); }\n"}),
    (
        "go_handlefunc",
        "go",
        {
            "server.go": 'package main\nimport "net/http"\n\n'
            "func loginHandler(w http.ResponseWriter, r *http.Request) {}\n\n"
            'func main() {\n    http.HandleFunc("/login", loginHandler)\n}\n'
        },
    ),
    (
        "go_gin",
        "go",
        {
            "app.go": 'package main\nimport "github.com/gin-gonic/gin"\n\n'
            "func getUser(c *gin.Context) {}\n\n"
            'func main() {\n    r := gin.Default()\n    r.GET("/users/:id", getUser)\n}\n'
        },
    ),
    (
        "ruby_rails",
        "ruby",
        {
            "users_controller.rb": "class UsersController < ApplicationController\n"
            "  def show\n    @user = User.find(params[:id])\n  end\n\n"
            "  def create\n    User.create(params[:user])\n  end\nend\n"
        },
    ),
    ("ruby_util", "ruby", {"util.rb": "class Util\n  def helper(x)\n    x + 1\n  end\nend\n"}),
    (
        "ruby_sidekiq",
        "ruby",
        {
            "mailer.rb": "class EmailWorker\n  include Sidekiq::Worker\n\n"
            "  def perform(user_id)\n    puts user_id\n  end\nend\n"
        },
    ),
    ("cpp_extern_c", "cpp", {"api.cpp": 'extern "C" int add_one(int x) {\n    return x + 1;\n}\n'}),
    ("c_dllexport", "c", {"lib.c": "__declspec(dllexport)\nint compute(int x) {\n    return x * 2;\n}\n"}),
    ("c_plain", "c", {"util.c": "int helper(int x) {\n    return x + 1;\n}\n"}),
    (
        "php_glob",
        "php",
        {
            "public_html/index.php": "<?php\nfunction index() { return 1; }\n",
            "public_html/admin/login.php": "<?php\nfunction login() { return 2; }\n",
            "lib.php": "<?php\nfunction helper() { return 3; }\n",
            ".trailmark/entrypoints.toml": "[[entrypoint]]\n"
            'file_glob = "public_html/**/*.php"\n'
            'kind = "user_input"\n'
            'trust = "untrusted_external"\n'
            'asset_value = "high"\n'
            'description = "Web-exposed PHP"\n',
        },
    ),
]

# --- test_detector_tags.py ---
for annotation in ["GetMapping", "PostMapping", "PutMapping", "DeleteMapping", "PatchMapping", "RequestMapping"]:
    CASES.append(
        (
            f"tags_java_{annotation}",
            "java",
            {"C.java": f'class C {{\n    @{annotation}("/x")\n    public void f() {{}}\n}}\n'},
        )
    )
for verb in ["GET", "POST", "PUT", "DELETE", "PATCH"]:
    CASES.append((f"tags_jaxrs_{verb}", "java", {"C.java": f"class C {{\n    @{verb}\n    public void f() {{}}\n}}\n"}))
CASES.append(
    (
        "tags_kafka",
        "java",
        {"C.java": 'class C {\n    @KafkaListener(topics = "x")\n    public void consume() {}\n}\n'},
    )
)
for method in ["doGet", "doPost", "doPut", "doDelete", "doHead", "doOptions", "doTrace"]:
    CASES.append((f"tags_servlet_{method}", "java", _servlet(method)))
for verb in ["get", "post", "put", "patch", "delete", "head", "options"]:
    CASES.append((f"tags_actix_{verb}", "rust", {"h.rs": f'#[{verb}("/x")]\nasync fn handler() {{}}\n'}))
CASES.append(("tags_no_mangle", "rust", {"ffi.rs": '#[no_mangle]\npub extern "C" fn expose() {}\n'}))
for attr in ["HttpGet", "HttpPost", "HttpPut", "HttpDelete", "HttpPatch"]:
    CASES.append(
        (
            f"tags_aspnet_{attr}",
            "c_sharp",
            {"Ctl.cs": f'public class Ctl {{\n    [{attr}("/x")]\n    public object F() => null;\n}}\n'},
        )
    )
CASES.append(
    ("tags_azure", "c_sharp", {"Fn.cs": 'public class Fn {\n    [Function("run")]\n    public object Run() => null;\n}\n'})
)
for vis in ["external", "public"]:
    CASES.append(
        (
            f"tags_sol_{vis}",
            "solidity",
            {
                "C.sol": "// SPDX-License-Identifier: MIT\npragma solidity ^0.8.0;\ncontract C {\n"
                f"    function act() {vis} {{}}\n}}\n"
            },
        )
    )
CASES.append(
    ("tags_sol_interface", "solidity", {"I.sol": "interface I { function inspect() external view returns (uint); }\n"})
)
CASES.append(
    (
        "tags_sol_mutability",
        "solidity",
        {"C.sol": "contract C { function inspect() external view returns (uint) { return 1; } }\n"},
    )
)
CASES.append(
    (
        "tags_sol_override",
        "solidity",
        {
            "C.sol": "contract Base { function act(uint x) public virtual {} }\n"
            "contract Derived is Base { function act(uint x) public override {} }\n"
        },
    )
)
for verb in ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"]:
    CASES.append(
        (
            f"tags_nextjs_{verb}",
            "typescript",
            {"route.ts": f"export async function {verb}(req: Request) {{ return new Response(); }}\n"},
        )
    )
CASES.append(("tags_swift_main", "swift", {"app.swift": "@main\nstruct App { static func main() {} }\n"}))
CASES.append(
    (
        "tags_objc_openurl",
        "objc",
        {
            "AppDelegate.m": "@interface AppDelegate : NSObject\n"
            "- (BOOL)application:(UIApplication *)app "
            "openURL:(NSURL *)url options:(NSDictionary *)opts;\n"
            "@end\n@implementation AppDelegate\n"
            "- (BOOL)application:(UIApplication *)app "
            "openURL:(NSURL *)url options:(NSDictionary *)opts { return YES; }\n@end\n"
        },
    )
)
CASES.append(("tags_kotlin_spring", "kotlin", {"C.kt": 'class C {\n    @GetMapping("/x")\n    fun f(): String = "ok"\n}\n'}))
for method in [
    "onCreate",
    "onStart",
    "onResume",
    "onNewIntent",
    "onActivityResult",
    "onReceive",
    "onBind",
    "onHandleIntent",
]:
    CASES.append((f"tags_android_{method}", "kotlin", {"A.kt": f"class Activity {{\n    fun {method}() {{}}\n}}\n"}))
CASES.append(("tags_dart_vm", "dart", {"callbacks.dart": "@pragma('vm:entry-point')\nvoid fn() {}\n"}))
CASES.append(("tags_cpp_extern_c", "cpp", {"api.cpp": 'extern "C" int expose(int x) { return x; }\n'}))


def _rel(path: str, root: str) -> str:
    return str(Path(path).relative_to(root)) if path.startswith(root) else path


def _graph_spec(tmp: str, language: str) -> dict[str, object]:
    graph = parse_api.parse_directory(tmp, language=language)
    nodes = []
    for unit in graph.nodes.values():
        loc = unit.location
        nodes.append(
            [
                unit.id,
                unit.name,
                unit.kind.value,
                _rel(loc.file_path, tmp + "/"),
                loc.start_line,
                loc.end_line,
                [list(a) for a in unit.attributes],
                [p.type_ref.name if p.type_ref else None for p in unit.parameters],
            ]
        )
    edges = [
        [e.source_id, e.target_id, e.kind.value]
        for e in graph.edges
        if e.kind.value in ("contains", "inherits")
    ]
    return {"nodes": nodes, "edges": edges}


def main() -> None:
    out: dict[str, object] = {}
    for key, language, files in CASES:
        with tempfile.TemporaryDirectory() as tmp:
            tmp = str(Path(tmp).resolve())
            for rel, text in files.items():
                p = Path(tmp) / rel
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_text(text)
            spec = _graph_spec(tmp, language)
            surface = QueryEngine.from_directory(tmp, language=language).attack_surface()
            out[key] = {"language": language, "files": files, **spec, "surface": surface}
    json.dump(out, sys.stdout, indent=1, sort_keys=True)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
