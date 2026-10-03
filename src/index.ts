import { Hono } from "hono";
import { cors } from "hono/cors";

const app = new Hono<{ Bindings: CloudflareBindings }>();

app.use("/api/*", cors());

app.get("/api/health", (c) => {
  return c.json({ ok: true });
});

app.get("/api/message", (c) => {
  return c.json({ message: "Hello from Slop-Backend!" });
});

export default app;
