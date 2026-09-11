import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { NormalizedHotChannelClient, Plugin, ViteDevServer } from "vite";

const FRAME = "huddol:frame";
const REQUEST = "huddol:request";
const SHUTDOWN_TIMEOUT = 10_000;

type Frame = { type: string; id?: number } & Record<string, unknown>;

type Request = {
  id?: number;
  method: string;
  params?: Record<string, unknown>;
};

type Route = { client: NormalizedHotChannelClient; id: number };

type Kernel = {
  request(request: Request, client: NormalizedHotChannelClient): void;
  stop(): Promise<void>;
};

export function kernel(): Plugin {
  let running: Kernel | null = null;
  return {
    name: "huddol-kernel",
    apply: "serve",
    configureServer(server) {
      server.ws.on(REQUEST, (request: Request, client) => {
        running ??= start(server);
        running.request(request, client);
      });
    },
    async closeBundle() {
      const stopping = running;
      running = null;
      await stopping?.stop();
    },
  };
}

function start(server: ViteDevServer): Kernel {
  const { logger } = server.config;
  const dataDirectory = join(tmpdir(), "huddol-dev");
  const child = spawn(
    "uv",
    [
      "run",
      "--project",
      resolve(server.config.root, "../core"),
      "python",
      "-m",
      "huddol",
    ],
    { env: { ...process.env, HUDDOL_DATA_DIR: dataDirectory } },
  );
  logger.info(`Huddol kernel starting with data in ${dataDirectory}`);
  const routes = new Map<number, Route>();
  let nextId = 1;
  let closed = false;

  const disconnect = (reason: string) => {
    if (closed) return;
    closed = true;
    routes.clear();
    logger.warn(`Huddol kernel disconnected: ${reason}`);
    server.ws.send(FRAME, { type: "bridge.disconnected" });
  };

  createInterface({ input: child.stdout }).on("line", (line) => {
    if (closed) return;
    let frame: Frame;
    try {
      frame = JSON.parse(line);
    } catch {
      child.kill();
      disconnect("unreadable output");
      return;
    }
    if (frame.type === "response" && typeof frame.id === "number") {
      const route = routes.get(frame.id);
      routes.delete(frame.id);
      if (route) route.client.send(FRAME, { ...frame, id: route.id });
      return;
    }
    server.ws.send(FRAME, frame);
  });
  createInterface({ input: child.stderr }).on("line", (line) =>
    logger.warn(`Huddol kernel: ${line}`),
  );
  child.stdin.on("error", (error) => disconnect(error.message));
  child.on("error", (error) => disconnect(error.message));
  child.on("close", (code, signal) => disconnect(`exited (${signal ?? code})`));

  return {
    request(request, client) {
      if (closed) {
        client.send(FRAME, { type: "bridge.disconnected" });
        return;
      }
      const id = nextId++;
      if (typeof request.id === "number")
        routes.set(id, { client, id: request.id });
      child.stdin.write(`${JSON.stringify({ ...request, id })}\n`);
    },
    stop() {
      return new Promise<void>((done) => {
        if (closed) {
          done();
          return;
        }
        closed = true;
        routes.clear();
        const timer = setTimeout(() => child.kill(), SHUTDOWN_TIMEOUT);
        child.once("close", () => {
          clearTimeout(timer);
          done();
        });
        child.stdin.end(
          `${JSON.stringify({ id: nextId++, method: "system.shutdown", params: {} })}\n`,
        );
      });
    },
  };
}
