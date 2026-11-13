import type { z } from "zod";
import type { Env } from "./env";
import { PipelineError, fetchWithTimeout, log, now } from "./util";

/**
 * Gemini client for structured output.
 *
 * Every call supplies a JSON Schema (`responseJsonSchema`) so the model can only
 * answer in the expected shape, and the reply is parsed again with zod. Models
 * are tried in the configured order: when one is overloaded or out of quota the
 * next is used, so a busy model does not fail a user's job.
 */

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_MODELS = ["gemini-flash-latest", "gemini-2.5-flash", "gemini-flash-lite-latest"];

export interface GeminiRequest<T> {
  label: string;
  system: string;
  user: string;
  jsonSchema: Record<string, unknown>;
  parse: z.ZodType<T>;
  temperature?: number;
  timeoutMs?: number;
}

export interface GeminiResult<T> {
  data: T;
  model: string;
  tokens: number;
}

interface GenerateResponse {
  candidates?: { finishReason?: string; content?: { parts?: { text?: string; thought?: boolean }[] } }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { totalTokenCount?: number };
  error?: { code?: number; message?: string; status?: string };
}

export function geminiModels(env: Env): string[] {
  const list = (env.GEMINI_MODELS ?? "")
    .split(",")
    .map((m) => m.trim())
    .filter((m) => /^[a-z0-9.-]+$/i.test(m));
  return list.length ? list : DEFAULT_MODELS;
}

const COOLDOWN_MS = 10 * 60_000;
const cooling = new Map<string, number>();

/**
 * A model that just timed out or reported overload is skipped for a few minutes,
 * so one slow model does not add its full timeout to every call. The cooldown is
 * shared across isolates through D1.
 */
async function coolingModels(env: Env): Promise<Set<string>> {
  const t = now();
  try {
    const { results } = await env.DB.prepare("SELECT key, expires_at FROM kv_cache WHERE key LIKE 'gemini:cooldown:%' AND expires_at > ?").bind(t).all<{ key: string; expires_at: number }>();
    for (const row of results) cooling.set(row.key.slice("gemini:cooldown:".length), row.expires_at);
  } catch {
    /* the in-memory view is enough */
  }
  return new Set([...cooling].filter(([, until]) => until > t).map(([model]) => model));
}

async function coolDown(env: Env, model: string): Promise<void> {
  const until = now() + COOLDOWN_MS;
  cooling.set(model, until);
  try {
    await env.DB.prepare("INSERT INTO kv_cache (key, value, expires_at) VALUES (?, '1', ?) ON CONFLICT (key) DO UPDATE SET expires_at = excluded.expires_at")
      .bind(`gemini:cooldown:${model}`, until)
      .run();
  } catch {
    /* best effort */
  }
}

function extractJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "");
  return JSON.parse(trimmed);
}

export async function geminiJson<T>(env: Env, req: GeminiRequest<T>): Promise<GeminiResult<T>> {
  if (!env.GEMINI_API_KEY) {
    throw new PipelineError("gemini_unavailable", "The Gemini API key is not configured (GEMINI_API_KEY secret is missing).", false);
  }
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: req.system }] },
    contents: [{ role: "user", parts: [{ text: req.user }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseJsonSchema: req.jsonSchema,
      temperature: req.temperature ?? 0.7,
      maxOutputTokens: 32768,
    },
  });

  let unavailable = 0;
  let lastInvalid = "";
  let lastError = "";
  // Healthy models first; models in cooldown are only tried if every healthy one fails.
  const down = await coolingModels(env);
  const configured = geminiModels(env);
  const order = [...configured.filter((m) => !down.has(m)), ...configured.filter((m) => down.has(m))];
  for (const model of order) {
    let res: Response;
    try {
      res = await fetchWithTimeout(`${ENDPOINT}/${model}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
        body,
        timeoutMs: req.timeoutMs ?? 70_000,
      });
    } catch (error) {
      unavailable++;
      lastError = `${model}: ${error instanceof Error ? error.name : "network error"}`;
      log("gemini_attempt_failed", { label: req.label, model, reason: lastError });
      await coolDown(env, model);
      continue;
    }
    let json: GenerateResponse;
    try {
      json = (await res.json()) as GenerateResponse;
    } catch {
      unavailable++;
      lastError = `${model}: unreadable response (${res.status})`;
      continue;
    }
    if (!res.ok || json.error) {
      const status = json.error?.code ?? res.status;
      lastError = `${model}: ${status} ${json.error?.status ?? ""}`.trim();
      log("gemini_attempt_failed", { label: req.label, model, status, reason: json.error?.status });
      if (status === 401 || status === 403) {
        throw new PipelineError("gemini_unavailable", "Gemini rejected the configured API key. Check the GEMINI_API_KEY secret.", false);
      }
      unavailable++; // 429 quota, 5xx overload, or a model that does not support this request: try the next model
      if (status === 429 || status >= 500) await coolDown(env, model);
      continue;
    }
    if (json.promptFeedback?.blockReason) {
      throw new PipelineError("prompt_rejected", "Gemini declined this prompt for safety reasons. Try describing the scene differently.", false);
    }
    const candidate = json.candidates?.[0];
    const text = (candidate?.content?.parts ?? [])
      .filter((p) => !p.thought)
      .map((p) => p.text ?? "")
      .join("");
    if (candidate?.finishReason === "SAFETY" || candidate?.finishReason === "PROHIBITED_CONTENT") {
      throw new PipelineError("prompt_rejected", "Gemini declined this prompt for safety reasons. Try describing the scene differently.", false);
    }
    if (!text) {
      lastInvalid = `${model}: empty reply (${candidate?.finishReason ?? "no candidate"})`;
      continue;
    }
    let raw: unknown;
    try {
      raw = extractJson(text);
    } catch {
      lastInvalid = `${model}: reply was not valid JSON (${candidate?.finishReason ?? "?"})`;
      log("gemini_invalid_json", { label: req.label, model, finish: candidate?.finishReason });
      continue;
    }
    const parsed = req.parse.safeParse(raw);
    if (!parsed.success) {
      lastInvalid = `${model}: ${parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`;
      log("gemini_invalid_shape", { label: req.label, model, issues: lastInvalid });
      continue;
    }
    return { data: parsed.data, model, tokens: json.usageMetadata?.totalTokenCount ?? 0 };
  }
  if (lastInvalid) {
    throw new PipelineError("gemini_invalid_output", `The AI director's reply failed validation (${lastInvalid}).`, true);
  }
  throw new PipelineError("gemini_unavailable", `No Gemini model is available right now (${unavailable} tried; last: ${lastError}).`, true);
}
