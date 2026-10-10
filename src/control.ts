import { request } from "node:http";
import type { AgentState, Control, Endpoint } from "./types.js";

// Local control transport only; credentials never appear in tool results.
export function control(endpoint: Endpoint, input: Control): Promise<AgentState> {
  if (endpoint.protocolVersion !== undefined && (endpoint.protocolVersion !== 2 || !endpoint.runtimeId))
    return Promise.reject(new Error("Unsupported or invalid worker control protocol"));
  if (endpoint.protocolVersion === undefined && (input.type === "start" || input.type === "interrupt" || input.type === "close" && input.onlyIdle))
    return Promise.reject(new Error("This operation requires a resident v2 worker; legacy workers are not hot-replaced"));
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
          if (res.statusCode !== 200) reject(new Error(value.error ?? `Control endpoint HTTP ${res.statusCode}`));
          else resolve(value);
        } catch (error) { reject(error); }
      });
    });
    req.setTimeout(35_000, () => req.destroy(new Error("Control request timed out; acceptance is uncertain. Inspect the instance before retrying.")));
    req.on("error", reject);
    req.end(JSON.stringify({ ...input, ...(endpoint.protocolVersion === 2 ? {
      protocolVersion: 2, runtimeId: endpoint.runtimeId, expectedRunId: endpoint.runId,
    } : {}) }));
  });
}
