import { request } from "node:http";
import type { ControlResult, Control, Endpoint } from "./types.js";

// Local control transport only; credentials never appear in tool results.
export function control(endpoint: Endpoint, input: Control): Promise<ControlResult> {
  const diagnostic = (error: unknown) => error instanceof Error && error.message.startsWith("Subagent ") ? error :
    new Error(`Control ${input.type}, run ${endpoint.runId}, runtime ${endpoint.runtimeId ?? "legacy"}: ${error instanceof Error ? error.message : String(error)}`);
  if (endpoint.protocolVersion !== undefined && (endpoint.protocolVersion !== 2 || !endpoint.runtimeId))
    return Promise.reject(diagnostic("Unsupported or invalid worker control protocol"));
  if (endpoint.protocolVersion === undefined && (input.type === "start" || input.type === "interrupt" || input.type === "close" && input.onlyIdle))
    return Promise.reject(diagnostic("This operation requires a resident v2 worker; legacy workers are not hot-replaced"));
  return new Promise<ControlResult>((resolve, reject) => {
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
          else {
            if (value.receipt !== undefined) {
              const receipt = value.receipt;
              const operation = input.type === "close" ? "stop" : input.type;
              const statuses = operation === "start" ? ["accepted", "unconfirmed"] : operation === "send" ? ["accepted", "queued", "unconfirmed"] :
                operation === "interrupt" ? ["settled", "not_running", "unconfirmed"] : operation === "stop" ? ["released", "unconfirmed"] : [];
              if (!receipt || receipt.operation !== operation || !statuses.includes(receipt.status) || receipt.runId !== value.runId ||
                receipt.runtimeId !== endpoint.runtimeId || receipt.runtimeId !== value.runtimeId || input.type !== "start" && receipt.runId !== endpoint.runId)
                throw new Error("Invalid worker operation receipt; outcome is uncertain. Inspect before retrying.");
            }
            resolve(value);
          }
        } catch (error) { reject(error); }
      });
    });
    req.setTimeout(35_000, () => req.destroy(new Error("Control request timed out; acceptance is uncertain. Inspect the instance before retrying.")));
    req.on("error", reject);
    req.end(JSON.stringify({ ...input, ...(endpoint.protocolVersion === 2 ? {
      protocolVersion: 2, runtimeId: endpoint.runtimeId, expectedRunId: endpoint.runId,
    } : {}) }));
  }).catch(error => { throw diagnostic(error); });
}
