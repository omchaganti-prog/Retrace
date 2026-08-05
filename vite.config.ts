import { type Plugin, defineConfig, loadEnv } from "vite";

/**
 * Exposes POST /api/mimic/strategy during `npm run dev` (and `npm run preview`).
 *
 * The Anthropic key is read here, in the Node process, and never reaches the
 * bundle — the browser only ever sees the resulting strategy object. Without a
 * key the endpoint still answers, with `{ ok: false, reason: "no_api_key" }`,
 * and the game falls back to its local learning model.
 */
function mimicStrategistPlugin(env: Record<string, string>): Plugin {
  const route = "/api/mimic/strategy";
  const attach = async (server: { middlewares: { use: Function } }) => {
    const { strategyMiddleware } = await import("./server/mimic-strategist.mjs");
    const handler = strategyMiddleware({ ...process.env, ...env });
    server.middlewares.use(route, (req: any, res: any, next: any) => {
      handler(req, res).catch(next);
    });
  };

  return {
    name: "retrace:mimic-strategist",
    configureServer: attach,
    configurePreviewServer: attach,
  };
}

export default defineConfig(({ mode }) => {
  // Third arg "" loads every key, not just VITE_-prefixed ones. These stay
  // server-side; nothing here is injected into client code.
  const env = loadEnv(mode, process.cwd(), "");
  return {
    plugins: [mimicStrategistPlugin(env)],
    server: { port: 5173, open: true },
    build: { target: "es2022", sourcemap: true },
    define: {
      __MIMIC_ENDPOINT__: JSON.stringify("/api/mimic/strategy"),
    },
  };
});
