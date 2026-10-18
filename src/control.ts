import { request } from "node:http";
import type { ControlResult, Control, Endpoint } from "./types.js";

/** A completed worker rejection, not a lost response or proof that no side effects occurred. */
export class ControlRejectedError extends Error {}

// Local control transport only; credentials never appear in tool results.
export function control(endpoint: Endpoint, input: Control): Promise<ControlResult> {
  const diagnostic = (error: unknown) => error instanceof ControlRejectedError || error instanceof Error && error.message.startsWith("Subagent ") ? error :
    new Error(`Control ${input.type}, run ${endpoint.runId}, runtime ${endpoint.runtimeId ?? "missing"}: ${error instanceof Error ? error.message : String(error)}`);
  if (endpoint.protocolVersion !== 3)
    return Promise.reject(diagnostic("Unsupported worker protocol; only v3 is supported. Old records are read-only; manually stop verified old processes. No migration or forced takeover."));
  if (!endpoint.runtimeId) return Promise.reject(diagnostic("Invalid worker runtime identity"));
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
          if (res.statusCode !== 200) reject(new ControlRejectedError(diagnostic(value.error ?? `Control endpoint HTTP ${res.statusCode}`).message));
          else {
            if (value.protocolVersion !== 3 || value.runtimeId !== endpoint.runtimeId) throw new Error("Invalid worker response identity; outcome is uncertain. Inspect before retrying.");
            if (!["status", "reply"].includes(input.type) || value.receipt !== undefined) {
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
    req.end(JSON.stringify({ ...input, protocolVersion: 3, runtimeId: endpoint.runtimeId, expectedRunId: endpoint.runId }));
  }).catch(error => { throw diagnostic(error); });
}
