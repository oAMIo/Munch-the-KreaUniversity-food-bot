/**
 * Local trigger for manual posts, used by the `plato-post` command.
 *
 * Listens on 127.0.0.1 only (CONTROL_PORT, default 8717), so only someone
 * logged in to this server can use it. POST /post?meal=dinner[&force=1]
 * posts that meal's menu now and answers with what happened.
 */

import { createServer } from "http";
import type { MealName } from "./config";
import { postMenuJob, type AppState } from "./jobs";
import { logger } from "./logger";

const MEALS = ["breakfast", "lunch", "snack", "dinner"];

export function startControlServer(state: AppState): void {
  const port = Number(process.env.CONTROL_PORT ?? 8717);
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const reply = (code: number, body: object) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method !== "POST" || url.pathname !== "/post") return reply(404, { error: "not found" });
    const meal = url.searchParams.get("meal") ?? "";
    if (!MEALS.includes(meal)) return reply(400, { error: `meal must be one of ${MEALS.join(", ")}` });
    const force = url.searchParams.get("force") === "1";
    logger.info({ meal, force }, "Manual post requested.");
    postMenuJob(state, meal as MealName, force).then(
      (result) => reply(result === "posted" ? 200 : 409, { result }),
      () => reply(500, { result: "failed" }),
    );
  });
  server.on("error", (err) => logger.error({ err }, "Control server failed; plato-post won't work."));
  server.listen(port, "127.0.0.1", () => logger.info(`Manual-post trigger listening on 127.0.0.1:${port}.`));
}
