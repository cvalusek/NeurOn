import { timingSafeEqual } from "node:crypto";
import Fastify from "fastify";
import { z } from "zod";
import { RegisteredStopActionExecutor } from "./actions.js";
import { HassleOffRequestError, HassleOffService } from "./HassleOffService.js";
import { HassleOffStore } from "./store.js";
import { HASSLEOFF_PROTOCOL_VERSION } from "./types.js";
import type { HassleOffConfig, StopActionExecutor } from "./types.js";

const leaseSchema = z.object({
  protocolVersion: z.literal(HASSLEOFF_PROTOCOL_VERSION),
  targetId: z.string().min(1),
  controllerId: z.string().min(1),
  leaseId: z.string().min(1),
  sequence: z.number().int().positive(),
  issuedAt: z.string().min(1),
  expiresAt: z.string().min(1)
});

const holdSchema = z.object({
  protocolVersion: z.literal(HASSLEOFF_PROTOCOL_VERSION),
  targetId: z.string().min(1),
  until: z.string().min(1),
  reason: z.string().min(1).max(200)
});

const shutdownSchema = z.object({
  protocolVersion: z.literal(HASSLEOFF_PROTOCOL_VERSION),
  targetId: z.string().min(1),
  controllerId: z.string().min(1),
  requestId: z.string().min(1),
  reason: z.string().min(1).max(200)
});

const tripTestSchema = z.object({
  protocolVersion: z.literal(HASSLEOFF_PROTOCOL_VERSION),
  targetId: z.string().min(1)
});

export function buildHassleOffApp(
  config: HassleOffConfig,
  options: {
    store?: HassleOffStore;
    actionExecutor?: StopActionExecutor;
    clock?: () => Date;
    logger?: boolean;
  } = {}
) {
  const app = Fastify({ logger: options.logger ?? true });
  const store = options.store ?? new HassleOffStore(config.databasePath);
  const service = new HassleOffService(config, store, options.actionExecutor ?? new RegisteredStopActionExecutor(), options.clock);
  let interval: NodeJS.Timeout | undefined;

  app.addHook("preHandler", async (request, reply) => {
    if (request.url === "/healthz" || request.url === "/readyz") return;
    if (!authenticated(request.headers.authorization, config.controllerToken)) {
      return reply.code(401).send({ error: "HassleOff controller authentication required" });
    }
  });

  app.get("/healthz", async () => ({ ok: true, service: "hassleoff" }));
  app.get("/readyz", async (_request, reply) => {
    const status = service.status();
    return reply.code(service.ready ? 200 : 503).send({
      ok: service.ready,
      armed: service.armed,
      registrationIssues: status.service.registrationIssues
    });
  });

  app.get("/v1/status", async () => service.status());
  app.get("/v1/audit", async (request) => {
    const query = z.object({ targetId: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).optional() }).parse(request.query);
    return { protocolVersion: HASSLEOFF_PROTOCOL_VERSION, audit: service.audit(query.targetId, query.limit) };
  });

  app.put("/v1/targets/:targetId/lease", async (request, reply) => handle(reply, () => {
    const { targetId } = z.object({ targetId: z.string().min(1) }).parse(request.params);
    return service.acceptLease(targetId, leaseSchema.parse(request.body));
  }));

  app.post("/v1/targets/:targetId/maintenance-hold", async (request, reply) => handle(reply, () => {
    const { targetId } = z.object({ targetId: z.string().min(1) }).parse(request.params);
    const body = holdSchema.parse(request.body);
    return { protocolVersion: HASSLEOFF_PROTOCOL_VERSION, ...service.setMaintenanceHold(targetId, body) };
  }));

  app.post("/v1/targets/:targetId/shutdown", async (request, reply) => handle(reply, async () => {
    const { targetId } = z.object({ targetId: z.string().min(1) }).parse(request.params);
    return { protocolVersion: HASSLEOFF_PROTOCOL_VERSION, ...(await service.requestIntentionalShutdown(targetId, shutdownSchema.parse(request.body))) };
  }));

  app.post("/v1/targets/:targetId/trip-test", async (request, reply) => handle(reply, async () => {
    const { targetId } = z.object({ targetId: z.string().min(1) }).parse(request.params);
    return { protocolVersion: HASSLEOFF_PROTOCOL_VERSION, ...(await service.runSyntheticTripTest(targetId, tripTestSchema.parse(request.body))) };
  }));

  app.addHook("onClose", async () => {
    if (interval) clearInterval(interval);
    store.close();
  });

  const startWatchdog = () => {
    if (interval) return interval;
    void service.tick();
    interval = setInterval(() => void service.tick(), config.checkIntervalMs);
    return interval;
  };

  return { app, service, store, startWatchdog };
}

async function handle(reply: { code: (statusCode: number) => { send: (body: unknown) => unknown } }, action: () => unknown | Promise<unknown>) {
  try {
    return await action();
  } catch (error) {
    if (error instanceof HassleOffRequestError) return reply.code(error.statusCode).send({ error: error.message });
    if (error instanceof z.ZodError) return reply.code(400).send({ error: error.issues.map((issue) => issue.message).join("; ") });
    const message = error instanceof Error ? error.message : String(error);
    return reply.code(500).send({ error: message });
  }
}

function authenticated(header: string | undefined, expectedToken: string): boolean {
  const match = header?.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  const actual = Buffer.from(match[1], "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
