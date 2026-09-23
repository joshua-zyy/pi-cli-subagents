import { request } from "node:http";
import type { AgentState, Control, Endpoint } from "./types.js";

// Local control transport only; credentials never appear in tool results.
export function control(endpoint: Endpoint, input: Control): Promise<AgentState> {
  return new Promise((resolve, reject) => {
    const req = request({
      hostname: "127.0.0.1", port: endpoint.port, path: "/", method: "POST", agent: false,
      headers: { "content-type": "application/json", authorization: `Bearer ${endpoint.token}` },
    }, (res) => {
      res.setEncoding("utf8"); let body = "";
      res.on("data", (chunk: string) => { body += chunk; });
      res.on("error", reject);
      res.on("end", () => {
        try {
          const value = JSON.parse(body);
          if (res.statusCode !== 200) reject(new Error(value.error ?? `控制端 HTTP ${res.statusCode}`));
          else resolve(value);
        } catch (error) { reject(error); }
      });
    });
    req.setTimeout(35_000, () => req.destroy(new Error("控制请求超时，受理情况未知；请检查实例，不要直接重发。")));
    req.on("error", reject);
    req.end(JSON.stringify(input));
  });
}
