import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ReservationRepository, TargetStatusRepository } from "../domain/interfaces.js";
import { ModelCatalog } from "../services/ModelCatalog.js";
import { ReservationService } from "../services/ReservationService.js";
import { requireUser, reservationDisplayUsername, reservationJson, targetJson } from "../utils/http.js";

const jsonRpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0").default("2.0"),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string(),
  params: z.unknown().optional()
});

const createReservationParamsSchema = z.object({
  modelIds: z.array(z.string()).optional(),
  targetIds: z.array(z.string()).optional(),
  durationMinutes: z.number(),
  keepaliveMinutes: z.number().optional()
});

const reservationIdParamsSchema = z.object({ reservationId: z.string() });

export function registerMcpRoutes(
  app: FastifyInstance,
  catalog: ModelCatalog,
  reservations: ReservationRepository,
  statuses: TargetStatusRepository,
  reservationService: ReservationService
) {
  app.post(
    "/mcp",
    {
      schema: {
        tags: ["mcp"],
        summary: "Model Context Protocol JSON-RPC endpoint",
        security: [{ bearerAuth: [] }, { basicAuth: [] }],
        body: {
          type: "object",
          required: ["method"],
          properties: {
            jsonrpc: { type: "string", enum: ["2.0"], default: "2.0" },
            id: { anyOf: [{ type: "string" }, { type: "number" }, { type: "null" }] },
            method: { type: "string" },
            params: {}
          }
        },
        response: {
          200: {
            type: "object",
            properties: {
              jsonrpc: { type: "string" },
              id: {},
              result: {},
              error: {
                type: "object",
                properties: {
                  code: { type: "number" },
                  message: { type: "string" },
                  data: {}
                }
              }
            }
          }
        }
      }
    },
    async (request) => {
      const parsed = jsonRpcRequestSchema.safeParse(request.body);
      if (!parsed.success) return rpcError(undefined, -32600, "Invalid request", parsed.error.flatten());
      const rpc = parsed.data;
      try {
        const result = await handleMcpMethod(rpc.method, rpc.params, requireUser(request), catalog, reservations, statuses, reservationService);
        return { jsonrpc: "2.0", id: rpc.id ?? null, result };
      } catch (error) {
        return rpcError(rpc.id ?? null, error instanceof UnknownMcpMethodError ? -32601 : -32602, error instanceof Error ? error.message : String(error));
      }
    }
  );
}

async function handleMcpMethod(
  method: string,
  params: unknown,
  user: ReturnType<typeof requireUser>,
  catalog: ModelCatalog,
  reservations: ReservationRepository,
  statuses: TargetStatusRepository,
  reservationService: ReservationService
) {
  if (method === "initialize") {
    return {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "neuron-control-plane", version: "0.1.0" }
    };
  }
  if (method === "tools/list") return { tools: mcpTools() };
  if (method !== "tools/call") throw new UnknownMcpMethodError(`Unknown MCP method: ${method}`);

  const call = z.object({ name: z.string(), arguments: z.record(z.unknown()).default({}) }).parse(params ?? {});
  const result = await callTool(call.name, call.arguments, user, catalog, reservations, statuses, reservationService);
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    structuredContent: result
  };
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
  user: ReturnType<typeof requireUser>,
  catalog: ModelCatalog,
  reservations: ReservationRepository,
  statuses: TargetStatusRepository,
  reservationService: ReservationService
) {
  if (name === "list_models") return { models: catalog.listModels() };
  if (name === "list_targets") return { capacityTargets: await targetsPayload(catalog, reservations, statuses) };
  if (name === "get_status") return statusPayload(catalog, reservations, statuses);
  if (name === "create_reservation") {
    const input = createReservationParamsSchema.parse(args);
    return reservationJson(await reservationService.createForUser(user, input), statuses.list());
  }
  if (name === "end_reservation") {
    const input = reservationIdParamsSchema.parse(args);
    const reservation = await reservations.get(input.reservationId);
    if (!reservation || reservation.username !== user.username) throw new Error("Reservation not found");
    return reservationJson(await reservationService.markDone(input.reservationId, user), statuses.list());
  }
  throw new Error(`Unknown MCP tool: ${name}`);
}

function mcpTools() {
  return [
    {
      name: "list_models",
      description: "List configured and discovered NeurOn models.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false }
    },
    {
      name: "list_targets",
      description: "List NeurOn capacity targets and current runtime state.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false }
    },
    {
      name: "get_status",
      description: "Get current reservations and capacity target status.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false }
    },
    {
      name: "create_reservation",
      description: "Create a reservation for models or explicit capacity targets.",
      inputSchema: {
        type: "object",
        required: ["durationMinutes"],
        properties: {
          modelIds: { type: "array", items: { type: "string" } },
          targetIds: { type: "array", items: { type: "string" } },
          durationMinutes: { type: "number" },
          keepaliveMinutes: { type: "number" }
        }
      }
    },
    {
      name: "end_reservation",
      description: "Mark one of your own reservations done.",
      inputSchema: {
        type: "object",
        required: ["reservationId"],
        properties: { reservationId: { type: "string" } },
        additionalProperties: false
      }
    }
  ];
}

async function statusPayload(catalog: ModelCatalog, reservations: ReservationRepository, statuses: TargetStatusRepository) {
  const activeReservations = await reservations.listActive(new Date());
  return {
    reservations: activeReservations.map((reservation) => reservationJson(reservation, statuses.list())),
    activeReservations: activeReservations.map((reservation) => reservationJson(reservation, statuses.list())),
    capacityTargets: await targetsPayload(catalog, reservations, statuses)
  };
}

async function targetsPayload(catalog: ModelCatalog, reservations: ReservationRepository, statuses: TargetStatusRepository) {
  const active = await reservations.listActive(new Date());
  return catalog.listTargets().map((target) =>
    targetJson(
      target,
      statuses.get(target.id),
      Array.from(new Set(active.filter((reservation) => reservation.targetIds.includes(target.id)).map(reservationDisplayUsername)))
    )
  );
}

function rpcError(id: string | number | null | undefined, code: number, message: string, data?: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message, data } };
}

class UnknownMcpMethodError extends Error {}
