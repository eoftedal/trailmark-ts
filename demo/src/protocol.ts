/** Messages between the demo UI and the analysis worker. */

import type { GraphData } from "../../src/serialize.js";

export type WorkerRequest = { assetBase: string } & (
  | {
      type: "analyze";
      projectId: string;
      language: string;
      /** Either a directory handle (File System Access API) or files read from an <input>. */
      handle?: FileSystemDirectoryHandle;
      files?: { path: string; data: ArrayBuffer }[];
      root?: string;
    }
  | { type: "clear-cache" }
);

export type WorkerResponse =
  | { type: "progress"; language: string; filePath: string; done: number; cached: number }
  | { type: "status"; message: string }
  | { type: "done"; graph: GraphData; elapsedMs: number; files: number; cached: number }
  | { type: "error"; message: string };
