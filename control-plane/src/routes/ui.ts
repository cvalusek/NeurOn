import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppConfig } from "../domain/types.js";
import { SharedPasswordAuthProvider } from "../auth/SharedPasswordAuthProvider.js";
import { ModelCatalog } from "../services/ModelCatalog.js";
import { ReservationService } from "../services/ReservationService.js";
import { adminPage, loginPage, reservationPage, startPage } from "../ui/html.js";
import { requireUser } from "../utils/http.js";

export function registerUiRoutes(
  app: FastifyInstance,
  config: AppConfig,
  authProvider: SharedPasswordAuthProvider,
  catalog: ModelCatalog,
  reservationService: ReservationService
) {
  app.get("/login", async (_request, reply) => reply.type("text/html").send(loginPage()));
  app.post("/login", async (request, reply) => {
    const body = z.object({ username: z.string().min(1), password: z.string() }).parse(request.body);
    if (body.password !== config.sharedPassword || !config.cookieSecret) return reply.code(401).type("text/html").send(loginPage("Invalid credentials"));
    reply.setCookie("llm_control_auth", authProvider.createCookie(body.username), { path: "/", httpOnly: true, sameSite: "lax" });
    return reply.redirect("/");
  });

  app.get("/", async (request, reply) => {
    const query = z.object({ error: z.string().optional() }).parse(request.query);
    const targets = catalog.listTargets().map((target) => ({ target, models: catalog.listModelsForTarget(target.id) }));
    return reply.type("text/html").send(startPage(requireUser(request), targets, query.error));
  });
  app.post("/reservations", async (request, reply) => {
    try {
      const raw = z
        .object({
          modelIds: z.union([z.string(), z.array(z.string())]).optional(),
          targetId: z.string(),
          durationMinutes: z.coerce.number()
        })
        .parse(request.body);
      const modelIds = raw.modelIds ? (Array.isArray(raw.modelIds) ? raw.modelIds : [raw.modelIds]) : [];
      await reservationService.createForUser(requireUser(request), { modelIds, targetIds: [raw.targetId], durationMinutes: raw.durationMinutes });
      return reply.redirect("/");
    } catch (error) {
      const message = reservationFormErrorMessage(error);
      return reply.redirect(`/?error=${encodeURIComponent(message)}`);
    }
  });
  app.get("/reservations/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const reservation = await reservationService.getOwned(id, requireUser(request));
    return reply.type("text/html").send(reservationPage(requireUser(request), reservation, config));
  });
  app.post("/reservations/:id/done", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    await reservationService.markDone(id, requireUser(request));
    return reply.redirect("/");
  });
  app.post("/reservations/:id/extend", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({ durationMinutes: z.coerce.number() }).parse(request.body);
    await reservationService.extend(id, requireUser(request), body.durationMinutes);
    return reply.redirect("/");
  });
  app.get("/admin", async (request, reply) => reply.type("text/html").send(adminPage(requireUser(request), config)));
}

function reservationFormErrorMessage(error: unknown): string {
  if (error instanceof z.ZodError && error.issues.some((issue) => issue.path.includes("modelIds"))) {
    return "Select at least one model";
  }
  if (error instanceof Error && error.message.includes("At least one model")) {
    return "Select at least one model";
  }
  if (error instanceof Error && error.message.includes("At least one target")) {
    return "Select a target";
  }
  if (error instanceof Error && error.message.includes("Duration")) {
    return error.message;
  }
  return "Could not create reservation";
}
