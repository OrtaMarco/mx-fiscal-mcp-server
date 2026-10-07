/**
 * Several invoices against the SAT's status service, politely: two requests in
 * flight at most, duplicates asked once, answers remembered for a few minutes,
 * and a stop after two consecutive outages instead of hammering a service that
 * publishes no SLA and asks callers not to raise their query volume.
 */

import { buildExpression, queryCfdiStatus } from "./sat.js";
import type { SatStatusResult } from "./sat.js";
import { resolveStatusQuery } from "./status-query.js";
import type { StatusInput, StatusQuery } from "./status-query.js";

export const BATCH_MAX_ITEMS = 25;
export const BATCH_CONCURRENCY = 2;
/** Consecutive 'SAT unreachable' answers after which the rest are not attempted. */
export const BATCH_OUTAGE_STOP = 2;
export const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX_ENTRIES = 500;

interface CacheEntry {
  at: number;
  result: SatStatusResult;
}
const cache = new Map<string, CacheEntry>();

export function clearStatusCache(): void {
  cache.clear();
}

function remember(key: string, result: SatStatusResult): void {
  // Only a real answer is worth keeping: an outage must be retried next time.
  if (!result.available) return;
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { at: Date.now(), result });
}

export interface BatchItemResult {
  index: number;
  /** `queried`: asked the SAT. `cached`: answered from memory. `duplicate`: same invoice as an earlier item. `rejected`: never sent. `skipped`: not attempted after repeated outages. */
  outcome: "queried" | "cached" | "duplicate" | "rejected" | "skipped";
  source: "fields" | "xml" | null;
  error: string | null;
  uuid: string | null;
  result: SatStatusResult | null;
}

export interface BatchStatus {
  total: number;
  queried: number;
  cached: number;
  duplicates: number;
  rejected: number;
  skipped: number;
  unavailable: number;
  stopped_after_outage: boolean;
  items: BatchItemResult[];
}

export async function batchCfdiStatus(inputs: StatusInput[]): Promise<BatchStatus> {
  const items: BatchItemResult[] = inputs.map((_, index) => ({
    index,
    outcome: "rejected",
    source: null,
    error: null,
    uuid: null,
    result: null,
  }));

  // 1. Resolve every item and group the ones that name the same invoice.
  const firstByKey = new Map<string, number>();
  const toAsk: { index: number; key: string; query: StatusQuery }[] = [];
  const followers: { index: number; leader: number }[] = [];

  inputs.forEach((input, index) => {
    const resolved = resolveStatusQuery(input);
    if (!resolved.ok) {
      items[index]!.error = resolved.message;
      return;
    }
    const item = items[index]!;
    item.source = resolved.source;
    item.uuid = resolved.query.uuid.trim().toUpperCase();
    const key = buildExpression(resolved.query);
    const leader = firstByKey.get(key);
    if (leader !== undefined) {
      followers.push({ index, leader });
      return;
    }
    firstByKey.set(key, index);
    toAsk.push({ index, key, query: resolved.query });
  });

  // 2. Cached answers cost nothing; the rest go to the SAT, two at a time.
  const pending: typeof toAsk = [];
  const now = Date.now();
  for (const job of toAsk) {
    const hit = cache.get(job.key);
    if (hit && now - hit.at < CACHE_TTL_MS) {
      items[job.index]!.outcome = "cached";
      items[job.index]!.result = hit.result;
    } else {
      pending.push(job);
    }
  }

  let outages = 0;
  let stopped = false;
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < pending.length) {
      if (outages >= BATCH_OUTAGE_STOP) {
        stopped = true;
        return;
      }
      const job = pending[next++]!;
      const result = await queryCfdiStatus(job.query);
      const item = items[job.index]!;
      item.outcome = "queried";
      item.result = result;
      if (result.available) {
        outages = 0;
        remember(job.key, result);
      } else {
        outages++;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(BATCH_CONCURRENCY, pending.length) }, worker));

  for (const job of pending) {
    const item = items[job.index]!;
    if (item.result === null) {
      item.outcome = "skipped";
      item.error = "Not sent: the SAT service failed on the previous queries of this batch. Try again later; this says nothing about the invoice.";
    }
  }

  // 3. Duplicates share their leader's answer.
  for (const { index, leader } of followers) {
    const item = items[index]!;
    const lead = items[leader]!;
    item.outcome = "duplicate";
    item.result = lead.result;
    item.error = lead.error;
  }

  return {
    total: items.length,
    queried: items.filter((i) => i.outcome === "queried").length,
    cached: items.filter((i) => i.outcome === "cached").length,
    duplicates: items.filter((i) => i.outcome === "duplicate").length,
    rejected: items.filter((i) => i.outcome === "rejected").length,
    skipped: items.filter((i) => i.outcome === "skipped").length,
    unavailable: items.filter((i) => i.result !== null && !i.result.available && i.outcome === "queried").length,
    stopped_after_outage: stopped,
    items,
  };
}
